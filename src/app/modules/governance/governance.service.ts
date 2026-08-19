import { Request } from 'express';
import { prisma } from '../../lib/prisma.js';
import { JwtPayloadType } from '../../utils/JWT.js';
import { LineOfDefenseValue } from '../../utils/line_of_defense_review.js';
import { applyActionScope, resolveCallerOrgContext } from '../../utils/org_scope.js';
import { compute_kri_status } from '../kri/kri.service.js';

/**
 * Issue #97 — "Three Lines of Defense" governance classification board.
 *
 * Fullbloom's reference (ThreeLinesOfDefensePage.tsx) renders one board with
 * every classified entity across 6 tables. Our schema doesn't split
 * "mitigations"/"audit findings" into their own tables — Action already
 * covers both — so this endpoint fans out across our 5 models (Risk, Action,
 * Kri, ComplianceObligation, AuditEngagement) instead of Fullbloom's 6, and
 * returns them as one combined, org-scoped payload rather than making the
 * frontend issue 5 separate requests and merge them itself.
 *
 * Each row is shaped as { id, title, line_of_defense, ...secondary fields },
 * where `title` is that entity's display name and the secondary fields are
 * whatever 1-2 owner/status-equivalent columns actually exist on the model
 * (they don't line up 1:1 with Fullbloom's own schema).
 */

type LineReviewSummary = {
  line: LineOfDefenseValue;
  reviewedById: string;
  reviewedAt: Date;
};

type ThreeLinesRow = {
  id: string;
  title: string;
  // aexa-frontend#208: GOVERNING_BODY added as a 4th value to the shared
  // LineOfDefense enum — kept in sync here since this type isn't derived
  // from the Prisma-generated enum type.
  //
  // OWNERSHIP: which single line is responsible for this item. Unchanged by
  // #97's line-review addition below.
  line_of_defense: LineOfDefenseValue | null;
  // COVERAGE: every line that has independently reviewed this item and
  // hasn't since been invalidated by an edit (invalidatedAt: null) -- see
  // line_of_defense_review.ts's file comment for why this is a separate
  // fact from ownership above, not a replacement for it. Zero or more
  // entries; a fresh item with no reviews yet is an empty array, not null.
  line_reviews: LineReviewSummary[];
};

const LINE_REVIEW_SELECT = {
  where: { invalidatedAt: null },
  select: { line: true, reviewedById: true, reviewedAt: true },
  orderBy: { line: 'asc' as const },
};

const get_three_lines_of_defense_from_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);

  // Action is the only one of the 5 models with an existing role-based scope
  // helper (applyActionScope — Lead Auditor/Viewer scoped to their assigned
  // inspections, Light User to their sub-assigned findings). Risk, Kri,
  // ComplianceObligation and AuditEngagement have no such helper anywhere
  // else in this codebase; every existing list endpoint for those 4 scopes
  // by the plain org_account_id filter alone, so this board matches that
  // same per-model precedent rather than inventing new scoping rules.
  const actionWhere = await applyActionScope({ orgAccountId: ctx.organizationId }, ctx);

  const [risks, actions, kris, complianceObligations, auditEngagements] = await Promise.all([
    prisma.risk.findMany({
      where: { org_account_id: ctx.organizationId },
      select: {
        id: true,
        name: true,
        category: true,
        status: true,
        line_of_defense: true,
        lineReviews: LINE_REVIEW_SELECT,
      },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.action.findMany({
      where: actionWhere,
      select: {
        id: true,
        actionTitle: true,
        priority: true,
        status: true,
        line_of_defense: true,
        lineReviews: LINE_REVIEW_SELECT,
      },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.kri.findMany({
      where: { org_account_id: ctx.organizationId },
      select: {
        id: true,
        name: true,
        unit: true,
        current_value: true,
        alert_threshold: true,
        target_value: true,
        line_of_defense: true,
        lineReviews: LINE_REVIEW_SELECT,
      },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.complianceObligation.findMany({
      where: { org_account_id: ctx.organizationId },
      select: {
        id: true,
        title: true,
        domain: true,
        status: true,
        line_of_defense: true,
        lineReviews: LINE_REVIEW_SELECT,
      },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.auditEngagement.findMany({
      where: { org_account_id: ctx.organizationId },
      select: {
        id: true,
        title: true,
        status: true,
        lead_auditor: true,
        line_of_defense: true,
        lineReviews: LINE_REVIEW_SELECT,
      },
      orderBy: { createdAt: 'desc' },
    }),
  ]);

  return {
    risks: risks.map((risk): ThreeLinesRow & { category: string; status: string } => ({
      id: risk.id,
      title: risk.name,
      category: risk.category,
      status: risk.status,
      line_of_defense: risk.line_of_defense,
      line_reviews: risk.lineReviews,
    })),
    actions: actions.map((action): ThreeLinesRow & { priority: string; status: string } => ({
      id: action.id,
      title: action.actionTitle,
      // Action.line_of_defense is nullable (see action.prisma) — existing
      // rows created before #97 surface here as null, which the frontend
      // renders as an "Unclassified" bucket rather than defaulting to any
      // one line (there is no correct guess for a pre-existing Action).
      priority: action.priority,
      status: action.status,
      line_of_defense: action.line_of_defense,
      line_reviews: action.lineReviews,
    })),
    kris: kris.map((kri): ThreeLinesRow & { unit: string; status: string } => ({
      id: kri.id,
      title: kri.name,
      unit: kri.unit,
      // Kri has no stored `status` column — it's derived from
      // current_value/alert_threshold/target_value (see kri.service.ts's
      // compute_kri_status), same as every other Kri read endpoint.
      status: compute_kri_status(kri.current_value, kri.alert_threshold, kri.target_value),
      line_of_defense: kri.line_of_defense,
      line_reviews: kri.lineReviews,
    })),
    complianceObligations: complianceObligations.map(
      (obligation): ThreeLinesRow & { domain: string; status: string } => ({
        id: obligation.id,
        title: obligation.title,
        domain: obligation.domain,
        status: obligation.status,
        line_of_defense: obligation.line_of_defense,
        line_reviews: obligation.lineReviews,
      }),
    ),
    auditEngagements: auditEngagements.map(
      (engagement): ThreeLinesRow & { status: string; lead_auditor: string | null } => ({
        id: engagement.id,
        title: engagement.title,
        status: engagement.status,
        lead_auditor: engagement.lead_auditor,
        line_of_defense: engagement.line_of_defense,
        line_reviews: engagement.lineReviews,
      }),
    ),
  };
};

export const governance_service = {
  get_three_lines_of_defense_from_db,
};
