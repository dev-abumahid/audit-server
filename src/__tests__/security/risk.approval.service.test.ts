import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ORG_A, makeReq } from '../helpers/makeReq.js';

vi.mock('../../app/lib/prisma.js', () => ({
  prisma: {
    risk: {
      findFirst: vi.fn(),
    },
    riskApproval: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    orgMember: {
      findUnique: vi.fn(),
    },
    organization: {
      findUnique: vi.fn(),
    },
    orgAuditLog: {
      create: vi.fn(),
    },
  },
}));

import { prisma } from '../../app/lib/prisma.js';
import { risk_approval_service } from '../../app/modules/risk/risk.approval.service.js';

const riskDb = prisma.risk as unknown as Record<string, ReturnType<typeof vi.fn>>;
const approvalDb = prisma.riskApproval as unknown as Record<string, ReturnType<typeof vi.fn>>;
const orgMemberDb = prisma.orgMember as unknown as Record<string, ReturnType<typeof vi.fn>>;
const organizationDb = prisma.organization as unknown as Record<string, ReturnType<typeof vi.fn>>;
const auditDb = prisma.orgAuditLog as unknown as Record<string, ReturnType<typeof vi.fn>>;

const ANCHOR = ORG_A;
const ORG_ID = 'org-00000000-0000-0000-0000-000000000009';
const MEMBER_ID = 'org-member-00000000-0000-0000-0000-000000000009';

// resolveCallerOrgContext reads orgMember.findUnique (by accountId) +
// organization.findUnique; requireCallerOrganizationId reads orgMember
// .findUnique (by id) again. A single mockResolvedValue covers all three since
// the row shape satisfies each lookup.
const mockMembership = (role: 'ADMIN' | 'LEAD_AUDITOR' | 'LIGHT_USER' | 'VIEWER') => {
  orgMemberDb.findUnique.mockResolvedValue({
    id: MEMBER_ID,
    organizationId: ORG_ID,
    accountId: ORG_A,
    role,
    status: 'ACTIVE',
    expiresAt: null,
  });
  organizationDb.findUnique.mockResolvedValue({ id: ORG_ID, anchorAccountId: ANCHOR });
};

describe('risk approval service — maker-checker (aexa-frontend#95)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auditDb.create.mockResolvedValue({});
  });

  describe('submit_risk_for_approval', () => {
    it('LEAD_AUDITOR submits a risk with no live cycle, creating a PENDING_APPROVAL row + audit event', async () => {
      mockMembership('LEAD_AUDITOR');
      riskDb.findFirst.mockResolvedValue({ id: 'r1', org_account_id: ANCHOR });
      approvalDb.findFirst.mockResolvedValue(null);
      approvalDb.create.mockResolvedValue({ id: 'ra-1', status: 'PENDING_APPROVAL' });

      const result = await risk_approval_service.submit_risk_for_approval(
        makeReq({ params: { id: 'r1' } }),
      );

      expect(approvalDb.create).toHaveBeenCalledWith({
        data: { riskId: 'r1', submittedById: ORG_A, status: 'PENDING_APPROVAL' },
      });
      expect(result.status).toBe('PENDING_APPROVAL');
      expect(auditDb.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ action: 'RISK_SUBMITTED_FOR_APPROVAL' }),
        }),
      );
    });

    it('ADMIN may also submit (superset of Lead Auditor)', async () => {
      mockMembership('ADMIN');
      riskDb.findFirst.mockResolvedValue({ id: 'r1', org_account_id: ANCHOR });
      approvalDb.findFirst.mockResolvedValue(null);
      approvalDb.create.mockResolvedValue({ id: 'ra-1', status: 'PENDING_APPROVAL' });

      await risk_approval_service.submit_risk_for_approval(makeReq({ params: { id: 'r1' } }));

      expect(approvalDb.create).toHaveBeenCalled();
    });

    it('VIEWER cannot submit a risk for approval', async () => {
      mockMembership('VIEWER');

      await expect(
        risk_approval_service.submit_risk_for_approval(makeReq({ params: { id: 'r1' } })),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(riskDb.findFirst).not.toHaveBeenCalled();
      expect(approvalDb.create).not.toHaveBeenCalled();
    });

    it('LIGHT_USER cannot submit a risk for approval', async () => {
      mockMembership('LIGHT_USER');

      await expect(
        risk_approval_service.submit_risk_for_approval(makeReq({ params: { id: 'r1' } })),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(approvalDb.create).not.toHaveBeenCalled();
    });

    it('blocks (409) when a PENDING_APPROVAL cycle is already live', async () => {
      mockMembership('LEAD_AUDITOR');
      riskDb.findFirst.mockResolvedValue({ id: 'r1', org_account_id: ANCHOR });
      approvalDb.findFirst.mockResolvedValue({ id: 'ra-1', status: 'PENDING_APPROVAL' });

      await expect(
        risk_approval_service.submit_risk_for_approval(makeReq({ params: { id: 'r1' } })),
      ).rejects.toMatchObject({ statusCode: 409 });

      expect(approvalDb.create).not.toHaveBeenCalled();
    });

    it('blocks (409) when an APPROVED cycle is already live (must edit to resubmit)', async () => {
      mockMembership('LEAD_AUDITOR');
      riskDb.findFirst.mockResolvedValue({ id: 'r1', org_account_id: ANCHOR });
      approvalDb.findFirst.mockResolvedValue({ id: 'ra-1', status: 'APPROVED' });

      await expect(
        risk_approval_service.submit_risk_for_approval(makeReq({ params: { id: 'r1' } })),
      ).rejects.toMatchObject({ statusCode: 409 });

      expect(approvalDb.create).not.toHaveBeenCalled();
    });

    it('throws 404 for a risk belonging to another org', async () => {
      mockMembership('LEAD_AUDITOR');
      riskDb.findFirst.mockResolvedValue(null);

      await expect(
        risk_approval_service.submit_risk_for_approval(makeReq({ params: { id: 'org-b-risk' } })),
      ).rejects.toMatchObject({ statusCode: 404 });

      expect(approvalDb.create).not.toHaveBeenCalled();
    });

    it('resolves a P2002 create race to the winning row instead of a 500', async () => {
      mockMembership('LEAD_AUDITOR');
      riskDb.findFirst.mockResolvedValue({ id: 'r1', org_account_id: ANCHOR });
      // No live row at first check, then the concurrent winner appears.
      approvalDb.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'ra-winner', status: 'PENDING_APPROVAL' });
      approvalDb.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('unique', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );

      const result = await risk_approval_service.submit_risk_for_approval(
        makeReq({ params: { id: 'r1' } }),
      );

      expect(result.id).toBe('ra-winner');
    });

    // aexa-server#201: if the winning row vanishes from the live set between the
    // P2002 catch and the re-query (invalidated by a concurrent edit, or
    // rejected), the old code rethrew the raw P2002 as a 500. It must now
    // surface a clean, retryable 409 instead.
    it('returns a clean 409 (not 500) when the P2002 winner has already vanished from the live set', async () => {
      mockMembership('LEAD_AUDITOR');
      riskDb.findFirst.mockResolvedValue({ id: 'r1', org_account_id: ANCHOR });
      // No live row at the first check, and STILL none on the post-P2002
      // re-query — the winner was invalidated/rejected in the gap.
      approvalDb.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
      approvalDb.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('unique', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );

      await expect(
        risk_approval_service.submit_risk_for_approval(makeReq({ params: { id: 'r1' } })),
      ).rejects.toMatchObject({ statusCode: 409 });
    });
  });

  describe('approve_risk', () => {
    // A DIFFERENT admin from the submitter — the caller is ORG_A, so a pending
    // cycle submitted by SUBMITTER passes the maker-checker (#200) gate.
    const SUBMITTER = 'some-other-admin-accountId';

    it('ADMIN approves a PENDING_APPROVAL cycle -> APPROVED with decidedBy/decidedAt + audit', async () => {
      mockMembership('ADMIN');
      approvalDb.findFirst.mockResolvedValue({
        id: 'ra-1',
        riskId: 'r1',
        submittedById: SUBMITTER,
        status: 'PENDING_APPROVAL',
        invalidatedAt: null,
      });
      // aexa-server#201: the write is now a guarded updateMany + re-read, not a
      // bare update({ where: { id } }).
      approvalDb.updateMany.mockResolvedValue({ count: 1 });
      approvalDb.findUniqueOrThrow.mockResolvedValue({ id: 'ra-1', status: 'APPROVED' });

      const result = await risk_approval_service.approve_risk(makeReq({ params: { id: 'ra-1' } }));

      expect(approvalDb.updateMany).toHaveBeenCalledWith({
        where: { id: 'ra-1', status: 'PENDING_APPROVAL', invalidatedAt: null },
        data: { status: 'APPROVED', decidedById: ORG_A, decidedAt: expect.any(Date) },
      });
      expect(result.status).toBe('APPROVED');
      expect(auditDb.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ action: 'RISK_APPROVAL_APPROVED' }),
        }),
      );
    });

    // Maker-checker (aexa-server#200): the submitter cannot approve their own
    // submission. The caller is ORG_A, so a cycle whose submittedById is ORG_A
    // is a self-approval and must be blocked with a 403.
    it('BLOCKS self-approval: the submitter cannot approve their own submission (403)', async () => {
      mockMembership('ADMIN');
      approvalDb.findFirst.mockResolvedValue({
        id: 'ra-1',
        riskId: 'r1',
        submittedById: ORG_A, // same as the caller -> self-approval
        status: 'PENDING_APPROVAL',
        invalidatedAt: null,
      });

      await expect(
        risk_approval_service.approve_risk(makeReq({ params: { id: 'ra-1' } })),
      ).rejects.toMatchObject({ statusCode: 403 });

      // Must fail before any write is attempted.
      expect(approvalDb.updateMany).not.toHaveBeenCalled();
    });

    // The other half of maker-checker: a DIFFERENT admin can still approve the
    // same submission. Guards against a fix that over-blocks (e.g. blocking
    // everyone, not just the submitter).
    it('ALLOWS a different admin to approve a submission they did not submit', async () => {
      mockMembership('ADMIN'); // caller is ORG_A
      approvalDb.findFirst.mockResolvedValue({
        id: 'ra-1',
        riskId: 'r1',
        submittedById: SUBMITTER, // someone else submitted it
        status: 'PENDING_APPROVAL',
        invalidatedAt: null,
      });
      approvalDb.updateMany.mockResolvedValue({ count: 1 });
      approvalDb.findUniqueOrThrow.mockResolvedValue({ id: 'ra-1', status: 'APPROVED' });

      const result = await risk_approval_service.approve_risk(makeReq({ params: { id: 'ra-1' } }));

      expect(result.status).toBe('APPROVED');
      expect(approvalDb.updateMany).toHaveBeenCalled();
    });

    // Concurrency race (aexa-server#201): two admins approve the same pending
    // cycle. The first flips it; the second's guarded updateMany matches 0 rows
    // (status is no longer PENDING_APPROVAL) and must yield a clean 409, not a
    // duplicate transition and not a raw 500.
    it('returns a clean 409 (not 500) when the cycle was already decided concurrently', async () => {
      mockMembership('ADMIN');
      approvalDb.findFirst.mockResolvedValue({
        id: 'ra-1',
        riskId: 'r1',
        submittedById: SUBMITTER,
        status: 'PENDING_APPROVAL', // read-time state; the concurrent write lands next
        invalidatedAt: null,
      });
      // The guarded updateMany matched nothing — a concurrent request already
      // moved it out of the PENDING_APPROVAL/non-invalidated state.
      approvalDb.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        risk_approval_service.approve_risk(makeReq({ params: { id: 'ra-1' } })),
      ).rejects.toMatchObject({ statusCode: 409 });

      // No re-read, no audit event for a transition this request didn't perform.
      expect(approvalDb.findUniqueOrThrow).not.toHaveBeenCalled();
      expect(auditDb.create).not.toHaveBeenCalled();
    });

    it('non-ADMIN (LEAD_AUDITOR) cannot approve', async () => {
      mockMembership('LEAD_AUDITOR');

      await expect(
        risk_approval_service.approve_risk(makeReq({ params: { id: 'ra-1' } })),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(approvalDb.updateMany).not.toHaveBeenCalled();
    });

    it('rejects approving a cycle that is not PENDING_APPROVAL', async () => {
      mockMembership('ADMIN');
      approvalDb.findFirst.mockResolvedValue({
        id: 'ra-1',
        riskId: 'r1',
        submittedById: SUBMITTER,
        status: 'APPROVED',
        invalidatedAt: null,
      });

      await expect(
        risk_approval_service.approve_risk(makeReq({ params: { id: 'ra-1' } })),
      ).rejects.toMatchObject({ statusCode: 400 });

      expect(approvalDb.updateMany).not.toHaveBeenCalled();
    });

    it('throws 404 for an approval belonging to another org', async () => {
      mockMembership('ADMIN');
      approvalDb.findFirst.mockResolvedValue(null);

      await expect(
        risk_approval_service.approve_risk(makeReq({ params: { id: 'org-b-ra' } })),
      ).rejects.toMatchObject({ statusCode: 404 });

      expect(approvalDb.updateMany).not.toHaveBeenCalled();
    });

    // The revoked-while-pending analog from FindingAssignment: a risk edited
    // after submission sets invalidatedAt on its still-pending cycle, and
    // approving that superseded cycle must be refused.
    it('rejects approving a cycle that was invalidated (risk edited while pending)', async () => {
      mockMembership('ADMIN');
      approvalDb.findFirst.mockResolvedValue({
        id: 'ra-1',
        riskId: 'r1',
        submittedById: SUBMITTER,
        status: 'PENDING_APPROVAL',
        invalidatedAt: new Date(),
      });

      await expect(
        risk_approval_service.approve_risk(makeReq({ params: { id: 'ra-1' } })),
      ).rejects.toMatchObject({ statusCode: 400 });

      expect(approvalDb.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('reject_risk', () => {
    const SUBMITTER = 'some-other-admin-accountId';

    it('ADMIN rejects a PENDING_APPROVAL cycle -> REJECTED with the decision note + audit', async () => {
      mockMembership('ADMIN');
      approvalDb.findFirst.mockResolvedValue({
        id: 'ra-1',
        riskId: 'r1',
        submittedById: SUBMITTER,
        status: 'PENDING_APPROVAL',
        invalidatedAt: null,
      });
      approvalDb.updateMany.mockResolvedValue({ count: 1 });
      approvalDb.findUniqueOrThrow.mockResolvedValue({ id: 'ra-1', status: 'REJECTED' });

      const result = await risk_approval_service.reject_risk(
        makeReq({ params: { id: 'ra-1' }, body: { decisionNote: 'Residual score too high' } }),
      );

      expect(approvalDb.updateMany).toHaveBeenCalledWith({
        where: { id: 'ra-1', status: 'PENDING_APPROVAL', invalidatedAt: null },
        data: {
          status: 'REJECTED',
          decidedById: ORG_A,
          decidedAt: expect.any(Date),
          decisionNote: 'Residual score too high',
        },
      });
      expect(result.status).toBe('REJECTED');
      expect(auditDb.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ action: 'RISK_APPROVAL_REJECTED' }),
        }),
      );
    });

    // Maker-checker (aexa-server#200) applies to reject too: a submitter cannot
    // decide their own submission even to reject it.
    it('BLOCKS self-rejection: the submitter cannot reject their own submission (403)', async () => {
      mockMembership('ADMIN');
      approvalDb.findFirst.mockResolvedValue({
        id: 'ra-1',
        riskId: 'r1',
        submittedById: ORG_A, // same as caller
        status: 'PENDING_APPROVAL',
        invalidatedAt: null,
      });

      await expect(
        risk_approval_service.reject_risk(
          makeReq({ params: { id: 'ra-1' }, body: { decisionNote: 'x' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(approvalDb.updateMany).not.toHaveBeenCalled();
    });

    it('ALLOWS a different admin to reject a submission they did not submit', async () => {
      mockMembership('ADMIN');
      approvalDb.findFirst.mockResolvedValue({
        id: 'ra-1',
        riskId: 'r1',
        submittedById: SUBMITTER,
        status: 'PENDING_APPROVAL',
        invalidatedAt: null,
      });
      approvalDb.updateMany.mockResolvedValue({ count: 1 });
      approvalDb.findUniqueOrThrow.mockResolvedValue({ id: 'ra-1', status: 'REJECTED' });

      const result = await risk_approval_service.reject_risk(
        makeReq({ params: { id: 'ra-1' }, body: { decisionNote: 'x' } }),
      );

      expect(result.status).toBe('REJECTED');
    });

    // Concurrency race (aexa-server#201): the guarded updateMany matches 0 rows
    // because a concurrent decision/invalidation already moved the cycle, so
    // reject must yield a clean 409 not a 500.
    it('returns a clean 409 (not 500) when the cycle was already decided concurrently', async () => {
      mockMembership('ADMIN');
      approvalDb.findFirst.mockResolvedValue({
        id: 'ra-1',
        riskId: 'r1',
        submittedById: SUBMITTER,
        status: 'PENDING_APPROVAL',
        invalidatedAt: null,
      });
      approvalDb.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        risk_approval_service.reject_risk(
          makeReq({ params: { id: 'ra-1' }, body: { decisionNote: 'x' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 409 });

      expect(approvalDb.findUniqueOrThrow).not.toHaveBeenCalled();
      expect(auditDb.create).not.toHaveBeenCalled();
    });

    it('non-ADMIN cannot reject', async () => {
      mockMembership('LEAD_AUDITOR');

      await expect(
        risk_approval_service.reject_risk(
          makeReq({ params: { id: 'ra-1' }, body: { decisionNote: 'x' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(approvalDb.updateMany).not.toHaveBeenCalled();
    });

    it('rejects rejecting a cycle that is not PENDING_APPROVAL', async () => {
      mockMembership('ADMIN');
      approvalDb.findFirst.mockResolvedValue({
        id: 'ra-1',
        riskId: 'r1',
        submittedById: SUBMITTER,
        status: 'REJECTED',
        invalidatedAt: null,
      });

      await expect(
        risk_approval_service.reject_risk(
          makeReq({ params: { id: 'ra-1' }, body: { decisionNote: 'x' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 400 });

      expect(approvalDb.updateMany).not.toHaveBeenCalled();
    });

    it('rejects rejecting a cycle that was invalidated while pending', async () => {
      mockMembership('ADMIN');
      approvalDb.findFirst.mockResolvedValue({
        id: 'ra-1',
        riskId: 'r1',
        submittedById: SUBMITTER,
        status: 'PENDING_APPROVAL',
        invalidatedAt: new Date(),
      });

      await expect(
        risk_approval_service.reject_risk(
          makeReq({ params: { id: 'ra-1' }, body: { decisionNote: 'x' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 400 });

      expect(approvalDb.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('get_risk_approval_state', () => {
    it('returns NOT_SUBMITTED when the risk has no approval cycle', async () => {
      mockMembership('LEAD_AUDITOR');
      riskDb.findFirst.mockResolvedValue({ id: 'r1', org_account_id: ANCHOR });
      approvalDb.findFirst.mockResolvedValue(null);

      const result = await risk_approval_service.get_risk_approval_state(
        makeReq({ params: { id: 'r1' } }),
      );

      expect(result).toMatchObject({ riskId: 'r1', status: 'NOT_SUBMITTED', approval: null });
    });

    it('returns PENDING_APPROVAL when the latest cycle is pending', async () => {
      mockMembership('LEAD_AUDITOR');
      riskDb.findFirst.mockResolvedValue({ id: 'r1', org_account_id: ANCHOR });
      approvalDb.findFirst.mockResolvedValue({
        id: 'ra-1',
        status: 'PENDING_APPROVAL',
        invalidatedAt: null,
      });

      const result = await risk_approval_service.get_risk_approval_state(
        makeReq({ params: { id: 'r1' } }),
      );

      expect(result.status).toBe('PENDING_APPROVAL');
    });

    it('returns NOT_SUBMITTED when the latest cycle was invalidated by an edit', async () => {
      mockMembership('LEAD_AUDITOR');
      riskDb.findFirst.mockResolvedValue({ id: 'r1', org_account_id: ANCHOR });
      approvalDb.findFirst.mockResolvedValue({
        id: 'ra-1',
        status: 'APPROVED',
        invalidatedAt: new Date(),
      });

      const result = await risk_approval_service.get_risk_approval_state(
        makeReq({ params: { id: 'r1' } }),
      );

      expect(result.status).toBe('NOT_SUBMITTED');
    });

    it('returns REJECTED when the latest live cycle is rejected', async () => {
      mockMembership('LEAD_AUDITOR');
      riskDb.findFirst.mockResolvedValue({ id: 'r1', org_account_id: ANCHOR });
      approvalDb.findFirst.mockResolvedValue({
        id: 'ra-1',
        status: 'REJECTED',
        invalidatedAt: null,
      });

      const result = await risk_approval_service.get_risk_approval_state(
        makeReq({ params: { id: 'r1' } }),
      );

      expect(result.status).toBe('REJECTED');
    });

    it('throws 404 for a risk belonging to another org', async () => {
      mockMembership('LEAD_AUDITOR');
      riskDb.findFirst.mockResolvedValue(null);

      await expect(
        risk_approval_service.get_risk_approval_state(makeReq({ params: { id: 'org-b-risk' } })),
      ).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe('invalidateLiveApprovalsOnEdit', () => {
    const ctx = { organizationId: ANCHOR, role: 'ADMIN' as const, orgMemberId: MEMBER_ID };

    it('invalidates live PENDING/APPROVED cycles and writes an audit event', async () => {
      mockMembership('ADMIN');
      approvalDb.findMany.mockResolvedValue([{ id: 'ra-1' }, { id: 'ra-2' }]);
      approvalDb.updateMany.mockResolvedValue({ count: 2 });

      await risk_approval_service.invalidateLiveApprovalsOnEdit('r1', ctx, ORG_A);

      expect(approvalDb.updateMany).toHaveBeenCalledWith({
        where: {
          riskId: 'r1',
          invalidatedAt: null,
          status: { in: ['PENDING_APPROVAL', 'APPROVED'] },
        },
        data: { invalidatedAt: expect.any(Date), invalidatedById: ORG_A },
      });
      expect(auditDb.create).toHaveBeenCalledTimes(2);
    });

    it('is a no-op (no updateMany, no audit) when there is no live cycle', async () => {
      approvalDb.findMany.mockResolvedValue([]);

      await risk_approval_service.invalidateLiveApprovalsOnEdit('r1', ctx, ORG_A);

      expect(approvalDb.updateMany).not.toHaveBeenCalled();
      expect(auditDb.create).not.toHaveBeenCalled();
    });
  });
});
