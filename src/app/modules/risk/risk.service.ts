import { Request } from 'express';
import { configs } from '../../configs/index.js';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../utils/app_error.js';
import { JwtPayloadType } from '../../utils/JWT.js';
import {
  assertCanReassignLineOfDefense,
  assertCanWriteOrgResource,
  resolveCallerOrgContext,
} from '../../utils/org_scope.js';
import {
  assertCanRecordLineReview,
  invalidateLiveLineReviews,
  LineOfDefenseValue,
  recordLineReview,
} from '../../utils/line_of_defense_review.js';
import { buildPaginationMeta, paginationHelper } from '../../utils/paginationHelper.js';
import {
  buildAiHeaders,
  fetchWithTimeout,
  LLM_CALL_TIMEOUT_MS,
  wrapAiServiceError,
} from '../ai/ai.service.js';
import { deriveApprovalState, risk_approval_service } from './risk.approval.service.js';
import { createRiskWithGeneratedRef } from './risk_ref.js';
import { resolveInherentFields, resolveResidualFields } from './risk_scoring.js';
import { computeEbitdaEstimate, resolveEbitdaFields } from './ebitda_risk.js';
import { computeEbitdaSummary } from './ebitda_summary.js';
import { mapActivityToSector } from './sector_mapper.js';

const get_all_risk_from_db = async (req: Request) => {
  const { searchTerm, siteId, category, reviewStatus, includeSuperseded } = req.query as Record<
    string,
    string
  >;

  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  const pagination = paginationHelper({
    page: req.query.page as string,
    limit: req.query.limit as string,
  });
  const { skip, limit: limitNumber } = pagination;

  const whereCondition: any = {
    org_account_id: ctx.organizationId,
  };

  // docs/design-docs/ai-risk-review-approval-workflow.md -- this endpoint
  // is shared by many consumers (matrix, graph, dashboard, KRI picker, CSV
  // export, compliance/audit linking) that all expect APPROVED-only data
  // and pass no override -- filtering here once, rather than in every
  // consumer, is deliberate (the "filter at the source" rationale). The
  // Risk Register needs three different views without re-fetching the
  // (potentially large) approved register just to find a handful of
  // pending/dismissed rows: ?reviewStatus=all shows all three, or a
  // specific status value (PENDING_REVIEW/DISMISSED/APPROVED) scopes to
  // just that one. Any other/invalid value falls through to the default.
  const VALID_REVIEW_STATUSES = ['APPROVED', 'PENDING_REVIEW', 'DISMISSED'];
  if (reviewStatus === 'all') {
    // no filter -- all three statuses
  } else if (VALID_REVIEW_STATUSES.includes(reviewStatus)) {
    whereCondition.review_status = reviewStatus;
  } else {
    whereCondition.review_status = 'APPROVED';
  }

  // Re-run/staleness fix: a superseded risk (replaced by a fresher re-run
  // result) is excluded from the register by default, same "filter at the
  // source" rationale as review_status above -- every consumer of this
  // endpoint expects "the risks currently on this site/org's register,"
  // and a stale superseded row showing up would be misleading. Explicit
  // opt-in (?includeSuperseded=true) for an audit-trail/history view.
  if (includeSuperseded !== 'true') {
    whereCondition.supersededAt = null;
  }

  // search by name
  if (searchTerm) {
    whereCondition.name = {
      contains: searchTerm,
      mode: 'insensitive',
    };
  }

  // filter by site
  if (siteId) {
    whereCondition.site_id = siteId;
  }

  // filter by category
  if (category) {
    whereCondition.category = category;
  }

  const [data, total] = await Promise.all([
    prisma.risk.findMany({
      where: whereCondition,
      skip,
      take: limitNumber,
      orderBy: {
        createdAt: 'desc',
      },
      include: {
        site: {
          select: {
            id: true,
            name: true,
          },
        },
        // aexa-frontend#95: latest approval cycle only (take: 1, newest
        // first), so the register table can render an approval badge and
        // expose the approval id for admin approve/reject without an N+1
        // per-row GET /risk/:id/approval fan-out.
        approvals: {
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    }),

    prisma.risk.count({
      where: whereCondition,
    }),
  ]);

  // Flatten the single-element approvals array into a derived display state
  // (via the same deriveApprovalState the dedicated endpoint uses, so the
  // list badge and the detail endpoint can't disagree) plus the raw latest
  // row for its id/decisionNote.
  const risksWithApproval = data.map(({ approvals, ...risk }) => {
    const latest = approvals[0] ?? null;
    return { ...risk, approval: latest, approvalStatus: deriveApprovalState(latest) };
  });

  return {
    meta: buildPaginationMeta(pagination, total),
    data: risksWithApproval,
  };
};

const get_single_risk_from_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  const { id } = req.params as Record<string, string>;
  const result = await prisma.risk.findFirst({
    where: { id, org_account_id: ctx.organizationId },
    // aexa-frontend#541: get_all_risk_from_db already joins this (the
    // register list needs it), but this single-risk read never did --
    // RiskDetails.tsx's Site card always fell back to "Group" for a risk
    // that genuinely has one, since risk.site was silently undefined here.
    include: {
      site: {
        select: {
          id: true,
          name: true,
        },
      },
    },
  });
  if (!result) throw new AppError('Risk not found', 404);
  return result;
};

const create_risk_into_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  assertCanWriteOrgResource(ctx);
  const payload = req.body;
  payload.org_account_id = ctx.organizationId;

  // aexa-server#247: resolve inherent_score BEFORE residual_score, since
  // residual is derived from inherent — residual must see the freshly
  // derived inherent value, not the raw client-supplied one it might
  // override. `existing` is null on create, so an unrequested override
  // always falls through to the auto-computed (or raw-fallback) value.
  const inherent = resolveInherentFields(
    {
      probability: payload.probability,
      impact: payload.impact,
      raw_inherent_score: payload.inherent_score,
    },
    {
      inherent_override: payload.inherent_override,
      inherent_score: payload.inherent_score,
      inherent_override_reason: payload.inherent_override_reason,
    },
    user.accountId,
    null,
  );
  if (!inherent.ok) throw new AppError(inherent.message, 400);
  Object.assign(payload, inherent.fields);
  delete payload.inherent_override;

  // aexa-server#241: residual_score is derived from inherent_score + control
  // effectiveness by default (see risk_scoring.ts), not just whatever number
  // the client sent. `existing` is null on create, so an unrequested
  // override always falls through to the auto-computed value.
  const residual = resolveResidualFields(
    {
      inherent_score: payload.inherent_score,
      control_design_eff: payload.control_design_eff,
      control_operating_eff: payload.control_operating_eff,
    },
    {
      residual_override: payload.residual_override,
      residual_score: payload.residual_score,
      residual_override_reason: payload.residual_override_reason,
    },
    user.accountId,
    null,
  );
  if (!residual.ok) throw new AppError(residual.message, 400);
  Object.assign(payload, residual.fields);
  delete payload.residual_override;

  // aexa-server#347: EBITDA-at-risk needs the site's revenue/activity, which
  // don't live on the Risk payload itself — look the site up scoped to this
  // org (never trust a site_id belonging to another org; same org-scoping
  // requirement as every other cross-model lookup in this file).
  const site = await prisma.site.findFirst({
    where: { id: payload.site_id, org_account_id: ctx.organizationId },
  });
  if (!site) throw new AppError('Site not found', 404);
  const ebitda = resolveEbitdaFields(
    {
      site_revenue: site.revenue,
      site_activity: site.activity,
      probability: payload.probability,
      impact: payload.impact,
    },
    {
      ebitda_override: payload.ebitda_override,
      ebitda_override_margin: payload.ebitda_override_margin,
      ebitda_override_reason: payload.ebitda_override_reason,
    },
    user.accountId,
    null,
  );
  if (!ebitda.ok) throw new AppError(ebitda.message, 400);
  Object.assign(payload, ebitda.fields);
  delete payload.ebitda_override;
  delete payload.ebitda_override_margin;

  // aexa-frontend#142: `ref` is generated server-side (category-derived
  // prefix + per-org-per-category sequence), never accepted from the
  // client — see risk_ref.ts for the scheme and its retry-on-conflict
  // safety net.
  const result = await createRiskWithGeneratedRef(payload);
  return result;
};

const update_risk_into_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  assertCanWriteOrgResource(ctx);
  // aexa-frontend#208: third-line independence — a LEAD_AUDITOR must not be
  // able to reclassify a first/second-line entity's ownership. Only checked
  // when line_of_defense is actually part of this update, same "only check
  // what's touched" pattern as every other optional field here.
  if (req.body.line_of_defense !== undefined) {
    assertCanReassignLineOfDefense(ctx, 'MANAGEMENT_LINE');
  }
  const { id } = req.params as Record<string, string>;
  const existing = await prisma.risk.findFirst({
    where: { id, org_account_id: ctx.organizationId },
  });
  if (!existing) throw new AppError('Risk not found', 404);
  // Never trust org_account_id from the request body on an update — see the
  // identical fix in site.service.ts's update_site_into_db for why.
  const { org_account_id: _ignored, ...safeBody } = req.body;

  // aexa-frontend#95: editing a risk's assessment invalidates any live approval
  // cycle — the reviewed version is now stale, so the risk must be resubmitted
  // for a fresh approval. No-op for risks that were never submitted (the common
  // case), so this stays a single hook rather than an approval-check duplicated
  // across every risk-edit call site.
  //
  // aexa-server#203: the risk write and the approval invalidation must be
  // atomic. Committing the edit and then invalidating in a separate statement
  // left a window where a crash between the two would leave an edited risk still
  // wearing a live APPROVED badge for an assessment no one re-reviewed. Wrapping
  // both in one $transaction (and threading the tx client into the hook) makes
  // them commit or roll back together. The hook's OrgAuditLog writes stay
  // fire-and-forget on the singleton, per recordOrgAuditEvent's contract.
  const result = await prisma.$transaction(async (tx) => {
    // aexa-server#241: re-read the row's residual-affecting fields INSIDE
    // the transaction, immediately before the write, rather than reusing
    // the `existing` snapshot fetched above (before the transaction even
    // opened). Deriving/writing residual_score now happens on every update
    // (not just ones that touch a residual input), so reusing the earlier
    // snapshot would let a concurrent edit to inherent_score/control_*_eff
    // — committed in the window between that snapshot and this write — be
    // silently clobbered by a residual_score computed from stale inputs.
    const current = await tx.risk.findFirst({ where: { id } });
    if (!current) throw new AppError('Risk not found', 404);

    // aexa-server#247: resolve inherent_score first (same in-transaction
    // re-read rationale as #241's residual fix above), then feed the
    // freshly-resolved value — not the raw request body's — into the
    // residual resolution below.
    const inherent = resolveInherentFields(
      {
        probability: safeBody.probability ?? current.probability,
        impact: safeBody.impact ?? current.impact,
        raw_inherent_score: safeBody.inherent_score ?? current.inherent_score,
      },
      {
        inherent_override: safeBody.inherent_override,
        inherent_score: safeBody.inherent_score,
        inherent_override_reason: safeBody.inherent_override_reason,
      },
      user.accountId,
      {
        probability: current.probability,
        impact: current.impact,
        inherent_score: current.inherent_score,
        inherent_is_override: current.inherent_is_override,
        inherent_override_reason: current.inherent_override_reason,
        inherent_overridden_by: current.inherent_overridden_by,
        inherent_overridden_at: current.inherent_overridden_at,
        inherent_override_stale: current.inherent_override_stale,
      },
    );
    if (!inherent.ok) throw new AppError(inherent.message, 400);
    Object.assign(safeBody, inherent.fields);
    delete safeBody.inherent_override;

    const effectiveInputs = {
      inherent_score: safeBody.inherent_score,
      control_design_eff: safeBody.control_design_eff ?? current.control_design_eff,
      control_operating_eff: safeBody.control_operating_eff ?? current.control_operating_eff,
    };
    const residual = resolveResidualFields(
      effectiveInputs,
      {
        residual_override: safeBody.residual_override,
        residual_score: safeBody.residual_score,
        residual_override_reason: safeBody.residual_override_reason,
      },
      user.accountId,
      {
        inherent_score: current.inherent_score,
        control_design_eff: current.control_design_eff,
        control_operating_eff: current.control_operating_eff,
        residual_score: current.residual_score,
        residual_is_override: current.residual_is_override,
        residual_override_reason: current.residual_override_reason,
        residual_overridden_by: current.residual_overridden_by,
        residual_overridden_at: current.residual_overridden_at,
        residual_override_stale: current.residual_override_stale,
      },
    );
    if (!residual.ok) throw new AppError(residual.message, 400);
    Object.assign(safeBody, residual.fields);
    delete safeBody.residual_override;

    // aexa-server#347: re-read the effective site INSIDE the transaction,
    // same in-transaction-freshness rationale as #241/#247 above — a site's
    // revenue/activity can change independently of this risk's own edits,
    // and reusing a snapshot fetched before the transaction opened would
    // let a concurrent site update be computed from stale inputs.
    const effectiveSiteId = safeBody.site_id ?? current.site_id;
    const site = await tx.site.findFirst({
      where: { id: effectiveSiteId, org_account_id: ctx.organizationId },
    });
    if (!site) throw new AppError('Site not found', 404);
    const ebitda = resolveEbitdaFields(
      {
        site_revenue: site.revenue,
        site_activity: site.activity,
        probability: safeBody.probability ?? current.probability,
        impact: safeBody.impact ?? current.impact,
      },
      {
        ebitda_override: safeBody.ebitda_override,
        ebitda_override_margin: safeBody.ebitda_override_margin,
        ebitda_override_reason: safeBody.ebitda_override_reason,
      },
      user.accountId,
      {
        probability: current.probability,
        impact: current.impact,
        ebitda_at_risk: current.ebitda_at_risk,
        ebitda_benchmark_sector: current.ebitda_benchmark_sector,
        ebitda_benchmark_margin: current.ebitda_benchmark_margin,
        ebitda_is_override: current.ebitda_is_override,
        ebitda_override_reason: current.ebitda_override_reason,
        ebitda_overridden_by: current.ebitda_overridden_by,
        ebitda_overridden_at: current.ebitda_overridden_at,
        ebitda_override_stale: current.ebitda_override_stale,
      },
    );
    if (!ebitda.ok) throw new AppError(ebitda.message, 400);
    Object.assign(safeBody, ebitda.fields);
    delete safeBody.ebitda_override;
    delete safeBody.ebitda_override_margin;

    const updated = await tx.risk.update({
      where: { id },
      data: { ...safeBody, org_account_id: ctx.organizationId },
    });
    await risk_approval_service.invalidateLiveApprovalsOnEdit(id, ctx, user.accountId, tx);
    // #97: a review is a fact about the risk's content AT the time it was
    // reviewed. An edit here makes every live review stale for the same
    // reason invalidateLiveApprovalsOnEdit above invalidates the approval
    // cycle -- see line_of_defense_review.ts's invalidateLiveLineReviews.
    await invalidateLiveLineReviews(tx.riskLineReview, 'riskId', id);
    return updated;
  });

  return result;
};

/**
 * #97: records that `line` independently reviewed this risk, superseding
 * any prior live review for that same line. Kept separate from
 * update_risk_into_db (assigning ownership) -- see
 * line_of_defense_review.ts's file comment for why ownership and review
 * coverage are different facts, not the same field.
 */
const record_risk_line_review = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  const { id } = req.params as Record<string, string>;
  const existing = await prisma.risk.findFirst({
    where: { id, org_account_id: ctx.organizationId },
  });
  if (!existing) throw new AppError('Risk not found', 404);

  const { line, notes } = req.body as { line: LineOfDefenseValue; notes?: string };
  assertCanRecordLineReview(ctx, line);
  await recordLineReview(prisma.riskLineReview, 'riskId', id, user.accountId, line, notes);

  return prisma.riskLineReview.findMany({
    where: { riskId: id, invalidatedAt: null },
    orderBy: { line: 'asc' },
  });
};

const delete_risk_from_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  assertCanWriteOrgResource(ctx);
  const { id } = req.params as Record<string, string>;
  const existing = await prisma.risk.findFirst({
    where: { id, org_account_id: ctx.organizationId },
  });
  if (!existing) throw new AppError('Risk not found', 404);

  // In-use guard (found by audit): Inspection.risk
  // (prisma/schema/inspection.prisma:34), Recommendation.risk
  // (prisma/schema/recommendation.prisma:21), Kri.risk (prisma/schema/kri.prisma:6)
  // and RiskApproval.risk (prisma/schema/risk.prisma:63) are all
  // onDelete: Cascade, so deleting a risk that inspections, recommendations,
  // KRIs or a live approval cycle still reference would silently destroy those
  // records. Block the delete when the risk is still in use.
  //
  // aexa-server#202: "live" for an approval cycle means a non-invalidated
  // PENDING_APPROVAL or APPROVED row — the same definition
  // invalidateLiveApprovalsOnEdit uses. A REJECTED or already-invalidated cycle
  // is terminal history and never blocks a fresh submission, so it doesn't block
  // a delete either; losing it to the cascade is acceptable, losing a live
  // maker-checker sign-off silently is not.
  //
  // aexa-frontend#165: AuditEngagementRisk links are onDelete: Cascade too, so
  // a risk still covered by any audit engagement is treated as in use and
  // blocked — same conservative philosophy as the counts above. The audit↔risk
  // association is meaningful audit-trail data ("which audits touch this risk"),
  // so it must not silently vanish when a risk is deleted; the caller unlinks
  // the risk from its engagements first. (The reverse direction is NOT blocked:
  // deleting an engagement just cascades away its own link rows — see
  // audit.service.ts delete_audit_from_db.)
  const [inspectionCount, recommendationCount, kriCount, approvalCount, auditLinkCount] =
    await Promise.all([
      prisma.inspection.count({ where: { riskId: id } }),
      prisma.recommendation.count({ where: { riskId: id } }),
      prisma.kri.count({ where: { risk_id: id } }),
      prisma.riskApproval.count({
        where: {
          riskId: id,
          invalidatedAt: null,
          status: { in: ['PENDING_APPROVAL', 'APPROVED'] },
        },
      }),
      prisma.auditEngagementRisk.count({ where: { riskId: id } }),
    ]);
  if (
    inspectionCount > 0 ||
    recommendationCount > 0 ||
    kriCount > 0 ||
    approvalCount > 0 ||
    auditLinkCount > 0
  ) {
    throw new AppError(
      `Cannot delete risk: ${inspectionCount} inspection(s), ${recommendationCount} recommendation(s), ${kriCount} KRI(s), ${approvalCount} live approval cycle(s) and ${auditLinkCount} audit engagement link(s) reference it.`,
      409,
    );
  }

  // RiskLink.source_ref/target_ref reference Risk.ref as plain strings, not
  // real FKs (see risk.prisma's RiskLink comment — deliberate, so a link
  // survives a risk being recreated with a new id but the same ref). That
  // means nothing cascades automatically the way the onDelete: Cascade
  // relations above do: a RiskLink pointing at this risk would otherwise
  // survive the delete as a dangling reference forever (aexa-frontend#25).
  // Unlike the in-use guard above, a RiskLink isn't substantive data worth
  // blocking a delete over — it's just a "these two risks are related"
  // pointer that stops being true the moment either side is gone — so it's
  // cleaned up here rather than treated as another reason to block.
  const result = await prisma.$transaction(async (tx) => {
    await tx.riskLink.deleteMany({
      where: {
        org_account_id: ctx.organizationId,
        OR: [{ source_ref: existing.ref }, { target_ref: existing.ref }],
      },
    });
    return tx.risk.delete({ where: { id } });
  });
  return result;
};

// docs/design-docs/ai-risk-review-approval-workflow.md -- shared reference
// count for the dismiss in-use warning, mirroring delete_risk_from_db's
// in-use guard above but as a non-blocking count (dismiss doesn't break any
// FK the way delete's cascades would, so it's a warning, not a hard block).
const countRiskReferences = async (
  riskId: string,
  riskRef: string,
  orgAccountId: string,
): Promise<{
  kris: number;
  complianceObligations: number;
  auditEngagements: number;
  riskLinks: number;
}> => {
  const [kris, complianceObligations, auditEngagements, riskLinks] = await Promise.all([
    prisma.kri.count({ where: { risk_id: riskId } }),
    prisma.complianceObligation.count({ where: { risk_id: riskId } }),
    prisma.auditEngagementRisk.count({ where: { riskId } }),
    prisma.riskLink.count({
      where: {
        org_account_id: orgAccountId,
        OR: [{ source_ref: riskRef }, { target_ref: riskRef }],
      },
    }),
  ]);
  return { kris, complianceObligations, auditEngagements, riskLinks };
};

// action verb, no body -- same convention as report.route.ts's
// PATCH /:id/publish and this session's POST /ai/risk-analysis-runs/:id/retry.
const approve_risk_into_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  assertCanWriteOrgResource(ctx);
  const { id } = req.params as Record<string, string>;

  const existing = await prisma.risk.findFirst({
    where: { id, org_account_id: ctx.organizationId },
  });
  if (!existing) throw new AppError('Risk not found', 404);

  // Guarded updateMany (not findFirst-then-update) -- the exact TOCTOU shape
  // fixed tonight on the retry-failed-categories endpoint: two concurrent
  // requests against the same risk (a bulk call racing a single one, or two
  // overlapping bulk calls) must not both succeed.
  const outcome = await prisma.risk.updateMany({
    where: { id, org_account_id: ctx.organizationId, review_status: 'PENDING_REVIEW' },
    data: { review_status: 'APPROVED' },
  });
  if (outcome.count === 0) {
    throw new AppError('This risk is not pending review.', 409);
  }
  return prisma.risk.findUniqueOrThrow({ where: { id } });
};

const dismiss_risk_into_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  assertCanWriteOrgResource(ctx);
  const { id } = req.params as Record<string, string>;

  const existing = await prisma.risk.findFirst({
    where: { id, org_account_id: ctx.organizationId },
  });
  if (!existing) throw new AppError('Risk not found', 404);

  const outcome = await prisma.risk.updateMany({
    where: { id, org_account_id: ctx.organizationId, review_status: 'PENDING_REVIEW' },
    data: { review_status: 'DISMISSED' },
  });
  if (outcome.count === 0) {
    throw new AppError('This risk is not pending review.', 409);
  }
  const referencedBy = await countRiskReferences(id, existing.ref, ctx.organizationId);
  return { risk: await prisma.risk.findUniqueOrThrow({ where: { id } }), referencedBy };
};

type BulkReviewOutcome = { updated: number; skipped: number };

const bulk_approve_risks_into_db = async (req: Request): Promise<BulkReviewOutcome> => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  assertCanWriteOrgResource(ctx);
  const { riskIds } = req.body as { riskIds: string[] };

  // A cross-org id can't arise from legitimate client use (ids only ever
  // come from the caller's own org's risk list), unlike an already-
  // approved/dismissed id in the same org, which is a normal race a stale
  // UI can produce. Reject the whole batch on a cross-org id (a real client
  // bug or a probe worth surfacing) rather than silently absorbing it into
  // the same "not applicable" bucket as an ordinary status-mismatch skip.
  const ownedCount = await prisma.risk.count({
    where: { id: { in: riskIds }, org_account_id: ctx.organizationId },
  });
  if (ownedCount !== riskIds.length) {
    throw new AppError('One or more risks do not belong to this organization.', 400);
  }

  const outcome = await prisma.risk.updateMany({
    where: {
      id: { in: riskIds },
      org_account_id: ctx.organizationId,
      review_status: 'PENDING_REVIEW',
    },
    data: { review_status: 'APPROVED' },
  });
  return { updated: outcome.count, skipped: riskIds.length - outcome.count };
};

const bulk_dismiss_risks_into_db = async (req: Request): Promise<BulkReviewOutcome> => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  assertCanWriteOrgResource(ctx);
  const { riskIds } = req.body as { riskIds: string[] };

  const ownedCount = await prisma.risk.count({
    where: { id: { in: riskIds }, org_account_id: ctx.organizationId },
  });
  if (ownedCount !== riskIds.length) {
    throw new AppError('One or more risks do not belong to this organization.', 400);
  }

  const outcome = await prisma.risk.updateMany({
    where: {
      id: { in: riskIds },
      org_account_id: ctx.organizationId,
      review_status: 'PENDING_REVIEW',
    },
    data: { review_status: 'DISMISSED' },
  });
  return { updated: outcome.count, skipped: riskIds.length - outcome.count };
};

/**
 * aexa-server#347 — org-scoped EBITDA-at-risk distribution for the
 * dashboard chart. Reads the already-persisted `ebitda_at_risk` values
 * (computed/kept fresh by create/update above, including any per-risk
 * override) rather than recomputing live per request — cheap, and matches
 * "what the risk detail page shows for this risk" exactly, no drift
 * between the two views.
 */
const get_ebitda_at_risk_summary = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);

  const [risks, sites] = await Promise.all([
    prisma.risk.findMany({
      // docs/design-docs/ai-risk-review-approval-workflow.md -- financial
      // exposure chart shouldn't include unreviewed AI numbers. Re-run/
      // staleness fix: nor a superseded risk's stale figure.
      where: {
        org_account_id: ctx.organizationId,
        review_status: 'APPROVED',
        supersededAt: null,
      },
      select: { ebitda_at_risk: true },
    }),
    prisma.site.findMany({
      where: { org_account_id: ctx.organizationId },
      select: { revenue: true, activity: true },
    }),
  ]);

  const ebitdaAtRiskValues = risks
    .map((r) => r.ebitda_at_risk)
    .filter((v): v is number => v != null);

  // "Budget" baseline: sum of each site's OWN estimated EBITDA (revenue x
  // its matched sector margin) -- deliberately independent of any risk's
  // probability/impact, since this represents total resource at stake, not
  // an at-risk figure. A site contributes 0 here (not excluded) when its
  // revenue is missing/non-positive, matching computeEbitdaEstimate's own
  // null-for-no-revenue convention collapsed to 0 for a sum.
  const totalEstimatedEbitda = sites.reduce((sum, site) => {
    const sector = mapActivityToSector(site.activity);
    return sum + (computeEbitdaEstimate(site.revenue, sector.margin) ?? 0);
  }, 0);

  return computeEbitdaSummary(ebitdaAtRiskValues, totalEstimatedEbitda, risks.length);
};

type RiskFieldSuggestionAiResponse = {
  suggestions: {
    probability?: number;
    impact?: number;
    velocity?: string;
    trend?: string;
    control_design_eff?: number;
    control_operating_eff?: number;
    financial_impact_min?: number;
    financial_impact_max?: number;
  };
  // quality-bar-loop round 5: one-sentence reason per SUGGESTED field,
  // keyed by field name -- aexa-ai's own _normalize only includes an entry
  // here for a field that also made it into `suggestions`. Optional --
  // aexa-ai's own fallback path (LLM call produced nothing parseable)
  // returns just `{"suggestions": {}}` with no `rationale` key at all.
  rationale?: Record<string, string>;
};

// Review finding: `data.rationale ?? {}` alone only falls back on
// null/undefined -- a non-object truthy value (aexa-ai returning a string
// or array for `rationale`, however unlikely given aexa-ai's own
// _normalize_rationale already guards against that) would otherwise flow
// straight through to the client unfiltered, unlike `suggestions` which
// has no such gap since it's always assigned from a dict literal in
// _normalize.
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// POST /risk/suggest-fields — pure proxy to aexa-ai's /risk/suggest-fields,
// non-persisting: returns raw suggestions for client-side review rather
// than writing anything. Lives in this module rather than the generic
// `ai` module, following risk.correlation.service.ts's root-cause-bucketing
// precedent for risk-domain AI logic.
const suggest_risk_fields_with_ai = async (req: Request) => {
  try {
    const user = req.user as JwtPayloadType;
    const ctx = await resolveCallerOrgContext(user.accountId);
    assertCanWriteOrgResource(ctx);

    const { name, category, site_id, fields } = req.body as {
      name: string;
      category: string;
      site_id: string;
      fields?: string[];
    };

    const site = await prisma.site.findUnique({
      where: { id: site_id, org_account_id: ctx.organizationId },
    });
    if (!site) {
      throw new AppError('Site not found', 404);
    }

    // A few of this org's other risks at the same site, for calibration --
    // same "give the model real context, not just the one risk's name"
    // reasoning as run_root_cause_bucketing's risks array.
    const existingRisks = await prisma.risk.findMany({
      // docs/design-docs/ai-risk-review-approval-workflow.md -- don't
      // calibrate a new AI suggestion off other not-yet-reviewed AI output.
      // Re-run/staleness fix: nor off a superseded (stale) risk.
      where: {
        org_account_id: ctx.organizationId,
        site_id,
        review_status: 'APPROVED',
        supersededAt: null,
      },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: {
        name: true,
        category: true,
        probability: true,
        impact: true,
        velocity: true,
        trend: true,
      },
    });

    const aiResponse = await fetchWithTimeout(
      `${configs.ai_server_end_point}/risk/suggest-fields`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...buildAiHeaders(ctx.organizationId),
        },
        body: JSON.stringify({
          risk_name: name,
          category,
          site_name: site.name,
          site_activity: site.activity || '',
          fields,
          existing_risks: existingRisks.map((r) => ({
            name: r.name,
            category: r.category,
            probability: r.probability,
            impact: r.impact,
            velocity: r.velocity,
            trend: r.trend,
          })),
        }),
      },
      LLM_CALL_TIMEOUT_MS,
    );
    if (!aiResponse.ok) {
      throw new AppError(`AI service error: ${aiResponse.status}`, 502);
    }
    const data = (await aiResponse.json()) as RiskFieldSuggestionAiResponse;
    // quality-bar-loop round 5: the response shape grew from a flat
    // suggestions object to {suggestions, rationale} -- an internal,
    // same-deploy API with no external consumers, so this ships as a
    // coordinated change across aexa-ai/aexa-server/aexa-frontend rather
    // than needing a versioned/backwards-compatible transition.
    return {
      suggestions: data.suggestions ?? {},
      rationale: isPlainObject(data.rationale) ? (data.rationale as Record<string, string>) : {},
    };
  } catch (error) {
    return wrapAiServiceError(error, 'Failed to generate risk field suggestions');
  }
};

export const risk_service = {
  get_all_risk_from_db,
  get_single_risk_from_db,
  create_risk_into_db,
  update_risk_into_db,
  delete_risk_from_db,
  get_ebitda_at_risk_summary,
  suggest_risk_fields_with_ai,
  record_risk_line_review,
  approve_risk_into_db,
  dismiss_risk_into_db,
  bulk_approve_risks_into_db,
  bulk_dismiss_risks_into_db,
};
