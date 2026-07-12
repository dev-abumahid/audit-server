import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../app/lib/prisma.js', () => ({
  prisma: {
    orgMember: {
      findUnique: vi.fn(),
    },
    organization: {
      findUnique: vi.fn(),
    },
    inspectionAssignment: {
      findMany: vi.fn(),
    },
  },
}));

import { prisma } from '../../app/lib/prisma.js';
import {
  applyActionScope,
  applyInspectionScope,
  resolveCallerOrgContext,
} from '../../app/utils/org_scope.js';

const orgMemberDb = prisma.orgMember as unknown as Record<string, ReturnType<typeof vi.fn>>;
const organizationDb = prisma.organization as unknown as Record<string, ReturnType<typeof vi.fn>>;
const assignmentDb = prisma.inspectionAssignment as unknown as Record<
  string,
  ReturnType<typeof vi.fn>
>;

const ACCOUNT = 'account-1';
const ANCHOR = 'anchor-account-1';
const ORG_ID = 'org-1';
const MEMBER_ID = 'member-1';

describe('org_scope — resolveCallerOrgContext', () => {
  beforeEach(() => vi.clearAllMocks());

  it('falls back to ADMIN-of-self when there is no OrgMember row', async () => {
    orgMemberDb.findUnique.mockResolvedValue(null);

    const ctx = await resolveCallerOrgContext(ACCOUNT);

    expect(ctx).toEqual({ organizationId: ACCOUNT, role: 'ADMIN', orgMemberId: null });
    expect(organizationDb.findUnique).not.toHaveBeenCalled();
  });

  it('falls back to ADMIN-of-self when the OrgMember row points at a missing Organization', async () => {
    orgMemberDb.findUnique.mockResolvedValue({
      id: MEMBER_ID,
      organizationId: ORG_ID,
      accountId: ACCOUNT,
      role: 'ADMIN',
    });
    organizationDb.findUnique.mockResolvedValue(null);

    const ctx = await resolveCallerOrgContext(ACCOUNT);

    expect(ctx).toEqual({ organizationId: ACCOUNT, role: 'ADMIN', orgMemberId: null });
  });

  it('resolves organizationId to the org anchorAccountId, not the caller accountId', async () => {
    orgMemberDb.findUnique.mockResolvedValue({
      id: MEMBER_ID,
      organizationId: ORG_ID,
      accountId: ACCOUNT,
      role: 'LEAD_AUDITOR',
    });
    organizationDb.findUnique.mockResolvedValue({ id: ORG_ID, anchorAccountId: ANCHOR });

    const ctx = await resolveCallerOrgContext(ACCOUNT);

    expect(ctx).toEqual({ organizationId: ANCHOR, role: 'LEAD_AUDITOR', orgMemberId: MEMBER_ID });
  });
});

describe('org_scope — applyInspectionScope', () => {
  beforeEach(() => vi.clearAllMocks());

  it('ADMIN: where-clause is unchanged', async () => {
    const where = { orgAccountId: ANCHOR };
    const result = await applyInspectionScope(where, {
      organizationId: ANCHOR,
      role: 'ADMIN',
      orgMemberId: null,
    });
    expect(result).toBe(where);
    expect(assignmentDb.findMany).not.toHaveBeenCalled();
  });

  it('LEAD_AUDITOR: adds an id-in-assigned-set filter', async () => {
    assignmentDb.findMany.mockResolvedValue([{ inspectionId: 'i1' }, { inspectionId: 'i2' }]);

    const result = await applyInspectionScope(
      { orgAccountId: ANCHOR },
      { organizationId: ANCHOR, role: 'LEAD_AUDITOR', orgMemberId: MEMBER_ID },
    );

    expect(result).toEqual({ orgAccountId: ANCHOR, id: { in: ['i1', 'i2'] } });
  });

  it('LEAD_AUDITOR: intersects with an existing single-id filter', async () => {
    assignmentDb.findMany.mockResolvedValue([{ inspectionId: 'i1' }]);

    const notAssigned = await applyInspectionScope(
      { id: 'i2' },
      { organizationId: ANCHOR, role: 'LEAD_AUDITOR', orgMemberId: MEMBER_ID },
    );
    expect(notAssigned.id).toEqual({ in: [] });

    const assigned = await applyInspectionScope(
      { id: 'i1' },
      { organizationId: ANCHOR, role: 'LEAD_AUDITOR', orgMemberId: MEMBER_ID },
    );
    expect(assigned.id).toBe('i1');
  });

  it('VIEWER with zero assignments: where-clause is unchanged (org-wide)', async () => {
    assignmentDb.findMany.mockResolvedValue([]);

    const where = { orgAccountId: ANCHOR };
    const result = await applyInspectionScope(where, {
      organizationId: ANCHOR,
      role: 'VIEWER',
      orgMemberId: MEMBER_ID,
    });

    expect(result).toEqual(where);
  });

  it('VIEWER with assignments: scoped the same as Lead Auditor', async () => {
    assignmentDb.findMany.mockResolvedValue([{ inspectionId: 'i1' }]);

    const result = await applyInspectionScope(
      { orgAccountId: ANCHOR },
      { organizationId: ANCHOR, role: 'VIEWER', orgMemberId: MEMBER_ID },
    );

    expect(result).toEqual({ orgAccountId: ANCHOR, id: { in: ['i1'] } });
  });

  it('LIGHT_USER: denied by default (empty id set)', async () => {
    const result = await applyInspectionScope(
      { orgAccountId: ANCHOR },
      { organizationId: ANCHOR, role: 'LIGHT_USER', orgMemberId: MEMBER_ID },
    );

    expect(result).toEqual({ orgAccountId: ANCHOR, id: { in: [] } });
    expect(assignmentDb.findMany).not.toHaveBeenCalled();
  });
});

describe('org_scope — applyActionScope', () => {
  beforeEach(() => vi.clearAllMocks());

  it('ADMIN: where-clause is unchanged', async () => {
    const where = { orgAccountId: ANCHOR };
    const result = await applyActionScope(where, {
      organizationId: ANCHOR,
      role: 'ADMIN',
      orgMemberId: null,
    });
    expect(result).toBe(where);
  });

  it('LEAD_AUDITOR: adds an inspectionId-in-assigned-set filter', async () => {
    assignmentDb.findMany.mockResolvedValue([{ inspectionId: 'i1' }]);

    const result = await applyActionScope(
      { orgAccountId: ANCHOR },
      { organizationId: ANCHOR, role: 'LEAD_AUDITOR', orgMemberId: MEMBER_ID },
    );

    expect(result).toEqual({ orgAccountId: ANCHOR, inspectionId: { in: ['i1'] } });
  });

  it('VIEWER with zero assignments: org-wide', async () => {
    assignmentDb.findMany.mockResolvedValue([]);

    const where = { orgAccountId: ANCHOR };
    const result = await applyActionScope(where, {
      organizationId: ANCHOR,
      role: 'VIEWER',
      orgMemberId: MEMBER_ID,
    });

    expect(result).toEqual(where);
  });

  it('LIGHT_USER: denied by default', async () => {
    const result = await applyActionScope(
      { orgAccountId: ANCHOR },
      { organizationId: ANCHOR, role: 'LIGHT_USER', orgMemberId: MEMBER_ID },
    );

    expect(result).toEqual({ orgAccountId: ANCHOR, inspectionId: { in: [] } });
  });
});
