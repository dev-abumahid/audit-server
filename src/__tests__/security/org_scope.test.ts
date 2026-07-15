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
      count: vi.fn(),
    },
    findingAssignment: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
    },
    externalOrgMember: {
      findUnique: vi.fn(),
    },
  },
}));

import { prisma } from '../../app/lib/prisma.js';
import {
  applyActionScope,
  applyInspectionScope,
  assertCanWriteToAction,
  assertCanWriteToActionForExternalMember,
  hasActiveFindingAssignmentForExternalMember,
  isExternalMembershipActive,
  resolveAccountOrgAnchor,
  resolveCallerOrgContext,
  resolveExternalCallerContext,
} from '../../app/utils/org_scope.js';

const orgMemberDb = prisma.orgMember as unknown as Record<string, ReturnType<typeof vi.fn>>;
const organizationDb = prisma.organization as unknown as Record<string, ReturnType<typeof vi.fn>>;
const assignmentDb = prisma.inspectionAssignment as unknown as Record<
  string,
  ReturnType<typeof vi.fn>
>;
const findingAssignmentDb = prisma.findingAssignment as unknown as Record<
  string,
  ReturnType<typeof vi.fn>
>;
const externalOrgMemberDb = prisma.externalOrgMember as unknown as Record<
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

  it('fails closed (403) when a real OrgMember row points at a missing Organization, even for ADMIN', async () => {
    // Was previously an ADMIN-of-self fallback — changed after independent
    // review: falling back here (rather than the "no membership row at
    // all" case above) would silently upgrade a non-ADMIN role to full
    // ADMIN for this same defensive branch, a privilege escalation. Denying
    // outright regardless of role is the safe default for a "should never
    // happen" data-integrity case.
    orgMemberDb.findUnique.mockResolvedValue({
      id: MEMBER_ID,
      organizationId: ORG_ID,
      accountId: ACCOUNT,
      role: 'ADMIN',
      status: 'ACTIVE',
      expiresAt: null,
    });
    organizationDb.findUnique.mockResolvedValue(null);

    await expect(resolveCallerOrgContext(ACCOUNT)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('fails closed (403) for a non-ADMIN role too, not just ADMIN', async () => {
    orgMemberDb.findUnique.mockResolvedValue({
      id: MEMBER_ID,
      organizationId: ORG_ID,
      accountId: ACCOUNT,
      role: 'VIEWER',
      status: 'ACTIVE',
      expiresAt: null,
    });
    organizationDb.findUnique.mockResolvedValue(null);

    await expect(resolveCallerOrgContext(ACCOUNT)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('resolves organizationId to the org anchorAccountId, not the caller accountId', async () => {
    orgMemberDb.findUnique.mockResolvedValue({
      id: MEMBER_ID,
      organizationId: ORG_ID,
      accountId: ACCOUNT,
      role: 'LEAD_AUDITOR',
      status: 'ACTIVE',
      expiresAt: null,
    });
    organizationDb.findUnique.mockResolvedValue({ id: ORG_ID, anchorAccountId: ANCHOR });

    const ctx = await resolveCallerOrgContext(ACCOUNT);

    expect(ctx).toEqual({ organizationId: ANCHOR, role: 'LEAD_AUDITOR', orgMemberId: MEMBER_ID });
  });

  it('rejects a SUSPENDED member even though their JWT is still valid', async () => {
    orgMemberDb.findUnique.mockResolvedValue({
      id: MEMBER_ID,
      organizationId: ORG_ID,
      accountId: ACCOUNT,
      role: 'ADMIN',
      status: 'SUSPENDED',
      expiresAt: null,
    });

    await expect(resolveCallerOrgContext(ACCOUNT)).rejects.toMatchObject({ statusCode: 403 });
    expect(organizationDb.findUnique).not.toHaveBeenCalled();
  });

  it('rejects a member whose time-boxed access has expired', async () => {
    orgMemberDb.findUnique.mockResolvedValue({
      id: MEMBER_ID,
      organizationId: ORG_ID,
      accountId: ACCOUNT,
      role: 'VIEWER',
      status: 'ACTIVE',
      expiresAt: new Date(Date.now() - 1000 * 60 * 60),
    });

    await expect(resolveCallerOrgContext(ACCOUNT)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('allows a member whose expiresAt is in the future', async () => {
    orgMemberDb.findUnique.mockResolvedValue({
      id: MEMBER_ID,
      organizationId: ORG_ID,
      accountId: ACCOUNT,
      role: 'VIEWER',
      status: 'ACTIVE',
      expiresAt: new Date(Date.now() + 1000 * 60 * 60),
    });
    organizationDb.findUnique.mockResolvedValue({ id: ORG_ID, anchorAccountId: ANCHOR });

    const ctx = await resolveCallerOrgContext(ACCOUNT);

    expect(ctx.role).toBe('VIEWER');
  });
});

describe('org_scope — resolveAccountOrgAnchor (issue #58 follow-up)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('resolves to ADMIN-of-self (own accountId, isActive: true) when there is no OrgMember row', async () => {
    orgMemberDb.findUnique.mockResolvedValue(null);

    const result = await resolveAccountOrgAnchor(ACCOUNT);

    expect(result).toEqual({ organizationId: ACCOUNT, isActive: true });
  });

  it('resolves to the org anchor and isActive: true for a real, ACTIVE membership', async () => {
    orgMemberDb.findUnique.mockResolvedValue({
      id: MEMBER_ID,
      organizationId: ORG_ID,
      accountId: ACCOUNT,
      role: 'LIGHT_USER',
      status: 'ACTIVE',
      expiresAt: null,
    });
    organizationDb.findUnique.mockResolvedValue({ id: ORG_ID, anchorAccountId: ANCHOR });

    const result = await resolveAccountOrgAnchor(ACCOUNT);

    expect(result).toEqual({ organizationId: ANCHOR, isActive: true });
  });

  it('resolves to the org anchor but isActive: false for a SUSPENDED membership — does NOT throw', async () => {
    orgMemberDb.findUnique.mockResolvedValue({
      id: MEMBER_ID,
      organizationId: ORG_ID,
      accountId: ACCOUNT,
      role: 'LIGHT_USER',
      status: 'SUSPENDED',
      expiresAt: null,
    });
    organizationDb.findUnique.mockResolvedValue({ id: ORG_ID, anchorAccountId: ANCHOR });

    const result = await resolveAccountOrgAnchor(ACCOUNT);

    expect(result).toEqual({ organizationId: ANCHOR, isActive: false });
  });

  it('resolves to the org anchor but isActive: false for an expired membership — does NOT throw', async () => {
    orgMemberDb.findUnique.mockResolvedValue({
      id: MEMBER_ID,
      organizationId: ORG_ID,
      accountId: ACCOUNT,
      role: 'LIGHT_USER',
      status: 'ACTIVE',
      expiresAt: new Date(Date.now() - 1000 * 60 * 60),
    });
    organizationDb.findUnique.mockResolvedValue({ id: ORG_ID, anchorAccountId: ANCHOR });

    const result = await resolveAccountOrgAnchor(ACCOUNT);

    expect(result).toEqual({ organizationId: ANCHOR, isActive: false });
  });

  it('fails closed (isActive: false, a non-matching organizationId) when the Organization row is missing', async () => {
    orgMemberDb.findUnique.mockResolvedValue({
      id: MEMBER_ID,
      organizationId: ORG_ID,
      accountId: ACCOUNT,
      role: 'ADMIN',
      status: 'ACTIVE',
      expiresAt: null,
    });
    organizationDb.findUnique.mockResolvedValue(null);

    const result = await resolveAccountOrgAnchor(ACCOUNT);

    expect(result.isActive).toBe(false);
    expect(result.organizationId).not.toBe(ANCHOR);
    expect(result.organizationId).not.toBe(ACCOUNT);
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

  it('VIEWER never assigned anything: where-clause is unchanged (org-wide)', async () => {
    assignmentDb.findMany.mockResolvedValue([]);

    const where = { orgAccountId: ANCHOR };
    const result = await applyInspectionScope(where, {
      organizationId: ANCHOR,
      role: 'VIEWER',
      orgMemberId: MEMBER_ID,
    });

    expect(result).toEqual(where);
  });

  it('VIEWER whose assignments were all later revoked: scoped to nothing, NOT org-wide (issue #55 follow-up)', async () => {
    // Zero *active* rows (revokedAt is set on every row), but at least one
    // row ever existed — an admin revoked every assignment this Viewer had,
    // intending to cut off their access. Falling back to org-wide here would
    // silently undo that.
    assignmentDb.findMany.mockResolvedValue([{ inspectionId: 'i1', revokedAt: new Date() }]);

    const result = await applyInspectionScope(
      { orgAccountId: ANCHOR },
      { organizationId: ANCHOR, role: 'VIEWER', orgMemberId: MEMBER_ID },
    );

    expect(result).toEqual({ orgAccountId: ANCHOR, id: { in: [] } });
  });

  it('VIEWER with assignments: scoped the same as Lead Auditor', async () => {
    assignmentDb.findMany.mockResolvedValue([{ inspectionId: 'i1', revokedAt: null }]);

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

  it('VIEWER never assigned anything: org-wide', async () => {
    assignmentDb.findMany.mockResolvedValue([]);

    const where = { orgAccountId: ANCHOR };
    const result = await applyActionScope(where, {
      organizationId: ANCHOR,
      role: 'VIEWER',
      orgMemberId: MEMBER_ID,
    });

    expect(result).toEqual(where);
  });

  it('VIEWER whose assignments were all later revoked: scoped to nothing, NOT org-wide (issue #55 follow-up)', async () => {
    assignmentDb.findMany.mockResolvedValue([{ inspectionId: 'i1', revokedAt: new Date() }]);

    const result = await applyActionScope(
      { orgAccountId: ANCHOR },
      { organizationId: ANCHOR, role: 'VIEWER', orgMemberId: MEMBER_ID },
    );

    expect(result).toEqual({ orgAccountId: ANCHOR, inspectionId: { in: [] } });
  });

  it('LIGHT_USER with no live FindingAssignment: denied (empty id set)', async () => {
    findingAssignmentDb.findMany.mockResolvedValue([]);

    const result = await applyActionScope(
      { orgAccountId: ANCHOR },
      { organizationId: ANCHOR, role: 'LIGHT_USER', orgMemberId: MEMBER_ID },
    );

    expect(result).toEqual({ orgAccountId: ANCHOR, id: { in: [] } });
    expect(assignmentDb.findMany).not.toHaveBeenCalled();
  });

  it('LIGHT_USER: scoped by id (not inspectionId) to their sub-assigned findings (issue #55 slice 4)', async () => {
    findingAssignmentDb.findMany.mockResolvedValue([{ actionId: 'action-1' }]);

    const result = await applyActionScope(
      { orgAccountId: ANCHOR },
      { organizationId: ANCHOR, role: 'LIGHT_USER', orgMemberId: MEMBER_ID },
    );

    expect(result).toEqual({ orgAccountId: ANCHOR, id: { in: ['action-1'] } });
    expect(findingAssignmentDb.findMany).toHaveBeenCalledWith({
      where: { orgMemberId: MEMBER_ID, status: 'ACTIVE', revokedAt: null },
      select: { actionId: true },
    });
  });

  it('LIGHT_USER: a PENDING_APPROVAL assignment grants no access; only ACTIVE does, end to end', async () => {
    // Simulates real DB filtering (not a hand-picked return value) against a
    // small fixture containing both a still-pending and an approved row for
    // the same member, so this actually exercises the status filter rather
    // than just asserting the query shape.
    const rows = [
      {
        actionId: 'action-pending',
        orgMemberId: MEMBER_ID,
        status: 'PENDING_APPROVAL',
        revokedAt: null,
      },
      { actionId: 'action-active', orgMemberId: MEMBER_ID, status: 'ACTIVE', revokedAt: null },
    ];
    findingAssignmentDb.findMany.mockImplementation(
      ({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(
          rows
            .filter(
              (row) =>
                row.orgMemberId === where.orgMemberId &&
                row.status === where.status &&
                row.revokedAt === where.revokedAt,
            )
            .map((row) => ({ actionId: row.actionId })),
        ),
    );

    const result = await applyActionScope(
      { orgAccountId: ANCHOR },
      { organizationId: ANCHOR, role: 'LIGHT_USER', orgMemberId: MEMBER_ID },
    );

    // Only the ACTIVE row's action is in scope — the PENDING_APPROVAL one
    // (not yet signed off by an Admin) grants nothing.
    expect(result).toEqual({ orgAccountId: ANCHOR, id: { in: ['action-active'] } });
  });
});

describe('org_scope — assertCanWriteToAction (issue #55 slice 4)', () => {
  beforeEach(() => vi.clearAllMocks());

  const ACTION = { id: 'action-1', inspectionId: 'insp-1' };

  it('ADMIN: always allowed', async () => {
    await expect(
      assertCanWriteToAction({ organizationId: ANCHOR, role: 'ADMIN', orgMemberId: null }, ACTION),
    ).resolves.toBeUndefined();
  });

  it('LEAD_AUDITOR assigned to the parent inspection: allowed', async () => {
    assignmentDb.findMany.mockResolvedValue([{ inspectionId: 'insp-1' }]);

    await expect(
      assertCanWriteToAction(
        { organizationId: ANCHOR, role: 'LEAD_AUDITOR', orgMemberId: MEMBER_ID },
        ACTION,
      ),
    ).resolves.toBeUndefined();
  });

  it('LEAD_AUDITOR NOT assigned to the parent inspection: denied', async () => {
    assignmentDb.findMany.mockResolvedValue([{ inspectionId: 'insp-other' }]);

    await expect(
      assertCanWriteToAction(
        { organizationId: ANCHOR, role: 'LEAD_AUDITOR', orgMemberId: MEMBER_ID },
        ACTION,
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('LIGHT_USER with an ACTIVE FindingAssignment for this exact action: allowed', async () => {
    findingAssignmentDb.findFirst.mockResolvedValue({ id: 'fa-1' });

    await expect(
      assertCanWriteToAction(
        { organizationId: ANCHOR, role: 'LIGHT_USER', orgMemberId: MEMBER_ID },
        ACTION,
      ),
    ).resolves.toBeUndefined();

    expect(findingAssignmentDb.findFirst).toHaveBeenCalledWith({
      where: { orgMemberId: MEMBER_ID, actionId: ACTION.id, status: 'ACTIVE', revokedAt: null },
      select: { id: true },
    });
  });

  it('LIGHT_USER assigned to a DIFFERENT action: denied', async () => {
    findingAssignmentDb.findFirst.mockResolvedValue(null);

    await expect(
      assertCanWriteToAction(
        { organizationId: ANCHOR, role: 'LIGHT_USER', orgMemberId: MEMBER_ID },
        ACTION,
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('VIEWER: never allowed', async () => {
    await expect(
      assertCanWriteToAction(
        { organizationId: ANCHOR, role: 'VIEWER', orgMemberId: MEMBER_ID },
        ACTION,
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('org_scope — external member helpers (issue #55 slice 5)', () => {
  beforeEach(() => vi.clearAllMocks());

  const ACTIVE_EXTERNAL_MEMBER = {
    id: 'ext-1',
    organizationId: 'org-1',
    email: 'external@test.com',
    fullName: null,
    role: 'LIGHT_USER',
    isActive: true,
    expiresAt: null,
  };

  describe('isExternalMembershipActive', () => {
    it('is true for an active, non-expired member', () => {
      expect(isExternalMembershipActive({ isActive: true, expiresAt: null })).toBe(true);
    });

    it('is false when isActive is false', () => {
      expect(isExternalMembershipActive({ isActive: false, expiresAt: null })).toBe(false);
    });

    it('is false when expiresAt is in the past', () => {
      expect(
        isExternalMembershipActive({ isActive: true, expiresAt: new Date(Date.now() - 1000) }),
      ).toBe(false);
    });

    it('is true when expiresAt is in the future', () => {
      expect(
        isExternalMembershipActive({ isActive: true, expiresAt: new Date(Date.now() + 100000) }),
      ).toBe(true);
    });
  });

  describe('resolveExternalCallerContext', () => {
    it('throws 401 when the member does not exist', async () => {
      externalOrgMemberDb.findUnique.mockResolvedValue(null);

      await expect(resolveExternalCallerContext('ext-1')).rejects.toMatchObject({
        statusCode: 401,
      });
    });

    it('throws 401 when the member is deactivated', async () => {
      externalOrgMemberDb.findUnique.mockResolvedValue({
        ...ACTIVE_EXTERNAL_MEMBER,
        isActive: false,
      });

      await expect(resolveExternalCallerContext('ext-1')).rejects.toMatchObject({
        statusCode: 401,
      });
    });

    it('throws 403 when the member role is VIEWER (not yet supported)', async () => {
      externalOrgMemberDb.findUnique.mockResolvedValue({
        ...ACTIVE_EXTERNAL_MEMBER,
        role: 'VIEWER',
      });

      await expect(resolveExternalCallerContext('ext-1')).rejects.toMatchObject({
        statusCode: 403,
      });
    });

    it('throws 401 when the organization cannot be found (defensive)', async () => {
      externalOrgMemberDb.findUnique.mockResolvedValue({
        ...ACTIVE_EXTERNAL_MEMBER,
        organization: null,
      });

      await expect(resolveExternalCallerContext('ext-1')).rejects.toMatchObject({
        statusCode: 401,
      });
    });

    it('returns the anchor account id as organizationId and the real Organization.id as orgId', async () => {
      externalOrgMemberDb.findUnique.mockResolvedValue({
        ...ACTIVE_EXTERNAL_MEMBER,
        organization: { id: 'org-1', anchorAccountId: 'anchor-1' },
      });

      const ctx = await resolveExternalCallerContext('ext-1');

      expect(ctx).toEqual({
        externalOrgMemberId: 'ext-1',
        organizationId: 'anchor-1',
        orgId: 'org-1',
        role: 'LIGHT_USER',
      });
    });
  });

  describe('hasActiveFindingAssignmentForExternalMember', () => {
    it('returns true when a live FindingAssignment exists', async () => {
      findingAssignmentDb.findFirst.mockResolvedValue({ id: 'fa-1' });

      const result = await hasActiveFindingAssignmentForExternalMember('ext-1', 'action-1');

      expect(findingAssignmentDb.findFirst).toHaveBeenCalledWith({
        where: {
          externalOrgMemberId: 'ext-1',
          actionId: 'action-1',
          status: 'ACTIVE',
          revokedAt: null,
        },
        select: { id: true },
      });
      expect(result).toBe(true);
    });

    it('returns false when no live FindingAssignment exists', async () => {
      findingAssignmentDb.findFirst.mockResolvedValue(null);

      const result = await hasActiveFindingAssignmentForExternalMember('ext-1', 'action-1');

      expect(result).toBe(false);
    });
  });

  describe('assertCanWriteToActionForExternalMember', () => {
    it('allows when a live FindingAssignment exists', async () => {
      findingAssignmentDb.findFirst.mockResolvedValue({ id: 'fa-1' });

      await expect(
        assertCanWriteToActionForExternalMember('ext-1', { id: 'action-1' }),
      ).resolves.toBeUndefined();
    });

    it('denies when no live FindingAssignment exists', async () => {
      findingAssignmentDb.findFirst.mockResolvedValue(null);

      await expect(
        assertCanWriteToActionForExternalMember('ext-1', { id: 'action-1' }),
      ).rejects.toMatchObject({ statusCode: 403 });
    });
  });
});
