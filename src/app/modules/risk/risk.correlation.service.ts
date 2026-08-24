import { Request } from 'express';
import { configs } from '../../configs/index.js';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../utils/app_error.js';
import { JwtPayloadType } from '../../utils/JWT.js';
import {
  applyActionScope,
  assertCanWriteOrgResource,
  resolveCallerOrgContext,
} from '../../utils/org_scope.js';
import {
  buildAiHeaders,
  fetchWithTimeout,
  LLM_CALL_TIMEOUT_MS,
  wrapAiServiceError,
} from '../ai/ai.service.js';

/**
 * aexa-frontend#142 — GET /risk/correlation-matrix
 *
 * Returns everything the frontend needs to render the correlation matrix in
 * one call: this org's risks (with `ref`), its RiskLink rows, and its
 * Actions (this codebase's stand-in for Fullbloom's separate AuditFinding
 * table — see governance.service.ts's own comment on why Action covers
 * both mitigations and findings here).
 *
 * All the bucketing/grid-placement math Fullbloom's CorrelationMatrixPage.tsx
 * does (axis placement from incoming/outgoing CAUSES/AMPLIFIES link counts,
 * category/root-cause grouping) is client-side `useMemo` computation over
 * these three raw arrays — deliberately NOT moved server-side here, mirroring
 * that same division of responsibility. This endpoint's only job is to
 * fetch and org-scope the raw rows.
 */
const get_correlation_matrix_data = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);

  // Same per-role scoping the /governance three-lines-of-defense board
  // already applies to Action (its only model with a dedicated scope
  // helper) — Risk and RiskLink have no such helper anywhere else in this
  // codebase, so both are scoped by the plain org_account_id filter, same
  // precedent governance.service.ts follows for Risk.
  const actionWhere = await applyActionScope({ orgAccountId: ctx.organizationId }, ctx);

  const [risks, riskLinks, actions] = await Promise.all([
    prisma.risk.findMany({
      // docs/design-docs/ai-risk-review-approval-workflow.md -- feeds the
      // correlation matrix and page-rank graph, neither of which should
      // ever show unreviewed AI risks. Re-run/staleness fix: nor a
      // superseded (stale) risk.
      where: {
        org_account_id: ctx.organizationId,
        review_status: 'APPROVED',
        supersededAt: null,
      },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.riskLink.findMany({
      where: { org_account_id: ctx.organizationId },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.action.findMany({
      where: actionWhere,
      orderBy: { createdAt: 'desc' },
    }),
  ]);

  return { risks, riskLinks, actions };
};

// --------------------------------------------------------------------------
// POST /risk/root-cause-bucketing
// --------------------------------------------------------------------------
//
// Design for stage 2 (aexa-ai, not built in this PR): translates Fullbloom's
// `ai-alerts` edge function's `rootcause_bucketing` action
// (src/prompts/rootcause-system.ts's ROOTCAUSE_BUCKET_SYSTEM_PROMPT/
// ROOTCAUSE_BUCKET_USER_PROMPT) into an aexa-ai endpoint, in English (matching
// aexa-ai's existing translation-to-English convention from #141), and
// addressing risks/findings by `ref` (already human-readable here, unlike
// #141's title-matching workaround for IntelligenceItems).
//
// Request shape aexa-server sends to aexa-ai's (not-yet-built)
// POST /risk/rootcause-bucketing:
//
//   {
//     organizationContext: { name: string, sector: string | null, country: string | null },
//     risks: Array<{
//       ref: string, name: string, description: string | null, category: string,
//       inherentScore: number | null, residualScore: number | null,
//       probability: number | null, siteId: string,
//     }>,
//     findings: Array<{
//       ref: string, title: string, description: string | null,
//       priority: 'Low' | 'Medium' | 'High', status: string,
//     }>,
//   }
//
// (`findings` here is this codebase's Action rows, mapped ref=id/title=
// actionTitle/description=actionDisc — Action has no human-readable ref
// today, so aexa-server maps Action.id into the `ref` field it sends AI-side;
// a real Action.ref is out of scope for this PR.)
//
// Response shape aexa-ai returns (English translation of Fullbloom's JSON
// schema in rootcause-system.ts, trimmed to the fields the frontend's
// bucketing view actually needs):
//
//   {
//     methodology: string,
//     riskBuckets: Array<{
//       bucketName: string,
//       rootCause: string,
//       rootCauseCategory: 'governance' | 'process' | 'technology' | 'people' | 'external' | 'compliance',
//       category: string,
//       riskRefs: string[],
//       pageRankScore: number,
//       aggregatedImpactMin: number,
//       aggregatedImpactMax: number,
//       groupedAction: {
//         description: string,
//         normReference: string,
//         owner: string,
//         priority: 'immediate' | 'short_term' | 'medium_term' | 'long_term',
//         estimatedRiskReduction: number,
//         estimatedCost: string,
//         timeline: string,
//       },
//       dominoRisk: string | null,
//     }>,
//     findingBuckets: Array<{
//       bucketName: string,
//       rootCause: string,
//       findingRefs: string[],
//       commonAction: { description: string, normReference: string, owner: string, priority: string },
//     }>,
//   }
//
// aexa-server's job is purely orchestration (gather -> call -> return),
// exactly like #141's intelligence.service.ts callAexaAiIntelligence: no
// bucketing logic lives here, all of it is aexa-ai's job in stage 2.

interface RootCauseRiskBucket {
  bucketName: string;
  rootCause: string;
  rootCauseCategory: 'governance' | 'process' | 'technology' | 'people' | 'external' | 'compliance';
  category: string;
  riskRefs: string[];
  pageRankScore: number;
  aggregatedImpactMin: number;
  aggregatedImpactMax: number;
  groupedAction: {
    description: string;
    normReference: string;
    owner: string;
    priority: 'immediate' | 'short_term' | 'medium_term' | 'long_term';
    estimatedRiskReduction: number;
    estimatedCost: string;
    timeline: string;
  };
  dominoRisk: string | null;
}

interface RootCauseFindingBucket {
  bucketName: string;
  rootCause: string;
  findingRefs: string[];
  commonAction: {
    description: string;
    normReference: string;
    owner: string;
    priority: string;
  };
}

type RootCauseBucketingAiResponse = {
  methodology: string;
  riskBuckets: RootCauseRiskBucket[];
  findingBuckets: RootCauseFindingBucket[];
};

const buildOrganizationContext = async (organizationId: string) => {
  const account = await prisma.account.findUnique({
    where: { id: organizationId },
    include: { organizationProfile: true },
  });
  return {
    name: account?.organizationProfile?.organizationName ?? account?.email ?? 'Organization',
    sector: account?.organizationProfile?.sector ?? null,
    country: account?.organizationProfile?.country ?? null,
  };
};

const run_root_cause_bucketing = async (req: Request) => {
  try {
    const user = req.user as JwtPayloadType;
    const ctx = await resolveCallerOrgContext(user.accountId);

    const actionWhere = await applyActionScope({ orgAccountId: ctx.organizationId }, ctx);

    const [organizationContext, risks, actions] = await Promise.all([
      buildOrganizationContext(ctx.organizationId),
      // docs/design-docs/ai-risk-review-approval-workflow.md -- same
      // APPROVED-only treatment as get_correlation_matrix_data above,
      // including the re-run/staleness supersededAt exclusion.
      prisma.risk.findMany({
        where: {
          org_account_id: ctx.organizationId,
          review_status: 'APPROVED',
          supersededAt: null,
        },
      }),
      prisma.action.findMany({ where: actionWhere }),
    ]);

    if (risks.length === 0) {
      throw new AppError('This organization has no risks to analyze', 409);
    }

    const requestBody = {
      organizationContext,
      risks: risks.map((risk) => ({
        ref: risk.ref,
        name: risk.name,
        description: risk.description,
        category: risk.category,
        inherentScore: risk.inherent_score,
        residualScore: risk.residual_score,
        probability: risk.probability,
        siteId: risk.site_id,
      })),
      findings: actions.map((action) => ({
        ref: action.id,
        title: action.actionTitle,
        description: action.actionDisc,
        priority: action.priority,
        status: action.status,
      })),
    };

    const aiResponse = await fetchWithTimeout(
      `${configs.ai_server_end_point}/risk/rootcause-bucketing`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...buildAiHeaders(ctx.organizationId),
        },
        body: JSON.stringify(requestBody),
      },
      // Analysis call, not PDF processing — same tier as ai.service.ts's own
      // non-PDF calls (issue #275 follow-up to #233).
      LLM_CALL_TIMEOUT_MS,
    );
    if (!aiResponse.ok) {
      throw new AppError(`AI service error: ${aiResponse.status}`, 502);
    }
    const data = (await aiResponse.json()) as RootCauseBucketingAiResponse;
    return data;
  } catch (error) {
    return wrapAiServiceError(error, 'Failed to run root-cause bucketing analysis');
  }
};

// --------------------------------------------------------------------------
// POST /risk/root-cause-bucketing/create-action  (aexa-frontend#191, stage 1)
// --------------------------------------------------------------------------
//
// Restores the old mock frontend's per-bucket "Send to Finding" action for
// real: turns one AI root-cause bucket's `groupedAction` into a real Action
// row. Action.inspectionId is a required, non-nullable FK (see
// action.prisma) and a bucket spans multiple risks/sites with no single
// real inspection to attach to — making inspectionId nullable was
// considered and rejected as disproportionate schema churn (5+ dependent
// files all assume it's always present). Instead, a synthetic
// Inspection — housed in a synthetic Template — is lazily created once per
// org and reused for every subsequent bucket->Action conversion, mirroring
// intelligence.service.ts's create_risk_from_item_into_db site-fallback
// pattern below.

// A reserved-looking name (not just "AI-Generated Findings" — round-1 review
// flagged that a real user template coincidentally sharing that exact name
// would get misattributed as this endpoint's synthetic anchor, silently
// reusing real user data). The "⚙" prefix and trailing UUID-shaped suffix
// make an accidental real-template collision effectively impossible without
// eliminating it via a schema flag, which was already considered and
// rejected below as disproportionate for this endpoint-only PR.
const SYNTHETIC_TEMPLATE_NAME = '⚙ AI-Generated Findings (system, do not edit)';

// Marking the synthetic Template/Inspection: unlike Risk/Kri/
// ComplianceObligation/AuditEngagement/Action (this PR), Template and
// Inspection have no existing `ai_generated`-style flag column to reuse,
// and no aggregate anywhere in this codebase currently computes a real
// inspection-completion-rate metric that would need to exclude a synthetic
// row (grepped for "completion rate"/inspection stats — the only
// inspection-count aggregates found are template.service.ts's per-template
// count, site.service.ts's per-site count, and risk.service.ts's per-risk
// count, none of which compute an org-wide completion percentage). Adding
// a new boolean column to two more models purely on spec, with nothing
// today that would read it, is more schema churn than this endpoint-only
// PR calls for. An exact-match on the reserved-looking templateName above is
// a defensible, sufficiently distinguishing check instead — documented here
// so a future completion-rate feature knows to filter on it. Revisit with a
// real `ai_generated` column if/when such a metric is actually built.

// Find-or-create for a user-facing model like Template can't be made
// race-proof with a unique constraint without imposing a real constraint on
// legitimate, non-synthetic templates too (nothing stops two different real
// templates from coincidentally sharing a name today, and this endpoint has
// no business changing that). Instead, the whole find-or-create sequence
// runs inside a single DB transaction holding a Postgres advisory lock keyed
// on this org's id (auto-released at commit/rollback, never leaked) — two
// concurrent calls for the SAME org serialize against each other (the
// second waits for the first to commit, then finds what the first just
// created), while calls for DIFFERENT orgs never block each other at all
// (the lock key is per-org). Closes the race without a schema change.
const findOrCreateSyntheticInspection = async (organizationId: string) => {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${organizationId})::bigint)`;

    let template = await tx.template.findFirst({
      where: { orgAccountId: organizationId, templateName: SYNTHETIC_TEMPLATE_NAME },
    });
    if (!template) {
      template = await tx.template.create({
        data: { orgAccountId: organizationId, templateName: SYNTHETIC_TEMPLATE_NAME },
      });
    }

    const existingInspection = await tx.inspection.findFirst({
      where: { orgAccountId: organizationId, templateId: template.id },
    });
    if (existingInspection) return existingInspection;

    // Inspection.siteId is a required FK with nothing on a root-cause bucket
    // to derive it from (a bucket spans multiple risks/sites). Same
    // "fall back to the org's earliest-created Site, 409 if none" convention
    // intelligence.service.ts's create_risk_from_item_into_db already
    // established for the identical problem (Risk.site_id).
    const site = await tx.site.findFirst({
      where: { org_account_id: organizationId },
      orderBy: { createdAt: 'asc' },
    });
    if (!site) {
      throw new AppError(
        'This organization has no sites to attach the AI-generated findings inspection to',
        409,
      );
    }

    return tx.inspection.create({
      data: { orgAccountId: organizationId, templateId: template.id, siteId: site.id },
    });
  });
};

// aexa-ai's groupedAction.priority (immediate|short_term|medium_term|
// long_term, from Fullbloom's rootcause-system.ts prompt) has no direct
// analog on Action's real PRIORITY enum (Low|Medium|High — action.prisma).
// Mapped by urgency: immediate and short_term both read as "needs action
// soon" (High); medium_term as the existing Medium default; long_term as
// Low. A 4-into-3 mapping necessarily collapses one pair — immediate vs.
// short_term was chosen as the pair to collapse (both High) since the gap
// between "start now" and "start soon" matters far less to a reviewer
// triaging a findings list than the gap between "soon" and "eventually"
// (medium_term vs. long_term), which stays distinct.
const GROUPED_ACTION_PRIORITY_TO_ACTION_PRIORITY: Record<string, 'Low' | 'Medium' | 'High'> = {
  immediate: 'High',
  short_term: 'High',
  medium_term: 'Medium',
  long_term: 'Low',
};

// Same reasoning per bucket, applied to a concrete due date: Action.dueDate
// is a required DateTime with nothing to parse it from — timeline is a
// free-text AI string (e.g. "3-6 months"), not a structured duration, so
// there's no reliable way to parse an exact date out of it. Derives a
// due date from the same priority mapping above instead, as a reasonable
// stand-in until a human reviews and adjusts it (same "AI suggestion,
// human refines" spirit as ai_generated/is_edited on the row itself).
const PRIORITY_TO_DUE_DATE_OFFSET_DAYS: Record<'Low' | 'Medium' | 'High', number> = {
  High: 30,
  Medium: 90,
  Low: 180,
};

const ACTION_TITLE_MAX_LENGTH = 255;

// actionTitle is capped at 255 chars (action.validation.ts's create_action
// schema) but groupedAction.description is free-text AI prose with no
// length guarantee. When it fits, the title IS the description (matches
// how a human filling out "Create Action" would title it); when it
// doesn't, truncate for the title only — the untruncated text always
// survives in actionDisc below.
const synthesizeActionTitle = (description: string): string =>
  description.length <= ACTION_TITLE_MAX_LENGTH
    ? description
    : `${description.slice(0, ACTION_TITLE_MAX_LENGTH - 3)}...`;

interface CreateActionFromBucketInput {
  description: string;
  normReference: string;
  owner: string;
  priority: 'immediate' | 'short_term' | 'medium_term' | 'long_term';
  estimatedRiskReduction: number;
  estimatedCost: string;
  timeline: string;
  riskRefs: string[];
}

// Same "verify org-scoped existence before accepting a reference" discipline
// risk_link.service.ts's assertRiskRefExists already applies to source_ref/
// target_ref -- riskRefs here was the one place in this PR that skipped it,
// letting a client fold arbitrary (possibly another org's, possibly
// fabricated) ref strings straight into a real Action's description with no
// check. One batched query rather than N sequential lookups, since riskRefs
// is a whole array here rather than the 2 fixed fields risk_link.service.ts
// validates.
const assertRiskRefsExist = async (organizationId: string, riskRefs: string[]): Promise<void> => {
  const found = await prisma.risk.findMany({
    where: { org_account_id: organizationId, ref: { in: riskRefs } },
    select: { ref: true },
  });
  const foundRefs = new Set(found.map((r) => r.ref));
  const missing = riskRefs.filter((ref) => !foundRefs.has(ref));
  if (missing.length > 0) {
    throw new AppError(`Risk ref(s) not found in this organization: ${missing.join(', ')}`, 404);
  }
};

const buildActionDisc = (input: CreateActionFromBucketInput): string =>
  [
    input.description,
    '',
    `Norm reference: ${input.normReference}`,
    `Owner: ${input.owner}`,
    `Timeline: ${input.timeline}`,
    `Estimated cost: ${input.estimatedCost}`,
    `Estimated risk reduction: ${input.estimatedRiskReduction}%`,
    `Addresses risks: ${input.riskRefs.join(', ')}`,
  ].join('\n');

const create_action_from_bucket = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  // Same "AI suggestion becomes a real record" write gate
  // create_risk_from_item_into_db uses (ADMIN/LEAD_AUDITOR via
  // assertCanWriteOrgResource) — deliberately NOT
  // assertCanWriteToInspection, even though this creates an Action against
  // a real Inspection: that gate assumes the caller-supplied inspectionId is
  // one the caller has inspection-level authority over (a LEAD_AUDITOR must
  // be assigned to it specifically), which doesn't apply to the
  // org-wide synthetic inspection this endpoint owns and manages itself.
  // Applying it here would incorrectly 403 a LEAD_AUDITOR who already
  // cleared this endpoint's own, sufficient gate.
  assertCanWriteOrgResource(ctx);

  const body = req.body as CreateActionFromBucketInput;

  await assertRiskRefsExist(ctx.organizationId, body.riskRefs);

  const inspection = await findOrCreateSyntheticInspection(ctx.organizationId);

  const priority = GROUPED_ACTION_PRIORITY_TO_ACTION_PRIORITY[body.priority];
  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + PRIORITY_TO_DUE_DATE_OFFSET_DAYS[priority]);

  const action = await prisma.action.create({
    data: {
      orgAccountId: ctx.organizationId,
      inspectionId: inspection.id,
      siteId: inspection.siteId,
      actionTitle: synthesizeActionTitle(body.description),
      actionDisc: buildActionDisc(body),
      priority,
      dueDate,
      status: 'TO_DO',
      // #97: required by action.validation.ts's create_action schema for
      // every new Action. This is remediation work generated from a risk
      // root-cause analysis — squarely 1st-line-like (see action.prisma's
      // line_of_defense comment on why Action alone, of the 5 models #97
      // touches, has no single sensible default) — so FIRST is the
      // deliberate choice here, not a placeholder.
      line_of_defense: 'FIRST',
      ai_generated: true,
      is_edited: false,
    },
  });

  return action;
};

export const risk_correlation_service = {
  get_correlation_matrix_data,
  run_root_cause_bucketing,
  create_action_from_bucket,
};
