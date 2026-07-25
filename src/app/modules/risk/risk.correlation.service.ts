import { Request } from 'express';
import { configs } from '../../configs/index.js';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../utils/app_error.js';
import { JwtPayloadType } from '../../utils/JWT.js';
import { applyActionScope, resolveCallerOrgContext } from '../../utils/org_scope.js';
import { AI_INTERNAL_SECRET_HEADER, wrapAiServiceError } from '../ai/ai.service.js';

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
      where: { org_account_id: ctx.organizationId },
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
      prisma.risk.findMany({ where: { org_account_id: ctx.organizationId } }),
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

    const aiResponse = await fetch(`${configs.ai_server_end_point}/risk/rootcause-bucketing`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...AI_INTERNAL_SECRET_HEADER,
      },
      body: JSON.stringify(requestBody),
    });
    if (!aiResponse.ok) {
      throw new AppError(`AI service error: ${aiResponse.status}`, 502);
    }
    const data = (await aiResponse.json()) as RootCauseBucketingAiResponse;
    return data;
  } catch (error) {
    return wrapAiServiceError(error, 'Failed to run root-cause bucketing analysis');
  }
};

export const risk_correlation_service = {
  get_correlation_matrix_data,
  run_root_cause_bucketing,
};
