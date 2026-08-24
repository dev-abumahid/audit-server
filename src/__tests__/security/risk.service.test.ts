import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ORG_A, ORG_B, makeReq } from '../helpers/makeReq.js';

vi.mock('../../app/lib/prisma.js', () => ({
  prisma: {
    risk: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
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
    riskLineReview: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
      create: vi.fn(),
    },
    auditEngagementRisk: {
      count: vi.fn(),
    },
    complianceObligation: {
      count: vi.fn(),
    },
    riskLink: {
      deleteMany: vi.fn(),
      count: vi.fn(),
    },
    site: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
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
import { risk_validations } from '../../app/modules/risk/risk.validation.js';

const db = prisma.risk as unknown as Record<string, ReturnType<typeof vi.fn>>;
const inspectionDb = prisma.inspection as unknown as Record<string, ReturnType<typeof vi.fn>>;
const recommendationDb = prisma.recommendation as unknown as Record<
  string,
  ReturnType<typeof vi.fn>
>;
const kriDb = prisma.kri as unknown as Record<string, ReturnType<typeof vi.fn>>;
const riskApprovalDb = prisma.riskApproval as unknown as Record<string, ReturnType<typeof vi.fn>>;
const riskLineReviewDb = prisma.riskLineReview as unknown as Record<
  string,
  ReturnType<typeof vi.fn>
>;
const auditEngagementRiskDb = prisma.auditEngagementRisk as unknown as Record<
  string,
  ReturnType<typeof vi.fn>
>;
const riskLinkDb = prisma.riskLink as unknown as Record<string, ReturnType<typeof vi.fn>>;
const complianceObligationDb = prisma.complianceObligation as unknown as Record<
  string,
  ReturnType<typeof vi.fn>
>;
const siteDb = prisma.site as unknown as Record<string, ReturnType<typeof vi.fn>>;
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
    // Default (#97): invalidateLiveLineReviews's updateMany is a no-op call
    // on every edit unless a specific test asserts on it.
    riskLineReviewDb.updateMany.mockResolvedValue({ count: 0 });
    // Default: risk is not linked to any audit engagement, so the
    // aexa-frontend#165 audit-link delete guard is a no-op unless overridden.
    auditEngagementRiskDb.count.mockResolvedValue(0);
    // Default: no RiskLink rows reference this risk's ref, so the
    // aexa-frontend#25 dangling-link cleanup on delete is a no-op unless a
    // test overrides it.
    riskLinkDb.deleteMany.mockResolvedValue({ count: 0 });
    // Default: no in-use references for the dismiss warning (design doc
    // ai-risk-review-approval-workflow.md) unless a test overrides it.
    riskLinkDb.count.mockResolvedValue(0);
    complianceObligationDb.count.mockResolvedValue(0);
    // Default (aexa-server#347): a plausible site for EBITDA-at-risk
    // resolution so tests unrelated to that feature don't have to know
    // about it. Individual ebitda tests override this per-case.
    siteDb.findFirst.mockResolvedValue({
      id: 'site-1',
      revenue: 1000000,
      activity: 'Industrial chemical manufacturing and storage',
    });
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

  describe('get_ebitda_at_risk_summary (#347)', () => {
    it('scopes both the risk and site reads to the caller org', async () => {
      db.findMany.mockResolvedValue([]);
      siteDb.findMany.mockResolvedValue([]);

      await risk_service.get_ebitda_at_risk_summary(makeReq());

      expect(db.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { org_account_id: ORG_A, review_status: 'APPROVED', supersededAt: null },
        }),
      );
      expect(siteDb.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { org_account_id: ORG_A } }),
      );
    });

    it('filters out risks with no computed ebitda_at_risk (missing probability/impact) from the distribution', async () => {
      db.findMany.mockResolvedValue([
        { ebitda_at_risk: 1000 },
        { ebitda_at_risk: null },
        { ebitda_at_risk: 2000 },
      ]);
      siteDb.findMany.mockResolvedValue([]);

      const result = await risk_service.get_ebitda_at_risk_summary(makeReq());

      expect(result.risksTotal).toBe(3);
      expect(result.risksWithData).toBe(2);
    });

    it("sums each site's own estimated EBITDA (revenue x its matched sector margin) into totalEstimatedEbitda", async () => {
      db.findMany.mockResolvedValue([]);
      siteDb.findMany.mockResolvedValue([
        { revenue: 1_000_000, activity: 'Industrial chemical manufacturing and storage' }, // CHEMICAL_BASIC 0.1234
        { revenue: 2_000_000, activity: 'Hospital and clinic operations' }, // HOSPITALS_HEALTHCARE 0.158
      ]);

      const result = await risk_service.get_ebitda_at_risk_summary(makeReq());

      expect(result.totalEstimatedEbitda).toBe(1_000_000 * 0.1234 + 2_000_000 * 0.158);
    });

    it('treats a site with no revenue as contributing 0, not throwing', async () => {
      db.findMany.mockResolvedValue([]);
      siteDb.findMany.mockResolvedValue([{ revenue: 0, activity: 'Chemical plant' }]);

      const result = await risk_service.get_ebitda_at_risk_summary(makeReq());

      expect(result.totalEstimatedEbitda).toBe(0);
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
        include: { site: { select: { id: true, name: true } } },
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
    // aexa-frontend#142: create_risk_into_db now generates a `ref` via
    // computeNextRiskRef, which reads existing refs for the category's
    // prefix (db.findMany) before creating. Every body below needs a
    // `category`, and db.findMany needs a mock, for the same reason.
    beforeEach(() => {
      db.findMany.mockResolvedValue([]);
    });

    it('injects org_account_id into the created record', async () => {
      db.create.mockResolvedValue({});

      await risk_service.create_risk_into_db(
        makeReq({ body: { name: 'Cyber risk', category: 'Cyber' } }),
      );

      const callArg = db.create.mock.calls[0][0];
      expect(callArg.data.org_account_id).toBe(ORG_A);
    });

    it('overwrites any org_account_id supplied in the request body', async () => {
      db.create.mockResolvedValue({});

      await risk_service.create_risk_into_db(
        makeReq({ body: { name: 'Evil', category: 'Cyber', org_account_id: ORG_B } }),
      );

      const callArg = db.create.mock.calls[0][0];
      expect(callArg.data.org_account_id).toBe(ORG_A);
    });

    it('generates a ref from the category prefix and includes it in the create call', async () => {
      db.create.mockResolvedValue({});

      await risk_service.create_risk_into_db(
        makeReq({ body: { name: 'Cyber risk', category: 'Cyber' } }),
      );

      const callArg = db.create.mock.calls[0][0];
      expect(callArg.data.ref).toBe('CYB-001');
    });

    it('continues the per-org-per-category sequence from existing refs', async () => {
      db.findMany.mockResolvedValue([{ ref: 'CYB-001' }, { ref: 'CYB-002' }]);
      db.create.mockResolvedValue({});

      await risk_service.create_risk_into_db(
        makeReq({ body: { name: 'Cyber risk', category: 'Cyber' } }),
      );

      const callArg = db.create.mock.calls[0][0];
      expect(callArg.data.ref).toBe('CYB-003');
    });

    // aexa-server#241: residual_score is derived from inherent_score +
    // control effectiveness on create, not just whatever the client sent.
    describe('residual_score derivation (#241)', () => {
      it('derives residual_score from inherent_score and control effectiveness, ignoring any client-supplied value', async () => {
        db.create.mockResolvedValue({});

        await risk_service.create_risk_into_db(
          makeReq({
            body: {
              name: 'Cyber risk',
              category: 'Cyber',
              inherent_score: 100,
              control_design_eff: 80,
              control_operating_eff: 80,
              residual_score: 999, // must be ignored — no override requested
            },
          }),
        );

        const callArg = db.create.mock.calls[0][0];
        expect(callArg.data.residual_score).toBe(36);
        expect(callArg.data.residual_is_override).toBe(false);
      });

      it('defaults residual_score to inherent_score when control effectiveness is not yet assessed', async () => {
        db.create.mockResolvedValue({});

        await risk_service.create_risk_into_db(
          makeReq({ body: { name: 'Cyber risk', category: 'Cyber', inherent_score: 72 } }),
        );

        const callArg = db.create.mock.calls[0][0];
        expect(callArg.data.residual_score).toBe(72);
      });

      it('accepts a valid manual override, tracking who set it and why', async () => {
        db.create.mockResolvedValue({});

        await risk_service.create_risk_into_db(
          makeReq({
            body: {
              name: 'Cyber risk',
              category: 'Cyber',
              inherent_score: 100,
              control_design_eff: 80,
              control_operating_eff: 80,
              residual_override: true,
              residual_score: 50,
              residual_override_reason: 'board-directed figure',
            },
          }),
        );

        const callArg = db.create.mock.calls[0][0];
        expect(callArg.data).toMatchObject({
          residual_score: 50,
          residual_is_override: true,
          residual_override_reason: 'board-directed figure',
          residual_overridden_by: ORG_A,
        });
        expect(callArg.data.residual_override).toBeUndefined();
      });

      it('rejects an override request without a reason with a 400', async () => {
        await expect(
          risk_service.create_risk_into_db(
            makeReq({
              body: {
                name: 'Cyber risk',
                category: 'Cyber',
                residual_override: true,
                residual_score: 50,
              },
            }),
          ),
        ).rejects.toMatchObject({ statusCode: 400 });

        expect(db.create).not.toHaveBeenCalled();
      });
    });

    // aexa-server#247: inherent_score is derived from probability x impact on
    // create, resolved BEFORE residual_score so residual sees the freshly
    // derived value, not the raw client-supplied one.
    describe('inherent_score derivation (#247)', () => {
      it('derives inherent_score from probability and impact, ignoring any client-supplied value', async () => {
        db.create.mockResolvedValue({});

        await risk_service.create_risk_into_db(
          makeReq({
            body: {
              name: 'Cyber risk',
              category: 'Cyber',
              probability: 60,
              impact: 80,
              inherent_score: 999, // must be ignored — no override requested
            },
          }),
        );

        const callArg = db.create.mock.calls[0][0];
        expect(callArg.data.inherent_score).toBe(48);
        expect(callArg.data.inherent_is_override).toBe(false);
      });

      it('falls back to the raw inherent_score when probability/impact are not both supplied', async () => {
        db.create.mockResolvedValue({});

        await risk_service.create_risk_into_db(
          makeReq({ body: { name: 'Cyber risk', category: 'Cyber', inherent_score: 72 } }),
        );

        const callArg = db.create.mock.calls[0][0];
        expect(callArg.data.inherent_score).toBe(72);
      });

      it('feeds the derived inherent_score (not the raw one) into the residual_score calculation', async () => {
        db.create.mockResolvedValue({});

        await risk_service.create_risk_into_db(
          makeReq({
            body: {
              name: 'Cyber risk',
              category: 'Cyber',
              probability: 60,
              impact: 80, // derives inherent_score = 48
              inherent_score: 10, // must be overridden by the derivation above
              control_design_eff: 80,
              control_operating_eff: 80, // control_eff = 0.64
            },
          }),
        );

        const callArg = db.create.mock.calls[0][0];
        expect(callArg.data.inherent_score).toBe(48);
        // 48 x (1 - 0.64) = 17.28 -> rounds to 17
        expect(callArg.data.residual_score).toBe(17);
      });

      it('accepts a valid manual override, tracking who set it and why', async () => {
        db.create.mockResolvedValue({});

        await risk_service.create_risk_into_db(
          makeReq({
            body: {
              name: 'Cyber risk',
              category: 'Cyber',
              probability: 60,
              impact: 80,
              inherent_override: true,
              inherent_score: 90,
              inherent_override_reason: 'board-directed figure',
            },
          }),
        );

        const callArg = db.create.mock.calls[0][0];
        expect(callArg.data).toMatchObject({
          inherent_score: 90,
          inherent_is_override: true,
          inherent_override_reason: 'board-directed figure',
          inherent_overridden_by: ORG_A,
        });
        expect(callArg.data.inherent_override).toBeUndefined();
      });

      it('rejects an override request without a reason with a 400', async () => {
        await expect(
          risk_service.create_risk_into_db(
            makeReq({
              body: {
                name: 'Cyber risk',
                category: 'Cyber',
                inherent_override: true,
                inherent_score: 90,
              },
            }),
          ),
        ).rejects.toMatchObject({ statusCode: 400 });

        expect(db.create).not.toHaveBeenCalled();
      });
    });

    // aexa-server#347: EBITDA-at-risk is derived from the risk's Site
    // (revenue/activity) + probability/impact on create, per the CEO's
    // formula.
    describe('EBITDA-at-risk derivation (#347)', () => {
      it('looks up the site scoped to the caller org and derives ebitda_at_risk + benchmark fields', async () => {
        siteDb.findFirst.mockResolvedValue({
          id: 'site-1',
          revenue: 2_000_000,
          activity: 'Hospital and clinic operations',
        });
        db.create.mockResolvedValue({});

        await risk_service.create_risk_into_db(
          makeReq({
            body: {
              name: 'Compliance risk',
              category: 'Compliance',
              site_id: 'site-1',
              probability: 50,
              impact: 80,
            },
          }),
        );

        expect(siteDb.findFirst).toHaveBeenCalledWith({
          where: { id: 'site-1', org_account_id: ORG_A },
        });
        const callArg = db.create.mock.calls[0][0];
        expect(callArg.data.ebitda_benchmark_sector).toBe('HOSPITALS_HEALTHCARE');
        expect(callArg.data.ebitda_at_risk).toBe(Math.round(2_000_000 * 0.158 * 0.5 * 0.8));
        expect(callArg.data.ebitda_is_override).toBe(false);
      });

      it('throws 404 when the referenced site does not belong to the caller org (never trusts a cross-org site_id)', async () => {
        siteDb.findFirst.mockResolvedValue(null);

        await expect(
          risk_service.create_risk_into_db(
            makeReq({ body: { name: 'Risk', category: 'Cyber', site_id: 'other-org-site' } }),
          ),
        ).rejects.toMatchObject({ statusCode: 404 });

        expect(db.create).not.toHaveBeenCalled();
      });

      it('honors a valid ebitda_override on create', async () => {
        db.create.mockResolvedValue({});

        await risk_service.create_risk_into_db(
          makeReq({
            body: {
              name: 'Risk',
              category: 'Cyber',
              probability: 50,
              impact: 80,
              ebitda_override: true,
              ebitda_override_margin: 0.25,
              ebitda_override_reason: 'Real audited EBITDA margin',
            },
          }),
        );

        const callArg = db.create.mock.calls[0][0];
        expect(callArg.data.ebitda_is_override).toBe(true);
        expect(callArg.data.ebitda_benchmark_margin).toBe(0.25);
        expect(callArg.data.ebitda_override).toBeUndefined();
        expect(callArg.data.ebitda_override_margin).toBeUndefined();
      });

      it('rejects an invalid ebitda_override request with 400 and does not create the risk', async () => {
        await expect(
          risk_service.create_risk_into_db(
            makeReq({
              body: { name: 'Risk', category: 'Cyber', ebitda_override: true },
            }),
          ),
        ).rejects.toMatchObject({ statusCode: 400 });

        expect(db.create).not.toHaveBeenCalled();
      });
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

  // aexa-server#241: residual_score recalculates on edit whenever one of its
  // inputs changes, and an existing manual override survives an unrelated
  // edit (going stale rather than being silently discarded or recomputed).
  describe('update_risk_into_db — residual_score derivation (#241)', () => {
    it('recomputes residual_score when control effectiveness changes, using stored values for fields not in the request', async () => {
      db.findFirst.mockResolvedValue({
        id: 'r1',
        org_account_id: ORG_A,
        inherent_score: 100,
        control_design_eff: 80,
        control_operating_eff: 80,
        residual_score: 36,
        residual_is_override: false,
      });
      db.update.mockResolvedValue({ id: 'r1' });

      await risk_service.update_risk_into_db(
        makeReq({ params: { id: 'r1' }, body: { control_design_eff: 100 } }),
      );

      const callArg = db.update.mock.calls[0][0];
      // 100 x (1 - 1.0*0.8) = 20
      expect(callArg.data.residual_score).toBe(20);
      expect(callArg.data.residual_is_override).toBe(false);
    });

    it('leaves an existing override untouched when the edit does not touch its inputs', async () => {
      db.findFirst.mockResolvedValue({
        id: 'r1',
        org_account_id: ORG_A,
        inherent_score: 100,
        control_design_eff: 80,
        control_operating_eff: 80,
        residual_score: 50,
        residual_is_override: true,
        residual_override_reason: 'board-directed figure',
        residual_overridden_by: 'someone-else',
        residual_overridden_at: new Date('2026-01-01'),
      });
      db.update.mockResolvedValue({ id: 'r1' });

      await risk_service.update_risk_into_db(
        makeReq({ params: { id: 'r1' }, body: { name: 'Renamed risk' } }),
      );

      const callArg = db.update.mock.calls[0][0];
      expect(callArg.data).toMatchObject({
        residual_score: 50,
        residual_is_override: true,
        residual_override_stale: false,
      });
    });

    it('marks an existing override stale when inherent_score changes without re-confirming the override', async () => {
      db.findFirst.mockResolvedValue({
        id: 'r1',
        org_account_id: ORG_A,
        inherent_score: 100,
        control_design_eff: 80,
        control_operating_eff: 80,
        residual_score: 50,
        residual_is_override: true,
        residual_override_reason: 'board-directed figure',
        residual_overridden_by: 'someone-else',
        residual_overridden_at: new Date('2026-01-01'),
      });
      db.update.mockResolvedValue({ id: 'r1' });

      await risk_service.update_risk_into_db(
        makeReq({ params: { id: 'r1' }, body: { inherent_score: 90 } }),
      );

      const callArg = db.update.mock.calls[0][0];
      // The override value survives — it is NOT silently recomputed or dropped.
      expect(callArg.data).toMatchObject({
        residual_score: 50,
        residual_is_override: true,
        residual_override_stale: true,
      });
    });

    it('rejects an override request without a reason with a 400, leaving the risk unmodified', async () => {
      db.findFirst.mockResolvedValue({ id: 'r1', org_account_id: ORG_A, inherent_score: 100 });

      await expect(
        risk_service.update_risk_into_db(
          makeReq({
            params: { id: 'r1' },
            body: { residual_override: true, residual_score: 40 },
          }),
        ),
      ).rejects.toMatchObject({ statusCode: 400 });

      expect(db.update).not.toHaveBeenCalled();
    });

    it('keeps an override stale on a later, unrelated edit instead of silently clearing the flag', async () => {
      db.findFirst.mockResolvedValue({
        id: 'r1',
        org_account_id: ORG_A,
        inherent_score: 100,
        control_design_eff: 80,
        control_operating_eff: 80,
        residual_score: 50,
        residual_is_override: true,
        residual_override_reason: 'board-directed figure',
        residual_overridden_by: 'someone-else',
        residual_overridden_at: new Date('2026-01-01'),
        // Already marked stale by a prior edit — this request's own delta
        // is empty (no residual-affecting field is changing here).
        residual_override_stale: true,
      });
      db.update.mockResolvedValue({ id: 'r1' });

      await risk_service.update_risk_into_db(
        makeReq({ params: { id: 'r1' }, body: { name: 'Renamed again' } }),
      );

      const callArg = db.update.mock.calls[0][0];
      expect(callArg.data).toMatchObject({ residual_score: 50, residual_override_stale: true });
    });

    // aexa-server#241: residual_score is now derived/written on every update,
    // so the fields it's derived FROM must be re-read inside the same
    // transaction as the write — otherwise a concurrent edit committed
    // between the initial ownership check and this transaction could be
    // clobbered by a residual_score computed from a stale pre-transaction
    // snapshot.
    it('re-reads the row inside the transaction (via tx.risk.findFirst) rather than reusing the pre-transaction snapshot', async () => {
      db.findFirst.mockResolvedValue({
        id: 'r1',
        org_account_id: ORG_A,
        inherent_score: 100,
        control_design_eff: 80,
        control_operating_eff: 80,
        residual_score: 36,
        residual_is_override: false,
      });
      db.update.mockResolvedValue({ id: 'r1' });

      await risk_service.update_risk_into_db(makeReq({ params: { id: 'r1' }, body: {} }));

      // Called once for the outer ownership/404 check, once inside the
      // transaction for the fresh residual-inputs read.
      expect(db.findFirst).toHaveBeenCalledTimes(2);
      expect(db.findFirst.mock.calls[1][0]).toEqual({ where: { id: 'r1' } });
    });
  });

  describe('update_risk_into_db — inherent_score derivation (#247)', () => {
    it('recomputes inherent_score when probability/impact changes, and feeds it into residual_score', async () => {
      db.findFirst.mockResolvedValue({
        id: 'r1',
        org_account_id: ORG_A,
        probability: 60,
        impact: 80,
        inherent_score: 48,
        inherent_is_override: false,
        control_design_eff: 80,
        control_operating_eff: 80,
        residual_score: 17,
        residual_is_override: false,
      });
      db.update.mockResolvedValue({ id: 'r1' });

      await risk_service.update_risk_into_db(
        makeReq({ params: { id: 'r1' }, body: { impact: 100 } }),
      );

      const callArg = db.update.mock.calls[0][0];
      // 60 x 100 / 100 = 60 -> residual: 60 x (1 - 0.64) = 21.6 -> 22
      expect(callArg.data.inherent_score).toBe(60);
      expect(callArg.data.residual_score).toBe(22);
    });

    it('leaves an existing inherent_score override untouched when the edit does not touch its inputs', async () => {
      db.findFirst.mockResolvedValue({
        id: 'r1',
        org_account_id: ORG_A,
        probability: 60,
        impact: 80,
        inherent_score: 90,
        inherent_is_override: true,
        inherent_override_reason: 'board-directed figure',
        inherent_overridden_by: 'someone-else',
        inherent_overridden_at: new Date('2026-01-01'),
      });
      db.update.mockResolvedValue({ id: 'r1' });

      await risk_service.update_risk_into_db(
        makeReq({ params: { id: 'r1' }, body: { name: 'Renamed risk' } }),
      );

      const callArg = db.update.mock.calls[0][0];
      expect(callArg.data).toMatchObject({
        inherent_score: 90,
        inherent_is_override: true,
        inherent_override_stale: false,
      });
    });

    it('marks an existing inherent_score override stale when probability changes without re-confirming it', async () => {
      db.findFirst.mockResolvedValue({
        id: 'r1',
        org_account_id: ORG_A,
        probability: 60,
        impact: 80,
        inherent_score: 90,
        inherent_is_override: true,
        inherent_override_reason: 'board-directed figure',
        inherent_overridden_by: 'someone-else',
        inherent_overridden_at: new Date('2026-01-01'),
      });
      db.update.mockResolvedValue({ id: 'r1' });

      await risk_service.update_risk_into_db(
        makeReq({ params: { id: 'r1' }, body: { probability: 40 } }),
      );

      const callArg = db.update.mock.calls[0][0];
      expect(callArg.data).toMatchObject({ inherent_score: 90, inherent_override_stale: true });
    });

    it('rejects an override request without a reason with a 400, leaving the risk unmodified', async () => {
      db.findFirst.mockResolvedValue({ id: 'r1', org_account_id: ORG_A });

      await expect(
        risk_service.update_risk_into_db(
          makeReq({
            params: { id: 'r1' },
            body: { inherent_override: true, inherent_score: 90 },
          }),
        ),
      ).rejects.toMatchObject({ statusCode: 400 });

      expect(db.update).not.toHaveBeenCalled();
    });
  });

  describe('update_risk_into_db — EBITDA-at-risk derivation (#347)', () => {
    beforeEach(() => {
      siteDb.findFirst.mockResolvedValue({
        id: 'site-1',
        revenue: 1_000_000,
        activity: 'Industrial chemical manufacturing and storage',
      });
    });

    it('re-reads the effective site inside the transaction and recomputes ebitda_at_risk', async () => {
      db.findFirst.mockResolvedValue({
        id: 'r1',
        org_account_id: ORG_A,
        site_id: 'site-1',
        probability: 40,
        impact: 60,
        ebitda_is_override: false,
      });
      db.update.mockResolvedValue({ id: 'r1' });

      await risk_service.update_risk_into_db(
        makeReq({ params: { id: 'r1' }, body: { probability: 90 } }),
      );

      expect(siteDb.findFirst).toHaveBeenCalledWith({
        where: { id: 'site-1', org_account_id: ORG_A },
      });
      const callArg = db.update.mock.calls[0][0];
      expect(callArg.data.ebitda_at_risk).toBe(Math.round(1_000_000 * 0.1234 * 0.9 * 0.6));
      expect(callArg.data.ebitda_benchmark_sector).toBe('CHEMICAL_BASIC');
    });

    it("throws 404 when the risk's site no longer resolves within the caller org", async () => {
      db.findFirst.mockResolvedValue({
        id: 'r1',
        org_account_id: ORG_A,
        site_id: 'deleted-site',
        probability: 40,
        impact: 60,
      });
      siteDb.findFirst.mockResolvedValue(null);

      await expect(
        risk_service.update_risk_into_db(
          makeReq({ params: { id: 'r1' }, body: { probability: 90 } }),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });

      expect(db.update).not.toHaveBeenCalled();
    });

    it('leaves an existing ebitda override untouched when the edit does not change its tracked inputs', async () => {
      db.findFirst.mockResolvedValue({
        id: 'r1',
        org_account_id: ORG_A,
        site_id: 'site-1',
        probability: 40,
        impact: 60,
        ebitda_at_risk: Math.round(1_000_000 * 0.3 * 0.4 * 0.6),
        ebitda_benchmark_sector: 'CHEMICAL_BASIC',
        ebitda_benchmark_margin: 0.3,
        ebitda_is_override: true,
        ebitda_override_reason: 'audited',
        ebitda_overridden_by: 'someone-else',
        ebitda_overridden_at: new Date('2026-01-01'),
        ebitda_override_stale: false,
      });
      db.update.mockResolvedValue({ id: 'r1' });

      await risk_service.update_risk_into_db(
        makeReq({ params: { id: 'r1' }, body: { name: 'Renamed risk' } }),
      );

      const callArg = db.update.mock.calls[0][0];
      expect(callArg.data.ebitda_is_override).toBe(true);
      expect(callArg.data.ebitda_benchmark_margin).toBe(0.3);
      expect(callArg.data.ebitda_override_stale).toBe(false);
    });

    it('flags an existing ebitda override stale when probability changes without re-confirming it', async () => {
      db.findFirst.mockResolvedValue({
        id: 'r1',
        org_account_id: ORG_A,
        site_id: 'site-1',
        probability: 40,
        impact: 60,
        ebitda_at_risk: Math.round(1_000_000 * 0.3 * 0.4 * 0.6),
        ebitda_benchmark_sector: 'CHEMICAL_BASIC',
        ebitda_benchmark_margin: 0.3,
        ebitda_is_override: true,
        ebitda_override_reason: 'audited',
        ebitda_overridden_by: 'someone-else',
        ebitda_overridden_at: new Date('2026-01-01'),
        ebitda_override_stale: false,
      });
      db.update.mockResolvedValue({ id: 'r1' });

      await risk_service.update_risk_into_db(
        makeReq({ params: { id: 'r1' }, body: { probability: 95 } }),
      );

      const callArg = db.update.mock.calls[0][0];
      expect(callArg.data.ebitda_is_override).toBe(true);
      expect(callArg.data.ebitda_override_stale).toBe(true);
    });

    it('rejects an invalid ebitda_override update with 400 and does not write', async () => {
      db.findFirst.mockResolvedValue({
        id: 'r1',
        org_account_id: ORG_A,
        site_id: 'site-1',
        probability: 40,
        impact: 60,
      });

      await expect(
        risk_service.update_risk_into_db(
          makeReq({ params: { id: 'r1' }, body: { ebitda_override: true } }),
        ),
      ).rejects.toMatchObject({ statusCode: 400 });

      expect(db.update).not.toHaveBeenCalled();
    });
  });

  // Issue #97: Three Lines of Defense classification. update_risk_into_db
  // already gates its entire payload with assertCanWriteOrgResource (ADMIN /
  // LEAD_AUDITOR only) — these tests confirm line_of_defense specifically
  // rides that same existing gate rather than slipping through some other
  // path, and that it's actually persisted when the write is allowed.
  describe('update_risk_into_db — line_of_defense (#97)', () => {
    it('LIGHT_USER cannot reassign line_of_defense', async () => {
      mockMembership('LIGHT_USER');
      db.findFirst.mockResolvedValue({ id: 'r1', org_account_id: ORG_A });

      await expect(
        risk_service.update_risk_into_db(
          makeReq({ params: { id: 'r1' }, body: { line_of_defense: 'SECOND' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(db.update).not.toHaveBeenCalled();
    });

    it('VIEWER cannot reassign line_of_defense', async () => {
      mockMembership('VIEWER');
      db.findFirst.mockResolvedValue({ id: 'r1', org_account_id: ORG_A });

      await expect(
        risk_service.update_risk_into_db(
          makeReq({ params: { id: 'r1' }, body: { line_of_defense: 'THIRD' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(db.update).not.toHaveBeenCalled();
    });

    it('ADMIN can reassign line_of_defense', async () => {
      mockMembership('ADMIN');
      db.findFirst.mockResolvedValue({ id: 'r1', org_account_id: ORG_A });
      db.update.mockResolvedValue({ id: 'r1', line_of_defense: 'SECOND' });

      await risk_service.update_risk_into_db(
        makeReq({ params: { id: 'r1' }, body: { line_of_defense: 'SECOND' } }),
      );

      const callArg = db.update.mock.calls[0][0];
      expect(callArg.data.line_of_defense).toBe('SECOND');
    });

    // aexa-frontend#208: third-line independence — a LEAD_AUDITOR (third
    // line) must not be able to reclassify a first/second-line entity's
    // (Risk's) ownership. Only ADMIN may reassign Risk.line_of_defense now.
    it('LEAD_AUDITOR cannot reassign line_of_defense (third-line independence)', async () => {
      mockMembership('LEAD_AUDITOR');
      db.findFirst.mockResolvedValue({ id: 'r1', org_account_id: ORG_A });

      await expect(
        risk_service.update_risk_into_db(
          makeReq({ params: { id: 'r1' }, body: { line_of_defense: 'THIRD' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(db.update).not.toHaveBeenCalled();
    });

    it('LEAD_AUDITOR can still update other fields on the same request as long as line_of_defense is untouched', async () => {
      mockMembership('LEAD_AUDITOR');
      db.findFirst.mockResolvedValue({ id: 'r1', org_account_id: ORG_A });
      db.update.mockResolvedValue({ id: 'r1', name: 'Renamed' });

      await risk_service.update_risk_into_db(
        makeReq({ params: { id: 'r1' }, body: { name: 'Renamed' } }),
      );

      expect(db.update).toHaveBeenCalled();
    });

    // aexa-frontend#208: GOVERNING_BODY is a real, persistable value, not
    // just a permission-gate branch — round-trips end-to-end through
    // validation -> service -> Prisma the same as FIRST/SECOND/THIRD.
    it('ADMIN can reassign line_of_defense to the new GOVERNING_BODY value', async () => {
      mockMembership('ADMIN');
      db.findFirst.mockResolvedValue({ id: 'r1', org_account_id: ORG_A });
      db.update.mockResolvedValue({ id: 'r1', line_of_defense: 'GOVERNING_BODY' });

      await risk_service.update_risk_into_db(
        makeReq({ params: { id: 'r1' }, body: { line_of_defense: 'GOVERNING_BODY' } }),
      );

      const callArg = db.update.mock.calls[0][0];
      expect(callArg.data.line_of_defense).toBe('GOVERNING_BODY');
    });
  });

  describe('record_risk_line_review (#97)', () => {
    it('throws 404 and does not record a review for another org risk', async () => {
      db.findFirst.mockResolvedValue(null);

      await expect(
        risk_service.record_risk_line_review(
          makeReq({ params: { id: 'org-b-risk' }, body: { line: 'SECOND' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });

      expect(riskLineReviewDb.create).not.toHaveBeenCalled();
    });

    it('LEAD_AUDITOR can record a THIRD-line review (audit-line self-check)', async () => {
      mockMembership('LEAD_AUDITOR');
      db.findFirst.mockResolvedValue({ id: 'r1', org_account_id: ORG_A });
      riskLineReviewDb.create.mockResolvedValue({ id: 'rev-1' });
      riskLineReviewDb.findMany.mockResolvedValue([{ id: 'rev-1', line: 'THIRD' }]);

      await risk_service.record_risk_line_review(
        makeReq({ params: { id: 'r1' }, body: { line: 'THIRD' } }),
      );

      expect(riskLineReviewDb.create).toHaveBeenCalled();
    });

    // Third-line independence, same split as ownership reassignment
    // (aexa-frontend#208): a LEAD_AUDITOR may vouch for THIRD-line review,
    // but not for FIRST/SECOND/GOVERNING_BODY -- those are management-line
    // judgment calls.
    it('LEAD_AUDITOR cannot record a SECOND-line review', async () => {
      mockMembership('LEAD_AUDITOR');
      db.findFirst.mockResolvedValue({ id: 'r1', org_account_id: ORG_A });

      await expect(
        risk_service.record_risk_line_review(
          makeReq({ params: { id: 'r1' }, body: { line: 'SECOND' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(riskLineReviewDb.create).not.toHaveBeenCalled();
    });

    it('ADMIN can record a FIRST-line review', async () => {
      mockMembership('ADMIN');
      db.findFirst.mockResolvedValue({ id: 'r1', org_account_id: ORG_A });
      riskLineReviewDb.create.mockResolvedValue({ id: 'rev-2' });
      riskLineReviewDb.findMany.mockResolvedValue([{ id: 'rev-2', line: 'FIRST' }]);

      await risk_service.record_risk_line_review(
        makeReq({ params: { id: 'r1' }, body: { line: 'FIRST' } }),
      );

      expect(riskLineReviewDb.create).toHaveBeenCalled();
    });

    it('ADMIN cannot record a THIRD-line review (audit independence -- management cannot vouch for audit)', async () => {
      mockMembership('ADMIN');
      db.findFirst.mockResolvedValue({ id: 'r1', org_account_id: ORG_A });

      await expect(
        risk_service.record_risk_line_review(
          makeReq({ params: { id: 'r1' }, body: { line: 'THIRD' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(riskLineReviewDb.create).not.toHaveBeenCalled();
    });

    // A fresh review for the same line supersedes (invalidates) the prior
    // live one rather than stacking duplicates -- see
    // line_of_defense_review.ts's recordLineReview.
    it('invalidates the prior live review for the same line before creating the new one', async () => {
      mockMembership('ADMIN');
      db.findFirst.mockResolvedValue({ id: 'r1', org_account_id: ORG_A });
      riskLineReviewDb.create.mockResolvedValue({ id: 'rev-3' });
      riskLineReviewDb.findMany.mockResolvedValue([{ id: 'rev-3', line: 'FIRST' }]);

      await risk_service.record_risk_line_review(
        makeReq({ params: { id: 'r1' }, body: { line: 'FIRST', notes: 'looks fine' } }),
      );

      expect(riskLineReviewDb.updateMany).toHaveBeenCalledWith({
        where: { riskId: 'r1', line: 'FIRST', invalidatedAt: null },
        data: { invalidatedAt: expect.any(Date) },
      });
      expect(riskLineReviewDb.create).toHaveBeenCalledWith({
        data: { riskId: 'r1', line: 'FIRST', reviewedById: ORG_A, notes: 'looks fine' },
      });
    });

    it('editing a risk invalidates every live line review -- the reviewed version is now stale', async () => {
      mockMembership('ADMIN');
      db.findFirst.mockResolvedValue({ id: 'r1', org_account_id: ORG_A });
      db.update.mockResolvedValue({ id: 'r1', name: 'Renamed' });

      await risk_service.update_risk_into_db(
        makeReq({ params: { id: 'r1' }, body: { name: 'Renamed' } }),
      );

      expect(riskLineReviewDb.updateMany).toHaveBeenCalledWith({
        where: { riskId: 'r1', invalidatedAt: null },
        data: { invalidatedAt: expect.any(Date) },
      });
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

    // AuditEngagementRisk.risk is onDelete: Cascade (aexa-frontend#165), so
    // deleting a risk still linked to an audit engagement would silently tear
    // down that audit↔risk association — meaningful audit-trail data answering
    // "which audits touch this risk". The guard blocks it with a 409, the same
    // conservative philosophy as the other in-use counts. The caller must
    // unlink the risk from its engagements first.
    it('throws 409 and does NOT delete a risk still linked to an audit engagement', async () => {
      db.findFirst.mockResolvedValue({ id: 'r1', org_account_id: ORG_A });
      inspectionDb.count.mockResolvedValue(0);
      recommendationDb.count.mockResolvedValue(0);
      kriDb.count.mockResolvedValue(0);
      riskApprovalDb.count.mockResolvedValue(0);
      auditEngagementRiskDb.count.mockResolvedValue(2);

      await expect(
        risk_service.delete_risk_from_db(makeReq({ params: { id: 'r1' } })),
      ).rejects.toMatchObject({ statusCode: 409 });

      expect(auditEngagementRiskDb.count).toHaveBeenCalledWith({ where: { riskId: 'r1' } });
      expect(db.delete).not.toHaveBeenCalled();
    });

    it('deletes a risk when it is not referenced by any inspection, recommendation, KRI, live approval cycle or audit engagement link', async () => {
      db.findFirst.mockResolvedValue({ id: 'r1', org_account_id: ORG_A, ref: 'RSK-001' });
      inspectionDb.count.mockResolvedValue(0);
      recommendationDb.count.mockResolvedValue(0);
      kriDb.count.mockResolvedValue(0);
      riskApprovalDb.count.mockResolvedValue(0);
      auditEngagementRiskDb.count.mockResolvedValue(0);
      db.delete.mockResolvedValue({ id: 'r1' });

      await risk_service.delete_risk_from_db(makeReq({ params: { id: 'r1' } }));

      expect(auditEngagementRiskDb.count).toHaveBeenCalledWith({ where: { riskId: 'r1' } });
      expect(db.delete).toHaveBeenCalledWith({ where: { id: 'r1' } });
    });

    // RiskLink.source_ref/target_ref reference Risk.ref as plain strings, not
    // real FKs (risk.prisma's RiskLink comment), so nothing cascades
    // automatically the way the onDelete: Cascade relations above do. Without
    // this cleanup, a RiskLink pointing at the deleted risk would survive as
    // a dangling reference forever (confirmed live during aexa-frontend#25
    // testing). Unlike the in-use guards above, this doesn't block the
    // delete — a RiskLink isn't substantive data worth losing the delete
    // over, it's a "these two risks are related" pointer that stops being
    // true the moment either side is gone.
    it('deletes RiskLink rows referencing the deleted risk by ref, in the same transaction as the risk delete', async () => {
      db.findFirst.mockResolvedValue({ id: 'r1', org_account_id: ORG_A, ref: 'RSK-001' });
      inspectionDb.count.mockResolvedValue(0);
      recommendationDb.count.mockResolvedValue(0);
      kriDb.count.mockResolvedValue(0);
      riskApprovalDb.count.mockResolvedValue(0);
      auditEngagementRiskDb.count.mockResolvedValue(0);
      riskLinkDb.deleteMany.mockResolvedValue({ count: 2 });
      db.delete.mockResolvedValue({ id: 'r1' });

      await risk_service.delete_risk_from_db(makeReq({ params: { id: 'r1' } }));

      expect(riskLinkDb.deleteMany).toHaveBeenCalledWith({
        where: {
          org_account_id: ORG_A,
          OR: [{ source_ref: 'RSK-001' }, { target_ref: 'RSK-001' }],
        },
      });
      expect(db.delete).toHaveBeenCalledWith({ where: { id: 'r1' } });
    });

    it('still deletes the risk (not blocked) even when RiskLink rows reference it', async () => {
      db.findFirst.mockResolvedValue({ id: 'r1', org_account_id: ORG_A, ref: 'RSK-001' });
      inspectionDb.count.mockResolvedValue(0);
      recommendationDb.count.mockResolvedValue(0);
      kriDb.count.mockResolvedValue(0);
      riskApprovalDb.count.mockResolvedValue(0);
      auditEngagementRiskDb.count.mockResolvedValue(0);
      riskLinkDb.deleteMany.mockResolvedValue({ count: 1 });
      db.delete.mockResolvedValue({ id: 'r1' });

      await expect(
        risk_service.delete_risk_from_db(makeReq({ params: { id: 'r1' } })),
      ).resolves.toEqual({ id: 'r1' });
    });
  });
});

describe('risk_service — POST /risk/suggest-fields (mocked aexa-ai call)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    orgMemberDb.findUnique.mockResolvedValue(null);
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Review finding: every other write-gated risk operation in this file
  // (create/update/delete_risk, line_of_defense reassignment) has a
  // VIEWER/LIGHT_USER 403 test using mockMembership -- this suite's own
  // beforeEach always resolves orgMemberDb.findUnique to null (the
  // no-membership-row ADMIN-of-self fallback), so without this test the
  // assertCanWriteOrgResource gate on this new endpoint was never actually
  // exercised; a regression that silently dropped it would go undetected.
  it('VIEWER cannot request AI field suggestions', async () => {
    mockMembership('VIEWER');

    await expect(
      risk_service.suggest_risk_fields_with_ai(
        makeReq({ body: { name: 'Ransomware attack', category: 'cyber', site_id: 'site-1' } }),
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(fetch).not.toHaveBeenCalled();
    expect(siteDb.findUnique).not.toHaveBeenCalled();
  });

  it('404s when the site does not belong to (or exist for) the caller org, without calling aexa-ai', async () => {
    siteDb.findUnique.mockResolvedValue(null);

    await expect(
      risk_service.suggest_risk_fields_with_ai(
        makeReq({ body: { name: 'Ransomware attack', category: 'cyber', site_id: 'site-1' } }),
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('scopes the site lookup and the existing-risks context query to the caller org', async () => {
    siteDb.findUnique.mockResolvedValue({
      id: 'site-1',
      name: 'HQ Casablanca',
      activity: 'Manufacturing',
    });
    db.findMany.mockResolvedValue([]);
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ suggestions: {} }),
    });

    await risk_service.suggest_risk_fields_with_ai(
      makeReq({ body: { name: 'Ransomware attack', category: 'cyber', site_id: 'site-1' } }),
    );

    expect(siteDb.findUnique).toHaveBeenCalledWith({
      where: { id: 'site-1', org_account_id: ORG_A },
    });
    expect(db.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          org_account_id: ORG_A,
          site_id: 'site-1',
          review_status: 'APPROVED',
          supersededAt: null,
        },
      }),
    );
  });

  it('sends risk context, site context, and the requested fields subset with the internal-secret header', async () => {
    siteDb.findUnique.mockResolvedValue({
      id: 'site-1',
      name: 'HQ Casablanca',
      activity: 'Manufacturing',
    });
    db.findMany.mockResolvedValue([
      {
        name: 'Prior fire risk',
        category: 'fire',
        probability: 40,
        impact: 60,
        velocity: 'high',
        trend: 'none',
      },
    ]);
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ suggestions: { velocity: 'critical' } }),
    });

    await risk_service.suggest_risk_fields_with_ai(
      makeReq({
        body: {
          name: 'Ransomware attack',
          category: 'cyber',
          site_id: 'site-1',
          fields: ['velocity'],
        },
      }),
    );

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(url)).toContain('/risk/suggest-fields');
    expect(init.method).toBe('POST');
    expect(init.headers['X-Internal-Secret']).toBeDefined();

    const body = JSON.parse(init.body);
    expect(body).toEqual({
      risk_name: 'Ransomware attack',
      category: 'cyber',
      site_name: 'HQ Casablanca',
      site_activity: 'Manufacturing',
      fields: ['velocity'],
      existing_risks: [
        {
          name: 'Prior fire risk',
          category: 'fire',
          probability: 40,
          impact: 60,
          velocity: 'high',
          trend: 'none',
        },
      ],
    });
  });

  it('returns the aexa-ai suggestions and rationale on success', async () => {
    siteDb.findUnique.mockResolvedValue({ id: 'site-1', name: 'HQ Casablanca', activity: '' });
    db.findMany.mockResolvedValue([]);
    const suggestions = { probability: 65, velocity: 'high' };
    const rationale = { probability: 'Cyber risks at this site type are common.' };
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ suggestions, rationale }),
    });

    const result = await risk_service.suggest_risk_fields_with_ai(
      makeReq({ body: { name: 'Ransomware attack', category: 'cyber', site_id: 'site-1' } }),
    );

    expect(result).toEqual({ suggestions, rationale });
  });

  it('defaults rationale to an empty object when aexa-ai omits it', async () => {
    siteDb.findUnique.mockResolvedValue({ id: 'site-1', name: 'HQ Casablanca', activity: '' });
    db.findMany.mockResolvedValue([]);
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ suggestions: { probability: 65 } }),
    });

    const result = await risk_service.suggest_risk_fields_with_ai(
      makeReq({ body: { name: 'Ransomware attack', category: 'cyber', site_id: 'site-1' } }),
    );

    expect(result).toEqual({ suggestions: { probability: 65 }, rationale: {} });
  });

  it('defaults rationale to an empty object when aexa-ai returns a non-object value for it', async () => {
    // Review finding: `data.rationale ?? {}` alone only falls back on
    // null/undefined -- a truthy non-object (string/array/number) would
    // otherwise flow straight through to the client unfiltered.
    siteDb.findUnique.mockResolvedValue({ id: 'site-1', name: 'HQ Casablanca', activity: '' });
    db.findMany.mockResolvedValue([]);

    for (const malformed of ['not an object', ['a', 'list'], 42]) {
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => ({ suggestions: { probability: 65 }, rationale: malformed }),
      });

      const result = await risk_service.suggest_risk_fields_with_ai(
        makeReq({ body: { name: 'Ransomware attack', category: 'cyber', site_id: 'site-1' } }),
      );

      expect(result).toEqual({ suggestions: { probability: 65 }, rationale: {} });
    }
  });

  it('wraps a non-ok aexa-ai response as a 502', async () => {
    siteDb.findUnique.mockResolvedValue({ id: 'site-1', name: 'HQ Casablanca', activity: '' });
    db.findMany.mockResolvedValue([]);
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, status: 503 });

    await expect(
      risk_service.suggest_risk_fields_with_ai(
        makeReq({ body: { name: 'Ransomware attack', category: 'cyber', site_id: 'site-1' } }),
      ),
    ).rejects.toMatchObject({ statusCode: 502 });
  });

  it('wraps a network failure as a generic 500, not the raw error', async () => {
    siteDb.findUnique.mockResolvedValue({ id: 'site-1', name: 'HQ Casablanca', activity: '' });
    db.findMany.mockResolvedValue([]);
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(
      risk_service.suggest_risk_fields_with_ai(
        makeReq({ body: { name: 'Ransomware attack', category: 'cyber', site_id: 'site-1' } }),
      ),
    ).rejects.toMatchObject({
      statusCode: 500,
      message: 'Failed to generate risk field suggestions',
    });
  });
});

// docs/design-docs/ai-risk-review-approval-workflow.md
describe('risk service — AI-risk review/approval workflow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    orgMemberDb.findUnique.mockResolvedValue(null);
    kriDb.count.mockResolvedValue(0);
    complianceObligationDb.count.mockResolvedValue(0);
    auditEngagementRiskDb.count.mockResolvedValue(0);
    riskLinkDb.count.mockResolvedValue(0);
  });

  describe('get_all_risk_from_db reviewStatus filtering', () => {
    it('defaults to APPROVED-only when reviewStatus is omitted', async () => {
      db.findMany.mockResolvedValue([]);
      db.count.mockResolvedValue(0);

      await risk_service.get_all_risk_from_db(makeReq({}));

      expect(db.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ org_account_id: ORG_A, review_status: 'APPROVED' }),
        }),
      );
    });

    it('shows all three statuses when reviewStatus=all is passed (the Register page opt-in)', async () => {
      db.findMany.mockResolvedValue([]);
      db.count.mockResolvedValue(0);

      await risk_service.get_all_risk_from_db(makeReq({ query: { reviewStatus: 'all' } }));

      const call = db.findMany.mock.calls[0][0];
      expect(call.where.review_status).toBeUndefined();
      expect(call.where.org_account_id).toBe(ORG_A);
    });

    it('scopes to a specific status when reviewStatus=PENDING_REVIEW is passed (the Pending AI Review panel)', async () => {
      db.findMany.mockResolvedValue([]);
      db.count.mockResolvedValue(0);

      await risk_service.get_all_risk_from_db(
        makeReq({ query: { reviewStatus: 'PENDING_REVIEW' } }),
      );

      expect(db.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            org_account_id: ORG_A,
            review_status: 'PENDING_REVIEW',
          }),
        }),
      );
    });

    it('scopes to DISMISSED when requested (the Dismissed history view)', async () => {
      db.findMany.mockResolvedValue([]);
      db.count.mockResolvedValue(0);

      await risk_service.get_all_risk_from_db(makeReq({ query: { reviewStatus: 'DISMISSED' } }));

      expect(db.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ org_account_id: ORG_A, review_status: 'DISMISSED' }),
        }),
      );
    });

    it('falls back to APPROVED-only for an invalid reviewStatus value', async () => {
      db.findMany.mockResolvedValue([]);
      db.count.mockResolvedValue(0);

      await risk_service.get_all_risk_from_db(
        makeReq({ query: { reviewStatus: 'not-a-real-status' } }),
      );

      expect(db.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ org_account_id: ORG_A, review_status: 'APPROVED' }),
        }),
      );
    });
  });

  // Re-run/staleness fix
  describe('get_all_risk_from_db includeSuperseded filtering', () => {
    it('excludes superseded risks by default when includeSuperseded is omitted', async () => {
      db.findMany.mockResolvedValue([]);
      db.count.mockResolvedValue(0);

      await risk_service.get_all_risk_from_db(makeReq({}));

      expect(db.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ org_account_id: ORG_A, supersededAt: null }),
        }),
      );
    });

    it('includes superseded risks when includeSuperseded=true is passed (the audit-trail/history view)', async () => {
      db.findMany.mockResolvedValue([]);
      db.count.mockResolvedValue(0);

      await risk_service.get_all_risk_from_db(makeReq({ query: { includeSuperseded: 'true' } }));

      const call = db.findMany.mock.calls[0][0];
      expect(call.where.supersededAt).toBeUndefined();
      expect(call.where.org_account_id).toBe(ORG_A);
    });

    it('falls back to excluding superseded risks for any other includeSuperseded value', async () => {
      db.findMany.mockResolvedValue([]);
      db.count.mockResolvedValue(0);

      await risk_service.get_all_risk_from_db(makeReq({ query: { includeSuperseded: 'yes' } }));

      expect(db.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ org_account_id: ORG_A, supersededAt: null }),
        }),
      );
    });
  });

  describe('approve_risk_into_db', () => {
    it('flips a PENDING_REVIEW risk to APPROVED', async () => {
      db.findFirst.mockResolvedValue({ id: 'r1', org_account_id: ORG_A });
      db.updateMany.mockResolvedValue({ count: 1 });
      db.findUniqueOrThrow.mockResolvedValue({ id: 'r1', review_status: 'APPROVED' });

      const result = await risk_service.approve_risk_into_db(makeReq({ params: { id: 'r1' } }));

      expect(db.updateMany).toHaveBeenCalledWith({
        where: { id: 'r1', org_account_id: ORG_A, review_status: 'PENDING_REVIEW' },
        data: { review_status: 'APPROVED' },
      });
      expect(result.review_status).toBe('APPROVED');
    });

    it('404s when the risk does not belong to the caller org', async () => {
      db.findFirst.mockResolvedValue(null);

      await expect(
        risk_service.approve_risk_into_db(makeReq({ params: { id: 'r1' } })),
      ).rejects.toMatchObject({ statusCode: 404 });
      expect(db.updateMany).not.toHaveBeenCalled();
    });

    it('409s when the risk is not PENDING_REVIEW (already approved, or a concurrent approve/dismiss won the race)', async () => {
      db.findFirst.mockResolvedValue({ id: 'r1', org_account_id: ORG_A });
      // Guarded updateMany matched nothing -- the exact TOCTOU-guard shape
      // used for the AI-analysis retry endpoint.
      db.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        risk_service.approve_risk_into_db(makeReq({ params: { id: 'r1' } })),
      ).rejects.toMatchObject({ statusCode: 409 });
    });

    it('blocks a VIEWER from approving', async () => {
      mockMembership('VIEWER');
      db.findFirst.mockResolvedValue({ id: 'r1', org_account_id: ORG_A });

      await expect(
        risk_service.approve_risk_into_db(makeReq({ params: { id: 'r1' } })),
      ).rejects.toMatchObject({ statusCode: 403 });
      expect(db.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('dismiss_risk_into_db', () => {
    it('flips a PENDING_REVIEW risk to DISMISSED', async () => {
      db.findFirst.mockResolvedValue({ id: 'r1', org_account_id: ORG_A, ref: 'CYB-001' });
      db.updateMany.mockResolvedValue({ count: 1 });
      db.findUniqueOrThrow.mockResolvedValue({ id: 'r1', review_status: 'DISMISSED' });

      const result = await risk_service.dismiss_risk_into_db(makeReq({ params: { id: 'r1' } }));

      expect(db.updateMany).toHaveBeenCalledWith({
        where: { id: 'r1', org_account_id: ORG_A, review_status: 'PENDING_REVIEW' },
        data: { review_status: 'DISMISSED' },
      });
      expect(result.risk.review_status).toBe('DISMISSED');
    });

    it('surfaces a non-blocking warning count when the risk is still referenced elsewhere', async () => {
      db.findFirst.mockResolvedValue({ id: 'r1', org_account_id: ORG_A, ref: 'CYB-001' });
      db.updateMany.mockResolvedValue({ count: 1 });
      db.findUniqueOrThrow.mockResolvedValue({ id: 'r1', review_status: 'DISMISSED' });
      kriDb.count.mockResolvedValue(2);
      auditEngagementRiskDb.count.mockResolvedValue(1);

      const result = await risk_service.dismiss_risk_into_db(makeReq({ params: { id: 'r1' } }));

      // Dismiss is not blocked by in-use references (unlike delete) -- the
      // warning is informational, surfaced for the frontend to show before
      // confirming.
      expect(result.referencedBy).toEqual({
        kris: 2,
        complianceObligations: 0,
        auditEngagements: 1,
        riskLinks: 0,
      });
    });

    it('409s when the risk is not PENDING_REVIEW', async () => {
      db.findFirst.mockResolvedValue({ id: 'r1', org_account_id: ORG_A, ref: 'CYB-001' });
      db.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        risk_service.dismiss_risk_into_db(makeReq({ params: { id: 'r1' } })),
      ).rejects.toMatchObject({ statusCode: 409 });
    });
  });

  describe('bulk_approve_risks_into_db / bulk_dismiss_risks_into_db', () => {
    it('approves every PENDING_REVIEW risk in the list and reports how many were skipped', async () => {
      db.count.mockResolvedValue(2); // both ids belong to the org
      db.updateMany.mockResolvedValue({ count: 1 }); // one was already APPROVED

      const result = await risk_service.bulk_approve_risks_into_db(
        makeReq({ body: { riskIds: ['r1', 'r2'] } }),
      );

      expect(db.updateMany).toHaveBeenCalledWith({
        where: {
          id: { in: ['r1', 'r2'] },
          org_account_id: ORG_A,
          review_status: 'PENDING_REVIEW',
        },
        data: { review_status: 'APPROVED' },
      });
      expect(result).toEqual({ updated: 1, skipped: 1 });
    });

    it('rejects the whole batch with 400 when a riskId belongs to a different org', async () => {
      // Only 1 of the 2 ids actually resolves under this org's scope.
      db.count.mockResolvedValue(1);

      await expect(
        risk_service.bulk_approve_risks_into_db(
          makeReq({ body: { riskIds: ['r1', 'cross-org-risk'] } }),
        ),
      ).rejects.toMatchObject({ statusCode: 400 });
      expect(db.updateMany).not.toHaveBeenCalled();
    });

    it('dismisses every PENDING_REVIEW risk in the list', async () => {
      db.count.mockResolvedValue(2);
      db.updateMany.mockResolvedValue({ count: 2 });

      const result = await risk_service.bulk_dismiss_risks_into_db(
        makeReq({ body: { riskIds: ['r1', 'r2'] } }),
      );

      expect(db.updateMany).toHaveBeenCalledWith({
        where: {
          id: { in: ['r1', 'r2'] },
          org_account_id: ORG_A,
          review_status: 'PENDING_REVIEW',
        },
        data: { review_status: 'DISMISSED' },
      });
      expect(result).toEqual({ updated: 2, skipped: 0 });
    });

    it('blocks a VIEWER from bulk-approving', async () => {
      mockMembership('VIEWER');

      await expect(
        risk_service.bulk_approve_risks_into_db(makeReq({ body: { riskIds: ['r1'] } })),
      ).rejects.toMatchObject({ statusCode: 403 });
      expect(db.count).not.toHaveBeenCalled();
    });
  });
});

describe('risk validation schemas', () => {
  // aexa-frontend#208: GOVERNING_BODY is a real, Zod-accepted value for
  // line_of_defense, not just something the service layer happens to pass
  // through unchecked.
  it('accepts GOVERNING_BODY as a valid line_of_defense value', async () => {
    const parsed = await risk_validations.update_risk.parseAsync({
      line_of_defense: 'GOVERNING_BODY',
    });
    expect(parsed.line_of_defense).toBe('GOVERNING_BODY');
  });
});
