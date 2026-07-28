import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ORG_A, makeReq } from '../helpers/makeReq.js';

vi.mock('../../app/lib/prisma.js', () => ({
  prisma: {
    action: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    actionClosureApproval: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
    },
    findingAssignment: {
      findFirst: vi.fn(),
    },
    inspectionAssignment: {
      findMany: vi.fn(),
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
    $transaction: vi.fn(),
  },
}));

import { prisma } from '../../app/lib/prisma.js';
import { action_closure_service } from '../../app/modules/action/action.closure.service.js';

const actionDb = prisma.action as unknown as Record<string, ReturnType<typeof vi.fn>>;
const closureDb = prisma.actionClosureApproval as unknown as Record<
  string,
  ReturnType<typeof vi.fn>
>;
const findingAssignmentDb = prisma.findingAssignment as unknown as Record<
  string,
  ReturnType<typeof vi.fn>
>;
const orgMemberDb = prisma.orgMember as unknown as Record<string, ReturnType<typeof vi.fn>>;
const organizationDb = prisma.organization as unknown as Record<string, ReturnType<typeof vi.fn>>;
const auditDb = prisma.orgAuditLog as unknown as Record<string, ReturnType<typeof vi.fn>>;
const txFn = (prisma as unknown as { $transaction: ReturnType<typeof vi.fn> }).$transaction;

const ANCHOR = ORG_A;
const ORG_ID = 'org-00000000-0000-0000-0000-000000000252';
const MEMBER_ID = 'org-member-00000000-0000-0000-0000-000000000252';

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

describe('action closure service — finding closure maker-checker (aexa-server#252)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auditDb.create.mockResolvedValue({});
    txFn.mockImplementation(async (cb: (tx: typeof prisma) => unknown) => cb(prisma));
  });

  describe('submit_action_for_closure', () => {
    it('ADMIN submits a finding with evidence and no live cycle, creating a PENDING_APPROVAL row + audit event', async () => {
      mockMembership('ADMIN');
      actionDb.findFirst.mockResolvedValue({
        id: 'a1',
        orgAccountId: ANCHOR,
        inspectionId: 'insp-1',
        attachments: ['https://s3/evidence.pdf'],
      });
      closureDb.findFirst.mockResolvedValue(null);
      closureDb.create.mockResolvedValue({ id: 'ca-1', status: 'PENDING_APPROVAL' });

      const result = await action_closure_service.submit_action_for_closure(
        makeReq({ params: { id: 'a1' }, body: { requestedStatus: 'COMPLETE' } }),
      );

      expect(closureDb.create).toHaveBeenCalledWith({
        data: {
          actionId: 'a1',
          requestedStatus: 'COMPLETE',
          submittedById: ORG_A,
          status: 'PENDING_APPROVAL',
        },
      });
      expect(result.status).toBe('PENDING_APPROVAL');
      expect(auditDb.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ action: 'ACTION_CLOSURE_SUBMITTED' }),
        }),
      );
    });

    it('a LIGHT_USER actively sub-assigned to the finding can submit it for closure', async () => {
      mockMembership('LIGHT_USER');
      findingAssignmentDb.findFirst.mockResolvedValue({ id: 'fa-1' });
      actionDb.findFirst.mockResolvedValue({
        id: 'a1',
        orgAccountId: ANCHOR,
        inspectionId: 'insp-1',
        attachments: ['https://s3/evidence.pdf'],
      });
      closureDb.findFirst.mockResolvedValue(null);
      closureDb.create.mockResolvedValue({ id: 'ca-1', status: 'PENDING_APPROVAL' });

      await action_closure_service.submit_action_for_closure(
        makeReq({ params: { id: 'a1' }, body: { requestedStatus: 'COMPLETE' } }),
      );

      expect(closureDb.create).toHaveBeenCalled();
    });

    it('a LIGHT_USER with no live sub-assignment cannot submit', async () => {
      mockMembership('LIGHT_USER');
      findingAssignmentDb.findFirst.mockResolvedValue(null);
      actionDb.findFirst.mockResolvedValue({
        id: 'a1',
        orgAccountId: ANCHOR,
        inspectionId: 'insp-1',
        attachments: ['https://s3/evidence.pdf'],
      });

      await expect(
        action_closure_service.submit_action_for_closure(
          makeReq({ params: { id: 'a1' }, body: { requestedStatus: 'COMPLETE' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(closureDb.create).not.toHaveBeenCalled();
    });

    it('rejects a requestedStatus that is not COMPLETE or CANT_DO', async () => {
      mockMembership('ADMIN');
      actionDb.findFirst.mockResolvedValue({
        id: 'a1',
        orgAccountId: ANCHOR,
        inspectionId: 'insp-1',
        attachments: ['https://s3/evidence.pdf'],
      });

      await expect(
        action_closure_service.submit_action_for_closure(
          makeReq({ params: { id: 'a1' }, body: { requestedStatus: 'IN_PROGRESS' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 400 });

      expect(closureDb.create).not.toHaveBeenCalled();
    });

    // aexa-server#243's evidence-gate precedent: an unbacked closure claim
    // isn't a real gap fix.
    it('rejects submitting a finding with an explicitly empty attachments array', async () => {
      mockMembership('ADMIN');
      actionDb.findFirst.mockResolvedValue({
        id: 'a1',
        orgAccountId: ANCHOR,
        inspectionId: 'insp-1',
        attachments: [],
      });

      await expect(
        action_closure_service.submit_action_for_closure(
          makeReq({ params: { id: 'a1' }, body: { requestedStatus: 'COMPLETE' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 400 });

      expect(closureDb.create).not.toHaveBeenCalled();
    });

    it('rejects submitting a finding whose attachments field is entirely absent', async () => {
      mockMembership('ADMIN');
      actionDb.findFirst.mockResolvedValue({
        id: 'a1',
        orgAccountId: ANCHOR,
        inspectionId: 'insp-1',
        attachments: undefined,
      });

      await expect(
        action_closure_service.submit_action_for_closure(
          makeReq({ params: { id: 'a1' }, body: { requestedStatus: 'COMPLETE' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 400 });

      expect(closureDb.create).not.toHaveBeenCalled();
    });

    it('blocks (409) when a PENDING_APPROVAL cycle is already live', async () => {
      mockMembership('ADMIN');
      actionDb.findFirst.mockResolvedValue({
        id: 'a1',
        orgAccountId: ANCHOR,
        inspectionId: 'insp-1',
        attachments: ['https://s3/evidence.pdf'],
      });
      closureDb.findFirst.mockResolvedValue({ id: 'ca-1', status: 'PENDING_APPROVAL' });

      await expect(
        action_closure_service.submit_action_for_closure(
          makeReq({ params: { id: 'a1' }, body: { requestedStatus: 'COMPLETE' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 409 });

      expect(closureDb.create).not.toHaveBeenCalled();
    });

    it('throws 404 for a finding belonging to another org', async () => {
      mockMembership('ADMIN');
      actionDb.findFirst.mockResolvedValue(null);

      await expect(
        action_closure_service.submit_action_for_closure(
          makeReq({ params: { id: 'org-b-action' }, body: { requestedStatus: 'COMPLETE' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });

      expect(closureDb.create).not.toHaveBeenCalled();
    });

    it('resolves a P2002 create race to the winning row instead of a 500', async () => {
      mockMembership('ADMIN');
      actionDb.findFirst.mockResolvedValue({
        id: 'a1',
        orgAccountId: ANCHOR,
        inspectionId: 'insp-1',
        attachments: ['https://s3/evidence.pdf'],
      });
      closureDb.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'ca-winner', status: 'PENDING_APPROVAL' });
      closureDb.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('unique', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );

      const result = await action_closure_service.submit_action_for_closure(
        makeReq({ params: { id: 'a1' }, body: { requestedStatus: 'COMPLETE' } }),
      );

      expect(result.id).toBe('ca-winner');
    });
  });

  describe('approve_action_closure', () => {
    const SUBMITTER = 'some-other-accountId';

    it('ADMIN/LEAD_AUDITOR approves a PENDING_APPROVAL cycle -> APPROVED, and atomically applies requestedStatus to Action.status', async () => {
      mockMembership('ADMIN');
      closureDb.findFirst.mockResolvedValue({
        id: 'ca-1',
        actionId: 'a1',
        submittedById: SUBMITTER,
        status: 'PENDING_APPROVAL',
        invalidatedAt: null,
        requestedStatus: 'COMPLETE',
      });
      closureDb.updateMany.mockResolvedValue({ count: 1 });
      closureDb.findUniqueOrThrow.mockResolvedValue({
        id: 'ca-1',
        status: 'APPROVED',
        requestedStatus: 'COMPLETE',
      });
      actionDb.update.mockResolvedValue({ id: 'a1', status: 'COMPLETE' });

      const result = await action_closure_service.approve_action_closure(
        makeReq({ params: { id: 'ca-1' } }),
      );

      expect(closureDb.updateMany).toHaveBeenCalledWith({
        where: { id: 'ca-1', status: 'PENDING_APPROVAL', invalidatedAt: null },
        data: { status: 'APPROVED', decidedById: ORG_A, decidedAt: expect.any(Date) },
      });
      expect(actionDb.update).toHaveBeenCalledWith({
        where: { id: 'a1' },
        data: { status: 'COMPLETE' },
      });
      expect(result.closure.status).toBe('APPROVED');
      expect(result.action.status).toBe('COMPLETE');
      expect(auditDb.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ action: 'ACTION_CLOSURE_APPROVED' }),
        }),
      );
    });

    it('LEAD_AUDITOR may also approve (same writer class as ADMIN)', async () => {
      mockMembership('LEAD_AUDITOR');
      closureDb.findFirst.mockResolvedValue({
        id: 'ca-1',
        actionId: 'a1',
        submittedById: SUBMITTER,
        status: 'PENDING_APPROVAL',
        invalidatedAt: null,
        requestedStatus: 'CANT_DO',
      });
      closureDb.updateMany.mockResolvedValue({ count: 1 });
      closureDb.findUniqueOrThrow.mockResolvedValue({
        id: 'ca-1',
        status: 'APPROVED',
        requestedStatus: 'CANT_DO',
      });
      actionDb.update.mockResolvedValue({ id: 'a1', status: 'CANT_DO' });

      const result = await action_closure_service.approve_action_closure(
        makeReq({ params: { id: 'ca-1' } }),
      );

      expect(result.action.status).toBe('CANT_DO');
    });

    it('VIEWER/LIGHT_USER cannot approve', async () => {
      mockMembership('LIGHT_USER');

      await expect(
        action_closure_service.approve_action_closure(makeReq({ params: { id: 'ca-1' } })),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(closureDb.updateMany).not.toHaveBeenCalled();
    });

    // Maker-checker: the submitter cannot approve their own submission, even
    // as an ADMIN/LEAD_AUDITOR.
    it('BLOCKS self-approval: the submitter cannot approve their own submission (403)', async () => {
      mockMembership('ADMIN');
      closureDb.findFirst.mockResolvedValue({
        id: 'ca-1',
        actionId: 'a1',
        submittedById: ORG_A, // same as caller -> self-approval
        status: 'PENDING_APPROVAL',
        invalidatedAt: null,
        requestedStatus: 'COMPLETE',
      });

      await expect(
        action_closure_service.approve_action_closure(makeReq({ params: { id: 'ca-1' } })),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(closureDb.updateMany).not.toHaveBeenCalled();
      expect(actionDb.update).not.toHaveBeenCalled();
    });

    // Ordering precedent from risk.approval.service.ts's approve_risk: the
    // self-approval check must run BEFORE the state checks, so a self-
    // submitted cycle that's ALSO not PENDING_APPROVAL still 403s for
    // self-approval rather than 400ing on wrong-state (which would leak
    // the cycle's state to someone who shouldn't be deciding it at all).
    it('BLOCKS self-approval even when the cycle is ALSO not PENDING_APPROVAL (self-check wins)', async () => {
      mockMembership('ADMIN');
      closureDb.findFirst.mockResolvedValue({
        id: 'ca-1',
        actionId: 'a1',
        submittedById: ORG_A,
        status: 'APPROVED', // already decided — would otherwise 400
        invalidatedAt: null,
        requestedStatus: 'COMPLETE',
      });

      await expect(
        action_closure_service.approve_action_closure(makeReq({ params: { id: 'ca-1' } })),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(closureDb.updateMany).not.toHaveBeenCalled();
    });

    it('rejects approving a cycle that is not PENDING_APPROVAL', async () => {
      mockMembership('ADMIN');
      closureDb.findFirst.mockResolvedValue({
        id: 'ca-1',
        actionId: 'a1',
        submittedById: SUBMITTER,
        status: 'APPROVED',
        invalidatedAt: null,
        requestedStatus: 'COMPLETE',
      });

      await expect(
        action_closure_service.approve_action_closure(makeReq({ params: { id: 'ca-1' } })),
      ).rejects.toMatchObject({ statusCode: 400 });

      expect(closureDb.updateMany).not.toHaveBeenCalled();
    });

    it('rejects approving a cycle that was invalidated (finding edited while pending)', async () => {
      mockMembership('ADMIN');
      closureDb.findFirst.mockResolvedValue({
        id: 'ca-1',
        actionId: 'a1',
        submittedById: SUBMITTER,
        status: 'PENDING_APPROVAL',
        invalidatedAt: new Date(),
        requestedStatus: 'COMPLETE',
      });

      await expect(
        action_closure_service.approve_action_closure(makeReq({ params: { id: 'ca-1' } })),
      ).rejects.toMatchObject({ statusCode: 400 });

      expect(closureDb.updateMany).not.toHaveBeenCalled();
    });

    it('returns a clean 409 (not 500) when the cycle was already decided concurrently', async () => {
      mockMembership('ADMIN');
      closureDb.findFirst.mockResolvedValue({
        id: 'ca-1',
        actionId: 'a1',
        submittedById: SUBMITTER,
        status: 'PENDING_APPROVAL',
        invalidatedAt: null,
        requestedStatus: 'COMPLETE',
      });
      closureDb.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        action_closure_service.approve_action_closure(makeReq({ params: { id: 'ca-1' } })),
      ).rejects.toMatchObject({ statusCode: 409 });

      expect(actionDb.update).not.toHaveBeenCalled();
      expect(auditDb.create).not.toHaveBeenCalled();
    });

    it('throws 404 for a closure request belonging to another org', async () => {
      mockMembership('ADMIN');
      closureDb.findFirst.mockResolvedValue(null);

      await expect(
        action_closure_service.approve_action_closure(makeReq({ params: { id: 'org-b-ca' } })),
      ).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe('reject_action_closure', () => {
    const SUBMITTER = 'some-other-accountId';

    it('ADMIN/LEAD_AUDITOR rejects a PENDING_APPROVAL cycle -> REJECTED with the decision note + audit; Action.status is untouched', async () => {
      mockMembership('ADMIN');
      closureDb.findFirst.mockResolvedValue({
        id: 'ca-1',
        actionId: 'a1',
        submittedById: SUBMITTER,
        status: 'PENDING_APPROVAL',
        invalidatedAt: null,
      });
      closureDb.updateMany.mockResolvedValue({ count: 1 });
      closureDb.findUniqueOrThrow.mockResolvedValue({ id: 'ca-1', status: 'REJECTED' });

      const result = await action_closure_service.reject_action_closure(
        makeReq({ params: { id: 'ca-1' }, body: { decisionNote: 'Evidence insufficient' } }),
      );

      expect(closureDb.updateMany).toHaveBeenCalledWith({
        where: { id: 'ca-1', status: 'PENDING_APPROVAL', invalidatedAt: null },
        data: {
          status: 'REJECTED',
          decidedById: ORG_A,
          decidedAt: expect.any(Date),
          decisionNote: 'Evidence insufficient',
        },
      });
      expect(result.status).toBe('REJECTED');
      expect(actionDb.update).not.toHaveBeenCalled();
      expect(auditDb.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ action: 'ACTION_CLOSURE_REJECTED' }),
        }),
      );
    });

    it('requires a non-blank decisionNote', async () => {
      mockMembership('ADMIN');

      await expect(
        action_closure_service.reject_action_closure(
          makeReq({ params: { id: 'ca-1' }, body: { decisionNote: '   ' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 400 });

      expect(closureDb.updateMany).not.toHaveBeenCalled();
    });

    it('BLOCKS self-rejection: the submitter cannot reject their own submission (403)', async () => {
      mockMembership('ADMIN');
      closureDb.findFirst.mockResolvedValue({
        id: 'ca-1',
        actionId: 'a1',
        submittedById: ORG_A,
        status: 'PENDING_APPROVAL',
        invalidatedAt: null,
      });

      await expect(
        action_closure_service.reject_action_closure(
          makeReq({ params: { id: 'ca-1' }, body: { decisionNote: 'x' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(closureDb.updateMany).not.toHaveBeenCalled();
    });

    // Same ordering precedent as approve_action_closure: self-check before
    // state checks.
    it('BLOCKS self-rejection even when the cycle is ALSO not PENDING_APPROVAL (self-check wins)', async () => {
      mockMembership('ADMIN');
      closureDb.findFirst.mockResolvedValue({
        id: 'ca-1',
        actionId: 'a1',
        submittedById: ORG_A,
        status: 'REJECTED', // already decided — would otherwise 400
        invalidatedAt: null,
      });

      await expect(
        action_closure_service.reject_action_closure(
          makeReq({ params: { id: 'ca-1' }, body: { decisionNote: 'x' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(closureDb.updateMany).not.toHaveBeenCalled();
    });

    it('VIEWER/LIGHT_USER cannot reject', async () => {
      mockMembership('LIGHT_USER');

      await expect(
        action_closure_service.reject_action_closure(
          makeReq({ params: { id: 'ca-1' }, body: { decisionNote: 'x' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(closureDb.updateMany).not.toHaveBeenCalled();
    });

    it('returns a clean 409 (not 500) when the cycle was already decided concurrently', async () => {
      mockMembership('ADMIN');
      closureDb.findFirst.mockResolvedValue({
        id: 'ca-1',
        actionId: 'a1',
        submittedById: SUBMITTER,
        status: 'PENDING_APPROVAL',
        invalidatedAt: null,
      });
      closureDb.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        action_closure_service.reject_action_closure(
          makeReq({ params: { id: 'ca-1' }, body: { decisionNote: 'x' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 409 });

      expect(auditDb.create).not.toHaveBeenCalled();
    });
  });

  describe('get_action_closure_state', () => {
    it('returns NOT_SUBMITTED when the finding has no closure cycle', async () => {
      mockMembership('ADMIN');
      actionDb.findFirst.mockResolvedValue({ id: 'a1', orgAccountId: ANCHOR });
      closureDb.findFirst.mockResolvedValue(null);

      const result = await action_closure_service.get_action_closure_state(
        makeReq({ params: { id: 'a1' } }),
      );

      expect(result).toMatchObject({ actionId: 'a1', status: 'NOT_SUBMITTED', closure: null });
    });

    it('returns PENDING_APPROVAL when the latest cycle is pending', async () => {
      mockMembership('ADMIN');
      actionDb.findFirst.mockResolvedValue({ id: 'a1', orgAccountId: ANCHOR });
      closureDb.findFirst.mockResolvedValue({
        id: 'ca-1',
        status: 'PENDING_APPROVAL',
        invalidatedAt: null,
      });

      const result = await action_closure_service.get_action_closure_state(
        makeReq({ params: { id: 'a1' } }),
      );

      expect(result.status).toBe('PENDING_APPROVAL');
    });

    it('returns NOT_SUBMITTED when the latest cycle was invalidated by an edit', async () => {
      mockMembership('ADMIN');
      actionDb.findFirst.mockResolvedValue({ id: 'a1', orgAccountId: ANCHOR });
      closureDb.findFirst.mockResolvedValue({
        id: 'ca-1',
        status: 'APPROVED',
        invalidatedAt: new Date(),
      });

      const result = await action_closure_service.get_action_closure_state(
        makeReq({ params: { id: 'a1' } }),
      );

      expect(result.status).toBe('NOT_SUBMITTED');
    });

    it('throws 404 for a finding belonging to another org', async () => {
      mockMembership('ADMIN');
      actionDb.findFirst.mockResolvedValue(null);

      await expect(
        action_closure_service.get_action_closure_state(
          makeReq({ params: { id: 'org-b-action' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe('invalidateLiveClosureApprovalsOnEdit', () => {
    // aexa-server#252: takes a LAZY organizationId resolver — resolved only
    // when there's actually a live cycle to invalidate, so a solo-admin
    // (no real Organization) editing an action with nothing pending doesn't
    // throw just because eagerly resolving one would fail for them.
    const resolveOrgId = () => Promise.resolve(ORG_ID);

    it('invalidates a live PENDING_APPROVAL cycle, writes an audit event, and leaves Action.status untouched', async () => {
      mockMembership('ADMIN');
      closureDb.findMany.mockResolvedValue([{ id: 'ca-1', status: 'PENDING_APPROVAL' }]);
      closureDb.updateMany.mockResolvedValue({ count: 1 });

      await action_closure_service.invalidateLiveClosureApprovalsOnEdit('a1', resolveOrgId, ORG_A);

      expect(closureDb.updateMany).toHaveBeenCalledWith({
        where: {
          actionId: 'a1',
          invalidatedAt: null,
          status: { in: ['PENDING_APPROVAL', 'APPROVED'] },
        },
        data: { invalidatedAt: expect.any(Date), invalidatedById: ORG_A },
      });
      expect(auditDb.create).toHaveBeenCalledTimes(1);
      // Action.status was never advanced by a merely-pending cycle, so
      // invalidating it must not touch Action.status at all.
      expect(actionDb.update).not.toHaveBeenCalled();
    });

    it('aexa-server#258: invalidating a live APPROVED cycle also reverts Action.status to IN_PROGRESS', async () => {
      mockMembership('ADMIN');
      closureDb.findMany.mockResolvedValue([{ id: 'ca-1', status: 'APPROVED' }]);
      closureDb.updateMany.mockResolvedValue({ count: 1 });
      actionDb.update.mockResolvedValue({ id: 'a1', status: 'IN_PROGRESS' });

      await action_closure_service.invalidateLiveClosureApprovalsOnEdit('a1', resolveOrgId, ORG_A);

      expect(closureDb.updateMany).toHaveBeenCalledWith({
        where: {
          actionId: 'a1',
          invalidatedAt: null,
          status: { in: ['PENDING_APPROVAL', 'APPROVED'] },
        },
        data: { invalidatedAt: expect.any(Date), invalidatedById: ORG_A },
      });
      expect(actionDb.update).toHaveBeenCalledWith({
        where: { id: 'a1' },
        data: { status: 'IN_PROGRESS' },
      });
      expect(auditDb.create).toHaveBeenCalledTimes(1);
    });

    it('detects an APPROVED cycle mixed in among other live rows and still reverts Action.status', async () => {
      mockMembership('ADMIN');
      closureDb.findMany.mockResolvedValue([
        { id: 'ca-pending', status: 'PENDING_APPROVAL' },
        { id: 'ca-approved', status: 'APPROVED' },
      ]);
      closureDb.updateMany.mockResolvedValue({ count: 2 });
      actionDb.update.mockResolvedValue({ id: 'a1', status: 'IN_PROGRESS' });

      await action_closure_service.invalidateLiveClosureApprovalsOnEdit('a1', resolveOrgId, ORG_A);

      expect(actionDb.update).toHaveBeenCalledWith({
        where: { id: 'a1' },
        data: { status: 'IN_PROGRESS' },
      });
      // Both live rows get invalidated and audited, not just the APPROVED one.
      expect(auditDb.create).toHaveBeenCalledTimes(2);
    });

    it('aexa-server#258 review: does NOT override Action.status when the caller already set it explicitly in the same edit', async () => {
      mockMembership('ADMIN');
      closureDb.findMany.mockResolvedValue([{ id: 'ca-1', status: 'APPROVED' }]);
      closureDb.updateMany.mockResolvedValue({ count: 1 });

      await action_closure_service.invalidateLiveClosureApprovalsOnEdit(
        'a1',
        resolveOrgId,
        ORG_A,
        undefined,
        true, // callerExplicitlySetStatus
      );

      // The invalidation and audit still happen -- only the forced
      // Action.status revert is skipped, deferring to the caller's own
      // explicit choice (e.g. {status: 'TO_DO'}).
      expect(closureDb.updateMany).toHaveBeenCalledTimes(1);
      expect(auditDb.create).toHaveBeenCalledTimes(1);
      expect(actionDb.update).not.toHaveBeenCalled();
    });

    it('is a no-op (no updateMany, no audit, no organizationId resolution) when there is no live cycle', async () => {
      closureDb.findMany.mockResolvedValue([]);
      const resolveOrgIdSpy = vi.fn(() => Promise.resolve(ORG_ID));

      await action_closure_service.invalidateLiveClosureApprovalsOnEdit(
        'a1',
        resolveOrgIdSpy,
        ORG_A,
      );

      expect(closureDb.updateMany).not.toHaveBeenCalled();
      expect(auditDb.create).not.toHaveBeenCalled();
      expect(resolveOrgIdSpy).not.toHaveBeenCalled();
    });
  });
});
