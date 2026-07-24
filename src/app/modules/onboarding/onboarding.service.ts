import { Request } from 'express';
import { configs } from '../../configs/index.js';
import { logger } from '../../lib/logger.js';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../utils/app_error.js';
import { AI_INTERNAL_SECRET_HEADER } from '../ai/ai.service.js';
import {
  assertEmailAvailable,
  createOrgAccount,
  type PrismaTxClient,
} from '../organization/organization.create.service.js';
import { onboarding_validations, type OnboardingCommitInput } from './onboarding.validation.js';

// Same posture as ai.service.ts's wrapAiServiceError: our own crafted
// AppErrors (validation 400s, upstream-status 502s) are client-safe and
// rethrown unchanged; anything else (raw fetch/Prisma/Zod errors that could
// carry internal detail) is logged server-side and replaced with a generic
// message.
const wrapError = (error: unknown, fallbackMessage: string): never => {
  if (error instanceof AppError) {
    throw error;
  }
  logger.error({ err: error }, fallbackMessage);
  throw new AppError(fallbackMessage, 500);
};

async function callAi(path: string, body: unknown): Promise<any> {
  const response = await fetch(`${configs.ai_server_end_point}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...AI_INTERNAL_SECRET_HEADER,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new AppError(`AI service error: ${response.status}`, 502);
  }
  return response.json();
}

// --- Stage 1: Identify -------------------------------------------------------
const identify_company = async (req: Request) => {
  try {
    const { company_name } = req.body;
    const profile = await callAi('/company-profile', { company_name });
    return profile;
  } catch (error) {
    return wrapError(error, 'Failed to identify company');
  }
};

// Maps one raw aexa-ai /risk_analysis risk into a Risk-model-shaped draft, so
// the review screen and the commit endpoint both speak the Risk model's
// language rather than the LLM's ad-hoc field casing.
function mapAiRiskToDraft(raw: any) {
  const probability =
    typeof raw?.Probability === 'number' ? Math.round(raw.Probability * 100) : null;
  const score = typeof raw?.score === 'number' ? raw.score : null;
  return {
    name: String(raw?.title ?? '').trim(),
    description: String(raw?.description ?? '').trim() || null,
    category: String(raw?.category ?? '').trim() || 'Operational',
    inherent_score: score,
    residual_score: null as number | null,
    probability,
    velocity: raw?.Velocity ? String(raw.Velocity) : null,
    trend: raw?.Trend ? String(raw.Trend) : null,
    status: 'open',
    source_info: null as string | null,
    financial_impact_min: null as number | null,
    financial_impact_max: null as number | null,
    // Display-only labels the LLM produced — carried through for the review
    // UI, stripped by the commit schema (which is Risk-model-shaped).
    inherent_label: raw?.inherent_risk_score ? String(raw.inherent_risk_score) : null,
    residual_label: raw?.residual_risk_score ? String(raw.residual_risk_score) : null,
    responsible: raw?.Responsable ? String(raw.Responsable) : null,
    kris: [] as Array<Record<string, unknown>>,
  };
}

// --- Stage 3: Generate baseline (not persisted) -----------------------------
const generate_baseline = async (req: Request) => {
  try {
    const { sites } = req.body as {
      sites: Array<Record<string, string | null | undefined>>;
    };

    const draftSites = [] as Array<Record<string, unknown>>;
    for (const site of sites) {
      // /risk_analysis rejects an empty site_primary_activity — fall back to a
      // neutral phrase so a site the AI discovered without an activity blurb
      // still yields starter risks rather than 400ing the whole batch.
      const primaryActivity =
        (site.site_primary_activity && String(site.site_primary_activity).trim()) ||
        `General operations at ${site.site_name}`;

      const aiResponse = await callAi('/risk_analysis', {
        site_name: site.site_name,
        site_location: site.site_location || '',
        site_legal_entity: site.site_legal_entity || '',
        site_primary_activity: primaryActivity,
        site_country: site.site_country || '',
        site_revenue: site.site_revenue || '',
        site_employees: site.site_employees || '',
        site_type: site.site_type || '',
      });

      const risks = Array.isArray(aiResponse?.risks)
        ? aiResponse.risks.map(mapAiRiskToDraft).filter((r: any) => r.name)
        : [];

      draftSites.push({ ...site, risks });
    }

    // One /kri-baseline call for every category present across all sites, then
    // attach each category's KRI templates to the FIRST risk of that category
    // within each site — so a Kri lands under exactly one risk (no dupes) and
    // has an unambiguous parent for the commit transaction.
    const categories = Array.from(
      new Set(
        draftSites.flatMap((s: any) => (s.risks as any[]).map((r) => r.category).filter(Boolean)),
      ),
    );

    let kriBaselines: any[] = [];
    if (categories.length > 0) {
      const kriResponse = await callAi('/kri-baseline', { categories });
      kriBaselines = Array.isArray(kriResponse?.kri_baselines) ? kriResponse.kri_baselines : [];
    }

    const kriByCategory = new Map<string, any[]>();
    for (const kri of kriBaselines) {
      const key = String(kri?.category ?? '').toLowerCase();
      const list = kriByCategory.get(key) ?? [];
      list.push({
        name: kri.name,
        unit: kri.unit ?? '',
        current_value: 0,
        alert_threshold: kri.alert_threshold ?? 0,
        target_value: kri.target_value ?? 0,
        frequency: kri.frequency ?? null,
        direction: kri.direction ?? null,
        is_suggested_threshold: kri.is_suggested_threshold ?? true,
      });
      kriByCategory.set(key, list);
    }

    for (const site of draftSites) {
      const seenCategories = new Set<string>();
      for (const risk of (site as any).risks as any[]) {
        const key = String(risk.category ?? '').toLowerCase();
        if (seenCategories.has(key)) continue;
        seenCategories.add(key);
        const templates = kriByCategory.get(key);
        if (templates) {
          risk.kris = templates.map((t) => ({ ...t }));
        }
      }
    }

    return { sites: draftSites };
  } catch (error) {
    return wrapError(error, 'Failed to generate onboarding baseline');
  }
};

// --- Stage 4: Commit (the only step that persists) --------------------------
// Everything — the Account+OrganizationProfile+Organization+OrgMember tenant
// scaffolding, every confirmed Site, Risk and Kri — is created in ONE
// prisma.$transaction. If any single insert throws, Postgres rolls the whole
// thing back: zero rows, never a partially-seeded org. This is the explicit
// fix for Fullbloom's actual bug (8 sequential un-transacted inserts with no
// rollback on partial failure).
const commit_onboarding = async (req: Request) => {
  try {
    const payload = req.body as OnboardingCommitInput;

    // Fail fast on a duplicate email BEFORE opening the transaction, so it's a
    // clean 400 rather than a P2002 aborting a half-built commit.
    await assertEmailAvailable(payload.email);

    const result = await prisma.$transaction(async (tx) => {
      const { account, organization } = await createOrgAccount(tx as unknown as PrismaTxClient, {
        organizationName: payload.organizationName,
        email: payload.email,
        password: payload.password,
        sector: payload.sector ?? null,
        country: payload.country ?? null,
      });

      const orgId = account.id;
      let siteCount = 0;
      let riskCount = 0;
      let kriCount = 0;

      for (const site of payload.sites) {
        const createdSite = await tx.site.create({
          data: {
            org_account_id: orgId,
            name: site.name,
            location: site.location ?? null,
            country: site.country ?? null,
            activity: site.activity ?? null,
            revenue: site.revenue,
            employees_count: site.employees_count,
            site_type: site.site_type,
            ai_generated: true,
            source_info: site.source_info ?? null,
          },
        });
        siteCount += 1;

        for (const risk of site.risks) {
          const createdRisk = await tx.risk.create({
            data: {
              org_account_id: orgId,
              site_id: createdSite.id,
              name: risk.name,
              description: risk.description ?? null,
              category: risk.category,
              inherent_score: risk.inherent_score ?? null,
              residual_score: risk.residual_score ?? null,
              probability: risk.probability ?? null,
              velocity: risk.velocity ?? null,
              trend: risk.trend ?? null,
              status: risk.status,
              ai_generated: true,
              source_info: risk.source_info ?? null,
              financial_impact_min: risk.financial_impact_min ?? null,
              financial_impact_max: risk.financial_impact_max ?? null,
            },
          });
          riskCount += 1;

          for (const kri of risk.kris) {
            await tx.kri.create({
              data: {
                org_account_id: orgId,
                risk_id: createdRisk.id,
                name: kri.name,
                unit: kri.unit,
                current_value: kri.current_value,
                alert_threshold: kri.alert_threshold,
                target_value: kri.target_value,
                frequency: kri.frequency ?? null,
                ai_generated: true,
              },
            });
            kriCount += 1;
          }
        }
      }

      return {
        account,
        organization,
        counts: { sites: siteCount, risks: riskCount, kris: kriCount },
      };
    });

    return result;
  } catch (error) {
    return wrapError(error, 'Failed to create organization from onboarding');
  }
};

export const onboarding_service = {
  identify_company,
  generate_baseline,
  commit_onboarding,
};

// Re-exported for tests that want the pure mapping without the HTTP layer.
export const _internal = { mapAiRiskToDraft };
export { onboarding_validations };
