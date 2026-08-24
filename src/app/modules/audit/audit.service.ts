import { Prisma } from '@prisma/client';
import { Request } from 'express';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../utils/app_error.js';
import { JwtPayloadType } from '../../utils/JWT.js';
import uploadCloud from '../../utils/cloudinary.js';
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

// aexa-frontend#165: shape used everywhere an engagement is returned so the UI
// can render a clickable list of the real risks it covers (id + a
// human-readable label + category), sourced through the explicit
// AuditEngagementRisk join. Ordered oldest-link-first for a stable display.
const auditRiskInclude = {
  risks: {
    orderBy: { createdAt: 'asc' as const },
    include: { risk: { select: { id: true, name: true, category: true } } },
  },
} as const;

type EngagementWithRisks = { risks?: { risk: unknown }[] } & Record<string, unknown>;

// Collapse the join rows into a flat `linked_risks` array on the engagement so
// the API contract is `{ ...engagement, linked_risks: [{id,name,category}] }`
// rather than exposing the join table's internal shape.
const flattenLinkedRisks = <T extends EngagementWithRisks>(engagement: T) => {
  const { risks, ...rest } = engagement;
  return { ...rest, linked_risks: (risks ?? []).map((link) => link.risk) };
};

// De-duplicate and drop blank/non-string ids. The join's
// @@unique([auditEngagementId, riskId]) would otherwise reject a payload that
// repeats the same risk id, and a stray "" id can never match a real risk.
const normalizeRiskIds = (riskIds: unknown): string[] => {
  if (!Array.isArray(riskIds)) return [];
  return [...new Set(riskIds.filter((r): r is string => typeof r === 'string' && r !== ''))];
};

/**
 * aexa-server#244: findings_count was a plain number an admin manually
 * typed into the engagement form (AuditPage.tsx), never derived from any
 * real query — it could simply be wrong. Now that Action has a real
 * auditEngagementId link (action.prisma), this derives the count
 * server-side via a single grouped query (not one COUNT per engagement on a
 * paginated list) and overwrites whatever's in the stored `findings_count`
 * column for every response. Client-supplied findings_count is discarded
 * entirely — see create_audit_into_db/update_audit_into_db, which never
 * write it.
 */
const attachFindingsCounts = async <T extends { id: string }>(
  engagements: T[],
  orgAccountId: string,
): Promise<(T & { findings_count: number })[]> => {
  if (engagements.length === 0) return [];
  const grouped = await prisma.action.groupBy({
    by: ['auditEngagementId'],
    where: {
      auditEngagementId: { in: engagements.map((e) => e.id) },
      orgAccountId,
    },
    _count: { _all: true },
  });
  const countsById = new Map(
    grouped
      .filter((g) => g.auditEngagementId != null)
      .map((g) => [g.auditEngagementId as string, g._count._all]),
  );
  return engagements.map((e) => ({ ...e, findings_count: countsById.get(e.id) ?? 0 }));
};

/**
 * Every supplied risk id must resolve to a Risk in the caller's own org.
 * Without this a caller could link an engagement to another org's Risk UUID
 * (the raw FK accepts it), and the GET response's `risk: { name, category }`
 * join would then leak that foreign org's risk back — a cross-tenant read, and
 * a bogus cross-org relation. Mirrors compliance.service.ts's
 * `assertSiteBelongsToOrg` (a count/`in` variant here since it's a set). An
 * undefined/empty set means "no links to validate". See aexa-frontend#165.
 */
const assertRisksBelongToOrg = async (riskIds: unknown, orgAccountId: string): Promise<void> => {
  const ids = normalizeRiskIds(riskIds);
  if (ids.length === 0) return;
  const found = await prisma.risk.count({
    where: { id: { in: ids }, org_account_id: orgAccountId },
  });
  if (found !== ids.length) {
    throw new AppError('One or more linked risks were not found in your organization', 404);
  }
  // docs/design-docs/ai-risk-review-approval-workflow.md -- same guard as
  // risk_link.service.ts's assertRiskRefExists / kri.service.ts's
  // create_kri_into_db / compliance.service.ts's link_risk_to_obligation.
  const dismissedCount = await prisma.risk.count({
    where: { id: { in: ids }, org_account_id: orgAccountId, review_status: 'DISMISSED' },
  });
  if (dismissedCount > 0) {
    throw new AppError('One or more linked risks were dismissed and cannot be linked.', 409);
  }
  // Re-run/staleness fix: same guard extended to a superseded risk.
  const supersededCount = await prisma.risk.count({
    where: { id: { in: ids }, org_account_id: orgAccountId, supersededAt: { not: null } },
  });
  if (supersededCount > 0) {
    throw new AppError('One or more linked risks were superseded and cannot be linked.', 409);
  }
};

const get_all_audit_from_db = async (req: Request) => {
  const { searchTerm, page, limit } = req.query;
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);

  const pagination = paginationHelper({ page: page as string, limit: limit as string });
  const { skip, limit: limitNumber } = pagination;

  const whereCondition: Prisma.AuditEngagementWhereInput = {
    org_account_id: ctx.organizationId,
    ...(searchTerm && {
      OR: [
        {
          title: {
            contains: searchTerm as string,
            mode: 'insensitive',
          },
        },
        {
          ref: {
            contains: searchTerm as string,
            mode: 'insensitive',
          },
        },
        {
          lead_auditor: {
            contains: searchTerm as string,
            mode: 'insensitive',
          },
        },
      ],
    }),
  };

  const [data, total] = await Promise.all([
    prisma.auditEngagement.findMany({
      where: whereCondition,
      skip,
      take: limitNumber,
      orderBy: {
        createdAt: 'desc',
      },
      include: auditRiskInclude,
    }),
    prisma.auditEngagement.count({
      where: whereCondition,
    }),
  ]);

  const flattened = data.map(flattenLinkedRisks);
  return {
    data: await attachFindingsCounts(flattened, ctx.organizationId),
    meta: buildPaginationMeta(pagination, total),
  };
};

const get_single_audit_from_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  const id = req.params?.id as string;
  const result = await prisma.auditEngagement.findUnique({
    where: { id, org_account_id: ctx.organizationId },
    include: auditRiskInclude,
  });
  // Every sibling module's get_single_* throws 404 for a missing/cross-org
  // record rather than returning a bare 200 with data: null.
  if (!result) throw new AppError('Audit engagement not found', 404);
  const [withCount] = await attachFindingsCounts([flattenLinkedRisks(result)], ctx.organizationId);
  return withCount;
};

const create_audit_into_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  assertCanWriteOrgResource(ctx);
  // Pull riskIds out of the payload — they're a relation, not a column, so they
  // must become nested join-row writes rather than a scalar field. Validate the
  // set belongs to the caller's org before any link row is written.
  //
  // aexa-server#244: findings_count is also pulled out and discarded — a
  // brand-new engagement has no linked findings yet regardless of what the
  // client sends (findings link to it via Action.auditEngagementId AFTER
  // this engagement exists), and it's never trusted as client input anyway.
  const { riskIds, findings_count: _ignoredCount, ...payload } = req.body;
  await assertRisksBelongToOrg(riskIds, ctx.organizationId);
  payload.org_account_id = ctx.organizationId;
  const linkIds = normalizeRiskIds(riskIds);
  const result = await prisma.auditEngagement.create({
    data: {
      ...payload,
      ...(linkIds.length > 0 ? { risks: { create: linkIds.map((riskId) => ({ riskId })) } } : {}),
    },
    include: auditRiskInclude,
  });
  const [withCount] = await attachFindingsCounts([flattenLinkedRisks(result)], ctx.organizationId);
  return withCount;
};

const update_audit_into_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  assertCanWriteOrgResource(ctx);
  // aexa-frontend#208: third-line independence — an ADMIN (management) must
  // not be able to reclassify a third-line AuditEngagement's own
  // classification. Only checked when line_of_defense is actually part of
  // this update.
  if (req.body.line_of_defense !== undefined) {
    assertCanReassignLineOfDefense(ctx, 'AUDIT_LINE');
  }
  const id = req.params.id as string;
  const existing = await prisma.auditEngagement.findFirst({
    where: { id, org_account_id: ctx.organizationId },
  });
  if (!existing) throw new AppError('Audit engagement not found', 404);
  // Never trust org_account_id from the request body on an update — an
  // authorized (ADMIN/LEAD_AUDITOR) caller could otherwise reassign an
  // engagement to a different org's anchor account id, a cross-tenant
  // integrity issue even though ownership of the *existing* row was verified
  // above. Same guard site.service.ts applies. (RequestValidator already
  // strips org_account_id since it's not in the zod schema, but stripping it
  // here too keeps the service safe independent of the route wiring.)
  //
  // riskIds is also pulled out: it's a relation, not a scalar column, and its
  // presence is significant — an OMITTED riskIds leaves the existing links
  // untouched (partial update), while an explicit array (including []) is a
  // full replacement of the link set. See aexa-frontend#165.
  //
  // aexa-server#244: findings_count is pulled out and discarded too — never
  // trusted as client input, see attachFindingsCounts.
  const {
    org_account_id: _ignored,
    riskIds,
    findings_count: _ignoredCount,
    ...safeBody
  } = req.body;
  await assertRisksBelongToOrg(riskIds, ctx.organizationId);
  // deleteMany + create nested inside the one update runs in a single Prisma
  // transaction, so the old links are never dropped without the new ones
  // landing (or the whole update rolling back together).
  const riskRelationWrite =
    riskIds === undefined
      ? {}
      : {
          risks: {
            deleteMany: {},
            create: normalizeRiskIds(riskIds).map((riskId) => ({ riskId })),
          },
        };
  // Keep org_account_id in the update's own where-clause (not just the
  // findFirst check above): the ownership check and the write are two separate
  // statements, so scoping the write by id alone leaves a TOCTOU window. Adding
  // the org filter here makes the write org-scoped independent of the check,
  // matching delete_audit_from_db's where-clause below.
  const result = await prisma.auditEngagement.update({
    where: { id, org_account_id: ctx.organizationId },
    data: { ...safeBody, org_account_id: ctx.organizationId, ...riskRelationWrite },
    include: auditRiskInclude,
  });
  // #97: a review is a fact about the engagement's content AT the time it was
  // reviewed. An edit here makes every live review stale for the same reason
  // risk.service.ts's update_risk_into_db invalidates its own live reviews —
  // see line_of_defense_review.ts's invalidateLiveLineReviews.
  await invalidateLiveLineReviews(prisma.auditEngagementLineReview, 'auditEngagementId', id);
  const [withCount] = await attachFindingsCounts([flattenLinkedRisks(result)], ctx.organizationId);
  return withCount;
};

/**
 * #97: records that `line` independently reviewed this audit engagement,
 * superseding any prior live review for that same line. Kept separate from
 * update_audit_into_db (assigning ownership/classification) -- see
 * line_of_defense_review.ts's file comment for why ownership and review
 * coverage are different facts, not the same field.
 */
const record_audit_engagement_line_review = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  const id = req.params.id as string;
  const existing = await prisma.auditEngagement.findFirst({
    where: { id, org_account_id: ctx.organizationId },
  });
  if (!existing) throw new AppError('Audit engagement not found', 404);

  const { line, notes } = req.body as { line: LineOfDefenseValue; notes?: string };
  assertCanRecordLineReview(ctx, line);
  await recordLineReview(
    prisma.auditEngagementLineReview,
    'auditEngagementId',
    id,
    user.accountId,
    line,
    notes,
  );

  return prisma.auditEngagementLineReview.findMany({
    where: { auditEngagementId: id, invalidatedAt: null },
    orderBy: { line: 'asc' },
  });
};

const delete_audit_from_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  assertCanWriteOrgResource(ctx);
  const id = req.params.id as string;
  // Existence check before delete, matching every sibling module — deleting a
  // missing/cross-org id would otherwise fall through to Prisma's raw P2025
  // "record to delete does not exist" (a 500) instead of the clean 404 the
  // rest of the API returns.
  //
  // No in-use guard is needed here. The only rows that FK onto an
  // AuditEngagement are its AuditEngagementRisk link rows (aexa-frontend#165),
  // which are onDelete: Cascade and carry no data of their own — deleting an
  // engagement legitimately tears down just its own links while every linked
  // Risk survives untouched. (The reverse asymmetry — a Risk that still has
  // links is BLOCKED from deletion — lives in risk.service.ts, since a link is
  // meaningful audit-trail data that must not vanish out from under an audit.)
  const existing = await prisma.auditEngagement.findFirst({
    where: { id, org_account_id: ctx.organizationId },
  });
  if (!existing) throw new AppError('Audit engagement not found', 404);
  const result = await prisma.auditEngagement.delete({
    where: { id, org_account_id: ctx.organizationId },
  });
  return result;
};

/**
 * Uploads an audit report file to storage (Cloudinary/S3) and returns its URL.
 * Two-step flow identical to compliance.service.ts's
 * upload_compliance_attachment_into_aws: the frontend uploads the file here
 * first, then persists the returned URL onto the engagement's `report_url`
 * via a normal PATCH /audit/:id — so this endpoint itself doesn't touch any
 * AuditEngagement row and only needs auth + write-role, not an org-scoped
 * lookup. Response shape ({ url }) matches the compliance endpoint the frontend
 * upload helper already expects. The role gate is applied so a read-only VIEWER
 * can't push files into org storage.
 */
const upload_audit_report_into_storage = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  assertCanWriteOrgResource(ctx);
  const file = req.file;
  if (!file) {
    throw new AppError('File is required', 400);
  }
  const result = await uploadCloud(file);
  return { url: result.secure_url };
};

export const audit_service = {
  get_all_audit_from_db,
  get_single_audit_from_db,
  create_audit_into_db,
  update_audit_into_db,
  delete_audit_from_db,
  upload_audit_report_into_storage,
  record_audit_engagement_line_review,
};
