import { Request } from 'express';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../utils/app_error.js';
import { JwtPayloadType } from '../../utils/JWT.js';
import { assertCanWriteOrgResource, resolveCallerOrgContext } from '../../utils/org_scope.js';
import { buildPaginationMeta, paginationHelper } from '../../utils/paginationHelper.js';
import { deriveApprovalState, risk_approval_service } from './risk.approval.service.js';

const get_all_risk_from_db = async (req: Request) => {
  const { searchTerm, siteId, category } = req.query as Record<string, string>;

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
  const result = await prisma.risk.findFirst({ where: { id, org_account_id: ctx.organizationId } });
  if (!result) throw new AppError('Risk not found', 404);
  return result;
};

const create_risk_into_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  assertCanWriteOrgResource(ctx);
  const payload = req.body;
  payload.org_account_id = ctx.organizationId;
  const result = await prisma.risk.create({ data: payload });
  return result;
};

const update_risk_into_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  assertCanWriteOrgResource(ctx);
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
    const updated = await tx.risk.update({
      where: { id },
      data: { ...safeBody, org_account_id: ctx.organizationId },
    });
    await risk_approval_service.invalidateLiveApprovalsOnEdit(id, ctx, user.accountId, tx);
    return updated;
  });

  return result;
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

  const result = await prisma.risk.delete({ where: { id } });
  return result;
};

export const risk_service = {
  get_all_risk_from_db,
  get_single_risk_from_db,
  create_risk_into_db,
  update_risk_into_db,
  delete_risk_from_db,
};
