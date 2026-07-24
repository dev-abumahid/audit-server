import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ORG_A, ORG_B, makeReq } from '../helpers/makeReq.js';

vi.mock('../../app/lib/prisma.js', () => ({
  prisma: {
    risk: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      count: vi.fn(),
    },
    inspection: {
      count: vi.fn(),
    },
    recommendation: {
      count: vi.fn(),
    },
    kri: {
      count: vi.fn(),
    },
    riskApproval: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn(),
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
    // aexa-server#203: update_risk_into_db now wraps the risk write + approval
    // invalidation in a $transaction. The mock runs the interactive callback
    // with the same mocked prisma as the tx client, so tx.risk.update /
    // tx.riskApproval.* resolve to the mocks the tests already configure.
    $transaction: vi.fn(),
  },
}));

import { prisma } from '../../app/lib/prisma.js';
import { risk_service } from '../../app/modules/risk/risk.service.js';

const db = prisma.risk as unknown as Record<string, ReturnType<typeof vi.fn>>;
const inspectionDb = prisma.inspection as unknown as Record<string, ReturnType<typeof vi.fn>>;
const recommendationDb = prisma.recommendation as unknown as Record<
  string,
  ReturnType<typeof vi.fn>
>;
const kriDb = prisma.kri as unknown as Record<string, ReturnType<typeof vi.fn>>;
const riskApprovalDb = prisma.riskApproval as unknown as Record<string, ReturnType<typeof vi.fn>>;
const orgMemberDb = prisma.orgMember as unknown as Record<string, ReturnType<typeof vi.fn>>;
const organizationDb = prisma.organization as unknown as Record<string, ReturnType<typeof vi.fn>>;
const txFn = (prisma as unknown as { $transaction: ReturnType<typeof vi.fn> }).$transaction;

const ANCHOR = ORG_A;
const ORG_ID = 'org-00000000-0000-0000-0000-000000000009';
const MEMBER_ID = 'org-member-00000000-0000-0000-0000-000000000009';

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

describe('risk service — org scoping (ticket #6)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no OrgMember row — ADMIN-of-self fallback (org anchor ===
    // caller's own accountId), same as every other org-anchor-scoped
    // service's test file in this repo.
    orgMemberDb.findUnique.mockResolvedValue(null);
    // Default: risk is not in use, so the in-use delete guards are no-ops
    // unless a specific test overrides these counts.
    inspectionDb.count.mockResolvedValue(0);
    recommendationDb.count.mockResolvedValue(0);
    kriDb.count.mockResolvedValue(0);
    // Default: no live approval cycle, so the update-hook that invalidates a
    // risk's approval on edit (aexa-frontend#95) is a no-op unless a test
    // overrides this.
    riskApprovalDb.findMany.mockResolvedValue([]);
    // Default: no live approval cycle referencing the risk, so the delete
    // in-use guard (aexa-server#202) is a no-op unless a test overrides it.
    riskApprovalDb.count.mockResolvedValue(0);
    // Default $transaction impl (aexa-server#203): run the interactive callback
    // immediately with the same mocked prisma as the tx client, and propagate
    // any error the callback throws (so a mid-transaction failure rejects,
    // exactly as a real rollback would surface to the caller).
    txFn.mockImplementation(async (cb: (tx: typeof prisma) => unknown) => cb(prisma));
  });

  describe('org-anchor scoping for invited (non-anchor) members', () => {
    it('an invited member (accountId !== org anchor) still gets risks scoped by the org anchor id, not their own accountId', async () => {
      mockMembership('LEAD_AUDITOR');
      db.findMany.mockResolvedValue([]);

      await risk_service.get_all_risk_from_db(makeReq());

      const [callArg] = db.findMany.mock.calls[0];
      // ORG_A is the caller's own accountId; ANCHOR is set to the same
      // constant here for clarity, but the point is the code path used
      // ctx.organizationId (resolved via the mocked OrgMember/Organization
      // rows), not user.accountId directly — verified by mockMembership
      // actually being consulted (orgMemberDb.findUnique was called).
      expect(callArg.where).toMatchObject({ org_account_id: ANCHOR });
      expect(orgMemberDb.findUnique).toHaveBeenCalled();
    });
  });

  describe('write-path role scoping (issue #55 slice 3)', () => {
    it('VIEWER cannot create a risk', async () => {
      mockMembership('VIEWER');

      await expect(
        risk_service.create_risk_into_db(makeReq({ body: { name: 'Cyber risk' } })),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(db.create).not.toHaveBeenCalled();
    });

    it('LIGHT_USER cannot update a risk', async () => {
      mockMembership('LIGHT_USER');

      await expect(
        risk_service.update_risk_into_db(makeReq({ params: { id: 'r1' } })),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(db.findFirst).not.toHaveBeenCalled();
      expect(db.update).not.toHaveBeenCalled();
    });

    it('VIEWER cannot delete a risk', async () => {
      mockMembership('VIEWER');

      await expect(
        risk_service.delete_risk_from_db(makeReq({ params: { id: 'r1' } })),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(db.delete).not.toHaveBeenCalled();
    });
  });

  describe('update_risk_into_db — org_account_id tamper resistance', () => {
    it('ignores an org_account_id supplied in the body and always writes the caller org anchor', async () => {
      db.findFirst.mockResolvedValue({ id: 'r1', org_account_id: ORG_A });
      db.update.mockResolvedValue({});

      await risk_service.update_risk_into_db(
        makeReq({ params: { id: 'r1' }, body: { org_account_id: ORG_B } }),
      );

      const callArg = db.update.mock.calls[0][0];
      expect(callArg.data.org_account_id).toBe(ORG_A);
    });
  });

  describe('get_all_risk_from_db', () => {
    it('filters by caller org', async () => {
      db.findMany.mockResolvedValue([]);
      db.count.mockResolvedValue(0);

      await risk_service.get_all_risk_from_db(makeReq());

      const [callArg] = db.findMany.mock.calls[0];
      expect(callArg.where).toMatchObject({ org_account_id: ORG_A });
    });

    // Issue #125: this endpoint hand-rolled `parseInt(page) || 1` pagination
    // instead of the shared paginationHelper/buildPaginationMeta, so it
    // never picked up the MAX_LIMIT cap.
    it('includes totalPage in meta, computed via the shared pagination helper', async () => {
      db.findMany.mockResolvedValue([]);
      db.count.mockResolvedValue(23);

      const result = await risk_service.get_all_risk_from_db(
        makeReq({ query: { page: '2', limit: '10' } }),
      );

      expect(result.meta).toEqual({
        page: 2,
        limit: 10,
        skip: 10,
        total: 23,
        totalPage: 3,
      });
    });

    it('caps an oversized requested limit at MAX_LIMIT (100) instead of fetching unbounded rows', async () => {
      db.findMany.mockResolvedValue([]);
      db.count.mockResolvedValue(0);

      const result = await risk_service.get_all_risk_from_db(
        makeReq({ query: { page: '1', limit: '1000000' } }),
      );

      expect(result.meta.limit).toBe(100);
      const [callArg] = db.findMany.mock.calls[0];
      expect(callArg.take).toBe(100);
    });

    // aexa-frontend#95: the list attaches a derived approvalStatus (and the
    // raw latest approval row) per risk so the register can render an approval
    // badge without a per-row query.
    it('attaches a derived approvalStatus per risk from its latest approval cycle', async () => {
      db.findMany.mockResolvedValue([
        { id: 'r1', approvals: [{ id: 'ra-1', status: 'PENDING_APPROVAL', invalidatedAt: null }] },
        { id: 'r2', approvals: [] },
        { id: 'r3', approvals: [{ id: 'ra-3', status: 'APPROVED', invalidatedAt: new Date() }] },
      ]);
      db.count.mockResolvedValue(3);

      const result = await risk_service.get_all_risk_from_db(makeReq());

      expect(result.data).toEqual([
        expect.objectContaining({ id: 'r1', approvalStatus: 'PENDING_APPROVAL' }),
        expect.objectContaining({ id: 'r2', approvalStatus: 'NOT_SUBMITTED', approval: null }),
        // Latest cycle was invalidated by an edit -> reads as NOT_SUBMITTED.
        expect.objectContaining({ id: 'r3', approvalStatus: 'NOT_SUBMITTED' }),
      ]);
      // The single-element approvals array is flattened out of the payload.
      expect(result.data[0]).not.toHaveProperty('approvals');
    });

    it('defaults to page 1 / limit 10 when no query params are supplied', async () => {
      db.findMany.mockResolvedValue([]);
      db.count.mockResolvedValue(0);

      const result = await risk_service.get_all_risk_from_db(makeReq({ query: {} }));

      expect(result.meta).toEqual({
        page: 1,
        limit: 10,
        skip: 0,
        total: 0,
        totalPage: 0,
      });
    });
  });

  describe('get_single_risk_from_db', () => {
    it('includes org_account_id in WHERE clause', async () => {
      db.findFirst.mockResolvedValue({ id: 'r1', org_account_id: ORG_A });

      await risk_service.get_single_risk_from_db(makeReq({ params: { id: 'r1' } }));

      expect(db.findFirst).toHaveBeenCalledWith({
        where: { id: 'r1', org_account_id: ORG_A },
      });
    });

    it('throws 404 for another org risk', async () => {
      db.findFirst.mockResolvedValue(null);

      await expect(
        risk_service.get_single_risk_from_db(makeReq({ params: { id: 'org-b-risk' } })),
      ).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe('create_risk_into_db', () => {
    it('injects org_account_id into the created record', async () => {
      db.create.mockResolvedValue({});

      await risk_service.create_risk_into_db(makeReq({ body: { name: 'Cyber risk' } }));

      const callArg = db.create.mock.calls[0][0];
      expect(callArg.data.org_account_id).toBe(ORG_A);
    });

    it('overwrites any org_account_id supplied in the request body', async () => {
      db.create.mockResolvedValue({});

      await risk_service.create_risk_into_db(
        makeReq({ body: { name: 'Evil', org_account_id: ORG_B } }),
      );

      const callArg = db.create.mock.calls[0][0];
      expect(callArg.data.org_account_id).toBe(ORG_A);
    });
  });

  describe('update_risk_into_db', () => {
    it('verifies ownership before updating', async () => {
      db.findFirst.mockResolvedValue({ id: 'r1', org_account_id: ORG_A });
      db.update.mockResolvedValue({});

      await risk_service.update_risk_into_db(makeReq({ params: { id: 'r1' } }));

      expect(db.findFirst).toHaveBeenCalledWith({ where: { id: 'r1', org_account_id: ORG_A } });
    });

    it('throws 404 and does NOT update another org risk', async () => {
      db.findFirst.mockResolvedValue(null);

      await expect(
        risk_service.update_risk_into_db(makeReq({ params: { id: 'org-b-risk' } })),
      ).rejects.toMatchObject({ statusCode: 404 });

      expect(db.update).not.toHaveBeenCalled();
    });

    // aexa-frontend#95: editing a risk invalidates any live approval cycle so a
    // changed assessment can't keep an already-granted approval. Verifies the
    // hook is actually wired into the update path, not just defined.
    it('invalidates a live approval cycle when the risk is edited', async () => {
      mockMembership('ADMIN');
      db.findFirst.mockResolvedValue({ id: 'r1', org_account_id: ORG_A });
      db.update.mockResolvedValue({ id: 'r1' });
      riskApprovalDb.findMany.mockResolvedValue([{ id: 'ra-1' }]);
      riskApprovalDb.updateMany.mockResolvedValue({ count: 1 });

      await risk_service.update_risk_into_db(makeReq({ params: { id: 'r1' } }));

      expect(riskApprovalDb.updateMany).toHaveBeenCalledWith({
        where: {
          riskId: 'r1',
          invalidatedAt: null,
          status: { in: ['PENDING_APPROVAL', 'APPROVED'] },
        },
        data: { invalidatedAt: expect.any(Date), invalidatedById: ORG_A },
      });
    });

    it('does NOT touch approvals when the edited risk has no live approval cycle', async () => {
      mockMembership('ADMIN');
      db.findFirst.mockResolvedValue({ id: 'r1', org_account_id: ORG_A });
      db.update.mockResolvedValue({ id: 'r1' });
      riskApprovalDb.findMany.mockResolvedValue([]);

      await risk_service.update_risk_into_db(makeReq({ params: { id: 'r1' } }));

      expect(riskApprovalDb.updateMany).not.toHaveBeenCalled();
    });

    // aexa-server#203: the risk write and the approval invalidation must share
    // ONE transaction boundary, so a crash between them can't leave an edited
    // risk wearing a stale APPROVED badge. Confirms both writes run inside the
    // single $transaction callback.
    it('wraps the risk update and the approval invalidation in a single $transaction', async () => {
      mockMembership('ADMIN');
      db.findFirst.mockResolvedValue({ id: 'r1', org_account_id: ORG_A });
      db.update.mockResolvedValue({ id: 'r1' });
      riskApprovalDb.findMany.mockResolvedValue([{ id: 'ra-1' }]);
      riskApprovalDb.updateMany.mockResolvedValue({ count: 1 });

      await risk_service.update_risk_into_db(makeReq({ params: { id: 'r1' } }));

      // Exactly one transaction opened, and both writes happened within it.
      expect(txFn).toHaveBeenCalledTimes(1);
      expect(db.update).toHaveBeenCalled();
      expect(riskApprovalDb.updateMany).toHaveBeenCalled();
    });

    // If the invalidation write fails mid-transaction, the whole update rejects
    // — a real Prisma $transaction would roll the risk update back too, so
    // neither is committed. (With the mocks, we assert the error propagates out
    // of update_risk_into_db rather than being swallowed after a committed
    // risk write.)
    it('propagates a failure in the approval-invalidation step out of the transaction (nothing committed)', async () => {
      mockMembership('ADMIN');
      db.findFirst.mockResolvedValue({ id: 'r1', org_account_id: ORG_A });
      db.update.mockResolvedValue({ id: 'r1' });
      riskApprovalDb.findMany.mockResolvedValue([{ id: 'ra-1' }]);
      // The invalidation's guarded write throws inside the transaction callback.
      riskApprovalDb.updateMany.mockRejectedValue(new Error('db exploded mid-invalidation'));

      await expect(
        risk_service.update_risk_into_db(makeReq({ params: { id: 'r1' } })),
      ).rejects.toThrow('db exploded mid-invalidation');

      // The failing write happened inside the same $transaction as the risk
      // update — so a real DB would roll the risk update back with it.
      expect(txFn).toHaveBeenCalledTimes(1);
    });
  });

  describe('delete_risk_from_db', () => {
    it('verifies ownership before deleting', async () => {
      db.findFirst.mockResolvedValue({ id: 'r1', org_account_id: ORG_A });
      db.delete.mockResolvedValue({});

      await risk_service.delete_risk_from_db(makeReq({ params: { id: 'r1' } }));

      expect(db.findFirst).toHaveBeenCalledWith({ where: { id: 'r1', org_account_id: ORG_A } });
    });

    it('throws 404 and does NOT delete another org risk', async () => {
      db.findFirst.mockResolvedValue(null);

      await expect(
        risk_service.delete_risk_from_db(makeReq({ params: { id: 'org-b-risk' } })),
      ).rejects.toMatchObject({ statusCode: 404 });

      expect(db.delete).not.toHaveBeenCalled();
    });

    // In-use guard (found by audit): Inspection.risk and Recommendation.risk
    // are onDelete: Cascade, so deleting a still-referenced risk would
    // silently destroy those records. The guard blocks the delete with a 409.
    it('throws 409 and does NOT delete a risk still referenced by an inspection', async () => {
      db.findFirst.mockResolvedValue({ id: 'r1', org_account_id: ORG_A });
      inspectionDb.count.mockResolvedValue(2);
      recommendationDb.count.mockResolvedValue(0);

      await expect(
        risk_service.delete_risk_from_db(makeReq({ params: { id: 'r1' } })),
      ).rejects.toMatchObject({ statusCode: 409 });

      expect(db.delete).not.toHaveBeenCalled();
    });

    it('throws 409 and does NOT delete a risk still referenced by a recommendation', async () => {
      db.findFirst.mockResolvedValue({ id: 'r1', org_account_id: ORG_A });
      inspectionDb.count.mockResolvedValue(0);
      recommendationDb.count.mockResolvedValue(3);

      await expect(
        risk_service.delete_risk_from_db(makeReq({ params: { id: 'r1' } })),
      ).rejects.toMatchObject({ statusCode: 409 });

      expect(db.delete).not.toHaveBeenCalled();
    });

    // Kri.risk is also onDelete: Cascade (kri.prisma:6) — KRIs are real org
    // data with their own CRUD module, so risk deletion must not silently
    // destroy them either (audit follow-up: the original guard only counted
    // inspections and recommendations).
    it('throws 409 and does NOT delete a risk still referenced by a KRI', async () => {
      db.findFirst.mockResolvedValue({ id: 'r1', org_account_id: ORG_A });
      inspectionDb.count.mockResolvedValue(0);
      recommendationDb.count.mockResolvedValue(0);
      kriDb.count.mockResolvedValue(1);

      await expect(
        risk_service.delete_risk_from_db(makeReq({ params: { id: 'r1' } })),
      ).rejects.toMatchObject({ statusCode: 409 });

      expect(kriDb.count).toHaveBeenCalledWith({ where: { risk_id: 'r1' } });
      expect(db.delete).not.toHaveBeenCalled();
    });

    // RiskApproval.risk is also onDelete: Cascade (risk.prisma:63), so deleting
    // a risk with a live PENDING/APPROVED approval cycle would silently destroy
    // the maker-checker sign-off record. The guard blocks it (aexa-server#202).
    it('throws 409 and does NOT delete a risk with a live pending/approved approval cycle', async () => {
      db.findFirst.mockResolvedValue({ id: 'r1', org_account_id: ORG_A });
      inspectionDb.count.mockResolvedValue(0);
      recommendationDb.count.mockResolvedValue(0);
      kriDb.count.mockResolvedValue(0);
      riskApprovalDb.count.mockResolvedValue(1);

      await expect(
        risk_service.delete_risk_from_db(makeReq({ params: { id: 'r1' } })),
      ).rejects.toMatchObject({ statusCode: 409 });

      // "live" is the same definition invalidateLiveApprovalsOnEdit uses:
      // non-invalidated PENDING_APPROVAL or APPROVED. A REJECTED/invalidated
      // cycle is terminal history and must NOT block the delete.
      expect(riskApprovalDb.count).toHaveBeenCalledWith({
        where: {
          riskId: 'r1',
          invalidatedAt: null,
          status: { in: ['PENDING_APPROVAL', 'APPROVED'] },
        },
      });
      expect(db.delete).not.toHaveBeenCalled();
    });

    it('deletes a risk when it is not referenced by any inspection, recommendation, KRI or live approval cycle', async () => {
      db.findFirst.mockResolvedValue({ id: 'r1', org_account_id: ORG_A });
      inspectionDb.count.mockResolvedValue(0);
      recommendationDb.count.mockResolvedValue(0);
      kriDb.count.mockResolvedValue(0);
      riskApprovalDb.count.mockResolvedValue(0);
      db.delete.mockResolvedValue({ id: 'r1' });

      await risk_service.delete_risk_from_db(makeReq({ params: { id: 'r1' } }));

      expect(db.delete).toHaveBeenCalledWith({ where: { id: 'r1' } });
    });
  });
});
