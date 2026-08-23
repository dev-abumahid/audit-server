import { Prisma, Site } from '@prisma/client';
import { Request } from 'express';
import { configs } from '../../configs/index.js';
import { logger } from '../../lib/logger.js';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../utils/app_error.js';
import { JwtPayloadType } from '../../utils/JWT.js';
import {
  assertCanWriteOrgResource,
  CallerOrgContext,
  resolveCallerOrgContext,
} from '../../utils/org_scope.js';
import {
  buildAiHeaders,
  fetchWithTimeout,
  LLM_CALL_TIMEOUT_MS,
  wrapAiServiceError,
} from '../ai/ai.service.js';
import { computeEbitdaAtRisk } from '../risk/ebitda_risk.js';
import { resolveEbitdaFields } from '../risk/ebitda_risk.js';
import { createRiskWithGeneratedRef } from '../risk/risk_ref.js';
import { resolveInherentFields, resolveResidualFields } from '../risk/risk_scoring.js';

// design-docs/site-ai-risk-register-generation.md §4: the same 20 fixed
// categories already in the app, matching aexa-ai's RiskCategory enum
// exactly (app/schemas/risk_triage_schema.py) -- kept in sync by hand,
// same keep-in-sync-by-hand caveat as that repo's own enum comments,
// there is no shared schema source between the two codebases.
const RISK_CATEGORIES = [
  'supply_chain',
  'financial',
  'regulatory',
  'cyber',
  'operational',
  'hr',
  'strategic',
  'ehs',
  'geopolitical',
  'natural_disaster',
  'technology',
  'reputational',
  'compliance',
  'ai_emerging',
  'fire',
  'electrical',
  'atex',
  'machine_safety',
  'environmental',
  'security_physical',
] as const;
type RiskCategoryValue = (typeof RISK_CATEGORIES)[number];

// design-docs §4: "Existing app enums the prompt must target exactly,"
// verified from RiskFormModal.tsx -- same values risk_category_generation_
// schema.py's Velocity/Trend enums target on the aexa-ai side.
const VALID_VELOCITY = new Set(['critical', 'high', 'medium', 'low']);
const VALID_TREND = new Set(['increasing', 'decreasing', 'none']);

// design-docs §7: cap site description/activity at 2,000 chars before they
// reach any prompt -- the single most realistic failure mode identified in
// review is a long, legitimately-authored description with
// instructional-sounding language duplicated into every parallel category
// call at once.
const MAX_PROMPT_FIELD_LENGTH = 2000;

// design-docs §6: 10-minute re-run cooldown per site, caps the cost-abuse
// vector the engineering review flagged.
const RERUN_COOLDOWN_MS = 10 * 60 * 1000;

// design-docs §7: fire the N parallel Phase 2 calls with a small stagger
// rather than a separate pre-warm call, so the shared static
// framework-reference prefix has a chance to benefit from OpenAI prompt
// caching.
const CATEGORY_CALL_STAGGER_MS = 300;

const MAX_EXISTING_RISKS_FOR_DEDUP = 200;
const MAX_EXISTING_RISK_TITLE_LENGTH = 200;
const MAX_REGULATORY_FRAMEWORKS = 50;

// design-docs/site-ai-risk-register-generation.md §6: the free-text
// "existing risks" prompt hint sent to aexa-ai (below) is explicitly
// documented as a *soft* hint only -- it doesn't guarantee anything, and in
// practice the model doesn't reliably honor it across ~16 parallel category
// calls that all see the same list. The design doc calls for an ENFORCED
// server-side layer at persist time: this is it. 0.8 is deliberately
// conservative -- a regenerated risk almost always keeps most of its
// distinguishing words even when reworded ("Ransomware attack on production
// systems" vs "Production systems ransomware risk"), while two genuinely
// different risks in the same category rarely share 80%+ of their words.
const DUPLICATE_TITLE_SIMILARITY_THRESHOLD = 0.8;

type TriageCategoryResult = {
  category: string;
  applies: boolean;
  reasoning: string;
  estimated_risk_count: number;
};

// design-docs §3/§5: the curated table's real seeded shapes vary per
// framework -- Sapin II uses { min_employees, min_revenue_eur }, Devoir de
// Vigilance uses { min_employees_france, min_employees_worldwide } (no
// revenue at all), CSRD adds a third { min_balance_sheet_eur } dimension
// Site has no data for, Loi Waserman uses only { min_employees }. §10's
// literal "min_employees/min_revenue_eur" formula only covers Sapin II's
// shape -- meetsApplicabilityThreshold below generalizes it to the other
// real shapes instead of silently no-op'ing (review finding: the
// single-shape version evaluated an unrecognized/differently-keyed
// threshold as vacuously met, failing open exactly for the frameworks §10
// names as its targets).
type ApplicabilityThreshold = {
  min_employees?: number;
  min_revenue_eur?: number;
  min_employees_france?: number;
  min_employees_worldwide?: number;
  min_balance_sheet_eur?: number;
};

// Record<keyof ApplicabilityThreshold, true> (rather than a plain string
// array) makes TypeScript itself enforce that this list stays in sync with
// ApplicabilityThreshold's fields -- a future field added to one without
// the other is a compile error, not a silent gap in what
// hasKnownNumericThreshold recognizes.
const THRESHOLD_KEY_FLAGS: Record<keyof ApplicabilityThreshold, true> = {
  min_employees: true,
  min_revenue_eur: true,
  min_employees_france: true,
  min_employees_worldwide: true,
  min_balance_sheet_eur: true,
};
const KNOWN_THRESHOLD_KEYS = Object.keys(THRESHOLD_KEY_FLAGS) as (keyof ApplicabilityThreshold)[];

/**
 * True only when the threshold object actually contains at least one of
 * the recognized numeric keys this deterministic check knows how to
 * evaluate. Most of the curated table's non-null applicability_threshold
 * values are qualitative `{ note: '...' }` objects steering the model's
 * judgment (ATEX, ICPE, CBAM, the AI Act, ...), not arithmetic gates --
 * design-docs §10 scopes THIS deterministic check to Sapin II/Devoir de
 * Vigilance/CSRD specifically, not every framework carrying any threshold
 * object at all. A review round caught a regression here: an earlier
 * version treated "unrecognized shape" as "check fails," silently
 * downgrading every citation to those ~10 qualitative-threshold
 * frameworks regardless of how well-grounded the citation actually was.
 * Call this BEFORE meetsApplicabilityThreshold and skip the downgrade
 * entirely when it's false -- a qualitative-only threshold isn't a
 * dimension this arithmetic check has any evidence about either way.
 */
function hasKnownNumericThreshold(threshold: ApplicabilityThreshold): boolean {
  return KNOWN_THRESHOLD_KEYS.some((key) => threshold[key] != null);
}

/**
 * Only meaningful once hasKnownNumericThreshold has confirmed there's an
 * evaluable numeric shape. Fail-safe by construction: returns false
 * (threshold not confirmed met) whenever the site's real data can't
 * affirmatively confirm every dimension the threshold states. Never
 * asserts an applicability the available Site fields can't actually
 * verify.
 */
function meetsApplicabilityThreshold(threshold: ApplicabilityThreshold, site: Site): boolean {
  if (threshold.min_employees_france != null || threshold.min_employees_worldwide != null) {
    // Known data-model limitation (review round 2): legally this is a real
    // OR (>=5,000 in France OR >=10,000 worldwide), but Site tracks a
    // single employees_count, not separate France/worldwide figures.
    // Since min_employees_france is always the lower of the two, this
    // effectively resolves against whichever bound site.employees_count is
    // being compared to -- not a confirmed guarantee the count is actually
    // France-scoped. That's a real gap in what this deterministic check
    // can verify from today's Site schema, not something this arithmetic
    // fix can close; a genuinely France-vs-worldwide-scoped headcount
    // would need its own Site field.
    const meetsFrance =
      threshold.min_employees_france != null &&
      site.employees_count >= threshold.min_employees_france;
    const meetsWorldwide =
      threshold.min_employees_worldwide != null &&
      site.employees_count >= threshold.min_employees_worldwide;
    if (!meetsFrance && !meetsWorldwide) return false;
  }

  if (threshold.min_employees != null && site.employees_count < threshold.min_employees)
    return false;
  if (threshold.min_revenue_eur != null && site.revenue < threshold.min_revenue_eur) return false;

  if (threshold.min_balance_sheet_eur != null) {
    // CSRD-style "must exceed 2 of these 3 thresholds" -- Site has no
    // balance-sheet field, so the only case we can confidently confirm
    // without it is both employees AND revenue already clearing their own
    // bounds (already 2 of 3 regardless of balance sheet). Anything less
    // can't be confirmed from the data available, so it doesn't count as met.
    const employeesMet =
      threshold.min_employees != null && site.employees_count >= threshold.min_employees;
    const revenueMet =
      threshold.min_revenue_eur != null && site.revenue >= threshold.min_revenue_eur;
    if (!(employeesMet && revenueMet)) return false;
  }

  return true;
}

function cap(value: string | null | undefined): string {
  return (value ?? '').slice(0, MAX_PROMPT_FIELD_LENGTH);
}

function clamp(value: unknown, lo: number, hi: number): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return lo;
  return Math.min(hi, Math.max(lo, Math.round(num)));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callAiJson(path: string, body: unknown, orgAccountId: string): Promise<any> {
  const response = await fetchWithTimeout(
    `${configs.ai_server_end_point}${path}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...buildAiHeaders(orgAccountId) },
      body: JSON.stringify(body),
    },
    LLM_CALL_TIMEOUT_MS,
  );
  if (!response.ok) {
    throw new AppError(`AI service error: ${response.status} (${path})`, 502);
  }
  return response.json();
}

type ResolvedWebsiteDomain = { domain: string; source: 'site' | 'org' };

// External-data-anchoring plan, Phase 1 (Cyber/IT category). Site.website_domain
// takes priority (a site can genuinely have its own internet-facing footprint
// distinct from the org's corporate site); falls back to the org's
// OrganizationProfile.organizationWebsite when unset. Both are exclusively
// user-provided -- no automated discovery/guessing anywhere in this
// resolution, since a wrong domain would attribute a real, specific CVE to
// the wrong company.
//
// Review finding: a silent org-level fallback in a multi-site org can
// misattribute a CVE to a site whose real infrastructure differs from the
// parent org's corporate domain -- the exact failure mode this design is
// trying to prevent, just recurring at site granularity instead of company
// granularity. Rather than disabling the fallback (which would mean NO
// Cyber/IT anchoring at all for the common case of a single-site or
// single-website org), the resolved source is threaded through to aexa-ai
// so the eventual citation can honestly distinguish "this site's own
// domain" from "inherited from the parent org, may not reflect this
// specific site."
async function resolveSiteWebsiteDomain(
  site: Site,
  orgAccountId: string,
): Promise<ResolvedWebsiteDomain | null> {
  if (site.website_domain) return { domain: site.website_domain, source: 'site' };

  // Round-1 review: this query previously had no try/catch, unlike
  // resolveSiteSectorIfNeeded's own AI call just above in this file --
  // buildSiteProfile used to be synchronous and could never throw, so
  // callers (runAnalysis/retryFailedCategories) had no reason to guard
  // it. Now that it awaits a real DB query, an unhandled failure here
  // (connection blip, pool exhaustion) would propagate all the way out
  // to the top-level .catch(), which only logs -- silently leaving the
  // run stuck at status: 'running' forever, the exact invariant this
  // file's own header comment says every failure path must avoid.
  // Degrade the same way a failed lookup already does (org fallback
  // simply unavailable) rather than letting the whole run die over it.
  try {
    const profile = await prisma.organizationProfile.findUnique({
      where: { accountId: orgAccountId },
      select: { organizationWebsite: true },
    });
    return profile?.organizationWebsite
      ? { domain: profile.organizationWebsite, source: 'org' }
      : null;
  } catch (error) {
    logger.warn(
      { err: error, orgAccountId },
      'Failed to fetch org profile website, leaving Cyber/IT domain unresolved',
    );
    return null;
  }
}

async function buildSiteProfile(site: Site, orgAccountId: string): Promise<Record<string, string>> {
  const resolvedDomain = await resolveSiteWebsiteDomain(site, orgAccountId);
  return {
    site_name: site.name,
    site_location: site.location || '',
    site_country: site.country || '',
    site_activity: cap(site.activity),
    site_type: site.site_type,
    site_employees: String(site.employees_count),
    site_revenue: String(site.revenue),
    ...(site.description ? { site_description: cap(site.description) } : {}),
    ...(resolvedDomain
      ? {
          site_website_domain: resolvedDomain.domain,
          site_website_domain_source: resolvedDomain.source,
        }
      : {}),
    // resolveSiteSectorIfNeeded (below) has been persisting this since
    // Phase 0b, but nothing ever forwarded it into the payload aexa-ai
    // actually receives -- a real "computed and stored but silently
    // unusable" gap, found while researching EU-wide anchoring sources
    // (Eurostat's ESAW/crime datasets are sector-keyed by NACE/NAF, so
    // this is what lets them dispatch at all).
    ...(site.secteur_code && site.secteur_code_type
      ? {
          site_secteur_code: site.secteur_code,
          site_secteur_code_type: site.secteur_code_type,
        }
      : {}),
  };
}

type RegulatoryFrameworkRow = Prisma.RegulatoryFrameworkGetPayload<Record<string, never>>;

// Shared by runAnalysis and retryFailedCategories -- both need the same
// curated-table snapshot and its official_reference lookup map, and must
// build it the exact same way so a retry validates citations against the
// identical curated set the original run did.
async function fetchFrameworksForPrompt(): Promise<{
  frameworkByRef: Map<string, RegulatoryFrameworkRow>;
  regulatoryFrameworksPayload: unknown[];
}> {
  const frameworks = await prisma.regulatoryFramework.findMany({ take: MAX_REGULATORY_FRAMEWORKS });
  const frameworkByRef = new Map(frameworks.map((f) => [f.official_reference, f]));
  const regulatoryFrameworksPayload = frameworks.map((f) => ({
    name: f.name,
    official_reference: f.official_reference,
    jurisdiction: f.jurisdiction,
    domain: f.domain,
    legal_status: f.legal_status,
    applicability_threshold: f.applicability_threshold ?? undefined,
    summary: f.summary,
  }));
  return { frameworkByRef, regulatoryFrameworksPayload };
}

// A generated risk carries enough of an existing register entry's shape to
// run BOTH dedup layers against it: the deterministic (category,
// regulatory_framework_id) check and the fuzzy title-similarity fallback for
// risks with no resolved citation. Also doubles as the shape of a
// just-persisted risk appended mid-run in runCategoryGeneration, so a
// category's own batch is deduped against itself, not just the pre-run
// snapshot.
type ExistingRiskForDedup = {
  title: string;
  category: string;
  regulatoryFrameworkId: string | null;
};

// Normalizes a risk title for comparison: lowercased, punctuation stripped,
// whitespace collapsed. "Ransomware Attack (Production)" and "ransomware
// attack production" normalize identically.
function normalizeRiskTitle(title: string): string {
  return title
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function riskTitleTokens(title: string): Set<string> {
  return new Set(normalizeRiskTitle(title).split(' ').filter(Boolean));
}

// Jaccard similarity on normalized word sets. Catches "differently worded,
// same risk" duplicates (design-docs §6's own example: "even if the wording
// differs") without an embeddings call -- see DUPLICATE_TITLE_SIMILARITY_THRESHOLD
// above for why 0.8.
function isLikelyDuplicateTitle(existingTitle: string, candidateTitle: string): boolean {
  const normalizedExisting = normalizeRiskTitle(existingTitle);
  const normalizedCandidate = normalizeRiskTitle(candidateTitle);
  if (!normalizedExisting || !normalizedCandidate) return false;
  if (normalizedExisting === normalizedCandidate) return true;

  const existingTokens = riskTitleTokens(existingTitle);
  const candidateTokens = riskTitleTokens(candidateTitle);
  if (existingTokens.size === 0 || candidateTokens.size === 0) return false;

  let intersectionSize = 0;
  for (const token of existingTokens) {
    if (candidateTokens.has(token)) intersectionSize++;
  }
  const unionSize = existingTokens.size + candidateTokens.size - intersectionSize;
  return unionSize > 0 && intersectionSize / unionSize >= DUPLICATE_TITLE_SIMILARITY_THRESHOLD;
}

// True when `candidate` duplicates something already in `existingRisks`,
// scoped to the same category (a "cyber" risk and an "hr" risk never
// collide regardless of title overlap). Two layers, either sufficient:
// 1. design-docs §6's enforced layer -- same category AND the same
//    resolved regulatory_framework_id. Deterministic, no wording-dependent
//    false negatives for cited risks. Known tradeoff (accepted, per the
//    design doc): this matches on citation alone, with no title check, so
//    two genuinely distinct risks in the same category that both cite the
//    same framework article will be treated as duplicates. Revisit if this
//    proves too aggressive in practice -- the fix would be requiring some
//    minimum title overlap even on a citation match.
// 2. Fuzzy title match (exact or high word-overlap) -- the fallback for
//    risks with no resolved citation, or as a second check even when one
//    exists.
function isDuplicateOfExistingRisk(
  candidate: { title: string; category: string; regulatoryFrameworkId: string | null },
  existingRisks: ExistingRiskForDedup[],
): boolean {
  return existingRisks.some((existing) => {
    if (existing.category !== candidate.category) return false;
    if (
      candidate.regulatoryFrameworkId &&
      existing.regulatoryFrameworkId === candidate.regulatoryFrameworkId
    ) {
      return true;
    }
    return isLikelyDuplicateTitle(existing.title, candidate.title);
  });
}

// Shared by runAnalysis and retryFailedCategories -- the pre-run snapshot
// both the soft LLM-prompt hint (design-docs §6) and the enforced
// persist-time dedup check (isDuplicateOfExistingRisk, added on top of that
// same §6 spec) run against. Same org-scoped query both need.
async function fetchExistingRiskTitles(
  siteId: string,
  orgAccountId: string,
): Promise<ExistingRiskForDedup[]> {
  const existingRisks = await prisma.risk.findMany({
    // docs/design-docs/ai-risk-review-approval-workflow.md -- dedup counts
    // APPROVED + PENDING_REVIEW (a fresh run shouldn't re-suggest something
    // already sitting in the register OR already pending review), but not
    // DISMISSED -- a reviewer's rejection of one attempt's proposal isn't a
    // permanent "never applicable" verdict, so a later run may legitimately
    // re-flag it (accepted tradeoff, see the design doc's open items).
    where: {
      site_id: siteId,
      org_account_id: orgAccountId,
      review_status: { in: ['APPROVED', 'PENDING_REVIEW'] },
    },
    select: { name: true, category: true, regulatory_framework_id: true },
    take: MAX_EXISTING_RISKS_FOR_DEDUP,
  });
  return existingRisks.map((r) => ({
    title: r.name.slice(0, MAX_EXISTING_RISK_TITLE_LENGTH),
    category: r.category,
    regulatoryFrameworkId: r.regulatory_framework_id,
  }));
}

// Kicks off a new "Analyze with AI" run for a site: resolves/validates the
// site, enforces the re-run cooldown, creates the AiRiskAnalysisRun row,
// and hands off the actual two-phase generation to runAnalysis WITHOUT
// awaiting it -- this codebase has no job queue for AI generation (BullMQ
// is wired up for email only, see src/app/queues/), so returning the run
// id immediately and letting the frontend poll its status (design-docs §6,
// the same RTK Query polling shape KnowledgeBaseUploadingForm.tsx /
// ReportsPage.tsx already use) is the simplest correct alternative to
// standing up new queue infrastructure for this one feature.
const start_ai_risk_analysis = async (req: Request) => {
  try {
    const user = req.user as JwtPayloadType;
    const ctx = await resolveCallerOrgContext(user.accountId);
    assertCanWriteOrgResource(ctx);
    const { siteId } = req.body as { siteId: string };

    const site = await prisma.site.findFirst({
      where: { id: siteId, org_account_id: ctx.organizationId },
    });
    if (!site) throw new AppError('Site not found', 404);

    if (!site.activity?.trim()) {
      throw new AppError(
        'This site is missing a primary activity. Add one before running AI risk analysis.',
        400,
      );
    }

    const lastRun = await prisma.aiRiskAnalysisRun.findFirst({
      where: { site_id: siteId, org_account_id: ctx.organizationId },
      orderBy: { started_at: 'desc' },
    });
    if (lastRun) {
      const elapsedMs = Date.now() - lastRun.started_at.getTime();
      if (elapsedMs < RERUN_COOLDOWN_MS) {
        const waitMinutes = Math.ceil((RERUN_COOLDOWN_MS - elapsedMs) / 60000);
        throw new AppError(
          `This site was analyzed recently. Try again in ${waitMinutes} minute(s).`,
          429,
        );
      }
    }

    const run = await prisma.aiRiskAnalysisRun.create({
      data: {
        site_id: siteId,
        org_account_id: ctx.organizationId,
        triggered_by_account_id: user.accountId,
        status: 'running',
      },
    });

    void runAnalysis(run.id, site, ctx, user.accountId).catch((error) => {
      logger.error({ err: error, runId: run.id }, 'AI risk analysis run failed unexpectedly');
    });

    return run;
  } catch (error) {
    return wrapAiServiceError(error, 'Failed to start AI risk analysis');
  }
};

const get_ai_risk_analysis_run = async (req: Request) => {
  try {
    const user = req.user as JwtPayloadType;
    const ctx = await resolveCallerOrgContext(user.accountId);
    const { id } = req.params as { id: string };

    const run = await prisma.aiRiskAnalysisRun.findFirst({
      where: { id, org_account_id: ctx.organizationId },
    });
    if (!run) throw new AppError('Analysis run not found', 404);

    const risksCreated = await prisma.risk.count({ where: { ai_generation_run_id: run.id } });

    return { ...run, risks_created: risksCreated };
  } catch (error) {
    return wrapAiServiceError(error, 'Failed to fetch AI risk analysis run');
  }
};

// design-docs §7: "a scoped retry limited to just those categories,
// updating the same run row" -- deliberately deferred out of the original
// orchestration PR, built here as its own follow-up. Re-runs Phase 2 ONLY
// for the categories recorded in categories_failed, never re-runs Phase 1
// triage (the applicable/skipped category list from the original run is
// reused as-is) and never creates a new AiRiskAnalysisRun row -- the same
// run's provenance stays intact, matching design-docs §6's "retrying a
// failed category updates the same run row... risks from the retry link
// to that same run id" requirement.
const retry_ai_risk_analysis = async (req: Request) => {
  try {
    const user = req.user as JwtPayloadType;
    const ctx = await resolveCallerOrgContext(user.accountId);
    assertCanWriteOrgResource(ctx);
    const { id } = req.params as { id: string };

    const run = await prisma.aiRiskAnalysisRun.findFirst({
      where: { id, org_account_id: ctx.organizationId },
    });
    if (!run) throw new AppError('Analysis run not found', 404);

    if (run.status === 'running') {
      throw new AppError('This analysis run is still in progress.', 409);
    }

    const failedCategories =
      (run.categories_failed as { category: string; error: string }[] | null) ?? [];
    if (failedCategories.length === 0) {
      throw new AppError('This run has no failed categories to retry.', 400);
    }

    const site = await prisma.site.findFirst({
      where: { id: run.site_id, org_account_id: ctx.organizationId },
    });
    if (!site) throw new AppError('Site not found', 404);

    // Review finding: a plain update() here has a real TOCTOU race -- two
    // concurrent retry requests can both pass the `run.status === 'running'`
    // check above before either commits, both flip status to running, both
    // fire retryFailedCategories for the same failedCategories snapshot,
    // double-generating risks. Same guarded-updateMany pattern
    // kri.service.ts's submit_kri_value_into_db already established for
    // this exact class of race: only a write that still finds the row in
    // a non-running state actually applies; the loser's updateMany affects
    // zero rows and gets a 409 instead of silently racing ahead.
    const updateOutcome = await prisma.aiRiskAnalysisRun.updateMany({
      where: { id: run.id, status: { not: 'running' } },
      data: { status: 'running' },
    });
    if (updateOutcome.count === 0) {
      throw new AppError('This analysis run is still in progress.', 409);
    }
    const updatedRun = await prisma.aiRiskAnalysisRun.findUniqueOrThrow({
      where: { id: run.id },
    });

    void retryFailedCategories(
      run.id,
      site,
      ctx,
      run.triggered_by_account_id,
      failedCategories,
    ).catch((error) => {
      logger.error({ err: error, runId: run.id }, 'AI risk analysis retry failed unexpectedly');
    });

    return updatedRun;
  } catch (error) {
    return wrapAiServiceError(error, 'Failed to retry AI risk analysis');
  }
};

// The actual two-phase generation, run after start_ai_risk_analysis has
// already responded. Owns its own error handling end to end -- a rejection
// here is caught by the caller's .catch() and must never crash the process,
// but every failure path here also updates the run row so a stuck
// `running` status can't linger forever.
// External-data-anchoring plan, Phase 0b (Step 0). Resolves and persists
// the site's sector code the first time it's needed, then never again --
// a site that already has secteur_code set is a no-op here, which is what
// keeps this from re-hitting the SEC EDGAR/LLM cascade on every regenerate.
// Deliberately non-fatal: a failure here (network error, aexa-ai down)
// must never fail the whole risk analysis run over a side signal nothing
// downstream consumes yet -- same degrade-gracefully principle as the rest
// of this file's AI calls. Mutates `site` in place so any code later in
// the same run sees the freshly resolved value without a second DB read.
async function resolveSiteSectorIfNeeded(site: Site, orgAccountId: string): Promise<void> {
  if (site.secteur_code) return;

  let resolved: {
    secteur_code: string | null;
    secteur_code_type: 'SIC' | 'NAF' | 'ESTIMATED';
    secteur_estime: boolean;
  };
  try {
    resolved = await callAiJson(
      '/company/resolve-sector',
      { company_name: site.name, country: site.country, activity: site.activity },
      orgAccountId,
    );
  } catch (error) {
    logger.warn({ err: error, siteId: site.id }, 'Sector resolution failed, leaving unresolved');
    return;
  }

  if (!resolved.secteur_code) return;

  await prisma.site.update({
    // org_account_id alongside id, matching this codebase's established
    // convention for org-scoped updates (e.g. audit.service.ts's
    // AuditEngagement update) -- not exploitable today since `site` is
    // already fetched org-scoped by the caller, but consistent
    // defense-in-depth against a future refactor that reuses this function
    // with a differently-sourced `site`.
    where: { id: site.id, org_account_id: orgAccountId },
    data: {
      secteur_code: resolved.secteur_code,
      secteur_code_type: resolved.secteur_code_type,
      secteur_estime: resolved.secteur_estime,
    },
  });
  site.secteur_code = resolved.secteur_code;
  site.secteur_code_type = resolved.secteur_code_type;
  site.secteur_estime = resolved.secteur_estime;
}

async function runAnalysis(
  runId: string,
  site: Site,
  ctx: CallerOrgContext,
  triggeredByAccountId: string,
): Promise<void> {
  await resolveSiteSectorIfNeeded(site, ctx.organizationId);

  const siteProfile = await buildSiteProfile(site, ctx.organizationId);

  let triage: { categories?: TriageCategoryResult[] };
  try {
    triage = await callAiJson('/risk_triage', siteProfile, ctx.organizationId);
  } catch (error) {
    logger.error({ err: error, runId }, 'Risk triage call failed');
    await prisma.aiRiskAnalysisRun.update({
      where: { id: runId },
      data: { status: 'failed', completed_at: new Date() },
    });
    return;
  }

  const categories = triage.categories ?? [];
  // design-docs §2/§4: category must be a strictly server-validated enum,
  // never trusted free text from the model -- aexa-ai's own schema already
  // enforces this as a closed enum, this filter is defense-in-depth, not
  // the only layer.
  const applicable = categories.filter(
    (c): c is TriageCategoryResult & { category: RiskCategoryValue } =>
      c.applies && (RISK_CATEGORIES as readonly string[]).includes(c.category),
  );
  const skipped = categories.filter((c) => !c.applies);

  await prisma.aiRiskAnalysisRun.update({
    where: { id: runId },
    data: {
      triage_result: triage as Prisma.InputJsonValue,
      categories_applicable: applicable.map((c) => c.category) as Prisma.InputJsonValue,
      categories_skipped: skipped.map((c) => ({
        category: c.category,
        reasoning: c.reasoning,
      })) as Prisma.InputJsonValue,
    },
  });

  if (applicable.length === 0) {
    await prisma.aiRiskAnalysisRun.update({
      where: { id: runId },
      data: { status: 'completed', completed_at: new Date() },
    });
    return;
  }

  const { frameworkByRef, regulatoryFrameworksPayload } = await fetchFrameworksForPrompt();
  const existingRiskTitles = await fetchExistingRiskTitles(site.id, ctx.organizationId);

  const outcomes = await Promise.allSettled(
    applicable.map((category, index) =>
      delay(index * CATEGORY_CALL_STAGGER_MS).then(() =>
        runCategoryGeneration(
          runId,
          site,
          ctx,
          triggeredByAccountId,
          category,
          siteProfile,
          regulatoryFrameworksPayload,
          existingRiskTitles,
          frameworkByRef,
        ),
      ),
    ),
  );

  const failed: { category: string; error: string }[] = [];
  outcomes.forEach((outcome, index) => {
    if (outcome.status === 'rejected') {
      const category = applicable[index].category;
      const message =
        outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
      failed.push({ category, error: message });
      logger.error({ err: outcome.reason, runId, category }, 'Category generation failed');
    }
  });

  const finalStatus =
    failed.length === 0 ? 'completed' : failed.length === outcomes.length ? 'failed' : 'partial';

  await prisma.aiRiskAnalysisRun.update({
    where: { id: runId },
    data: {
      status: finalStatus,
      completed_at: new Date(),
      categories_failed: failed as unknown as Prisma.InputJsonValue,
    },
  });
}

// Re-runs Phase 2 ONLY for the categories that failed on a prior attempt,
// reusing that same category's estimated_risk_count from the original
// Phase 1 triage result (stored on the run row) rather than re-triaging.
// Owns its own error handling end to end, same contract as runAnalysis --
// a rejection here is caught by the caller's .catch() and must never
// crash the process, but every path also updates the run row so a stuck
// `running` status can't linger forever.
async function retryFailedCategories(
  runId: string,
  site: Site,
  ctx: CallerOrgContext,
  triggeredByAccountId: string,
  failedCategories: { category: string; error: string }[],
): Promise<void> {
  const run = await prisma.aiRiskAnalysisRun.findUnique({ where: { id: runId } });
  // Defensive only -- the run existed moments ago when retry_ai_risk_analysis
  // read it; nothing in this codebase deletes an AiRiskAnalysisRun row.
  if (!run) return;

  const triage = (run.triage_result as { categories?: TriageCategoryResult[] } | null) ?? {};
  const triageByCategory = new Map((triage.categories ?? []).map((c) => [c.category, c]));

  // Re-derives estimated_risk_count from the ORIGINAL triage call rather
  // than re-triaging -- Phase 1 already reasoned about this site once;
  // re-running it on every retry would both cost an extra LLM call and
  // risk it changing its mind about which categories even apply.
  const toRetry = failedCategories
    .map((f) => triageByCategory.get(f.category))
    .filter(
      (c): c is TriageCategoryResult & { category: RiskCategoryValue } =>
        !!c && (RISK_CATEGORIES as readonly string[]).includes(c.category),
    );

  const siteProfile = await buildSiteProfile(site, ctx.organizationId);
  const { frameworkByRef, regulatoryFrameworksPayload } = await fetchFrameworksForPrompt();
  const existingRiskTitles = await fetchExistingRiskTitles(site.id, ctx.organizationId);

  const outcomes = await Promise.allSettled(
    toRetry.map((category, index) =>
      delay(index * CATEGORY_CALL_STAGGER_MS).then(() =>
        runCategoryGeneration(
          runId,
          site,
          ctx,
          triggeredByAccountId,
          category,
          siteProfile,
          regulatoryFrameworksPayload,
          existingRiskTitles,
          frameworkByRef,
        ),
      ),
    ),
  );

  const stillFailed: { category: string; error: string }[] = [];
  outcomes.forEach((outcome, index) => {
    if (outcome.status === 'rejected') {
      const category = toRetry[index].category;
      const message =
        outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
      stillFailed.push({ category, error: message });
      logger.error({ err: outcome.reason, runId, category }, 'Category retry failed');
    }
  });

  // A category not in toRetry (its triage record vanished or its category
  // string somehow failed the enum check) can't be retried -- keep it
  // recorded as failed rather than silently dropping it, same "never
  // silently drop a category" requirement §7 already established for the
  // original run.
  const unretriable = failedCategories.filter(
    (f) => !toRetry.some((c) => c.category === f.category),
  );

  const categoriesFailed = [...stillFailed, ...unretriable];
  // Review finding: this used to only ever produce 'completed'/'partial',
  // never 'failed' -- if every category the run ever attempted still has
  // zero successes after this retry (the original run was already fully
  // 'failed' and the retry didn't fix anything), the run should read as
  // 'failed' again, not a misleadingly less-severe 'partial'. Mirrors
  // runAnalysis's own `failed.length === outcomes.length` check, just
  // against the run's full original category count instead of this one
  // retry's smaller category list.
  const totalApplicable = (run.categories_applicable as string[] | null)?.length ?? 0;
  const finalStatus =
    categoriesFailed.length === 0
      ? 'completed'
      : categoriesFailed.length === totalApplicable
        ? 'failed'
        : 'partial';

  await prisma.aiRiskAnalysisRun.update({
    where: { id: runId },
    data: {
      status: finalStatus,
      completed_at: new Date(),
      categories_failed: categoriesFailed as unknown as Prisma.InputJsonValue,
    },
  });
}

async function runCategoryGeneration(
  runId: string,
  site: Site,
  ctx: CallerOrgContext,
  triggeredByAccountId: string,
  triageCategory: TriageCategoryResult & { category: RiskCategoryValue },
  siteProfile: Record<string, string>,
  regulatoryFrameworksPayload: unknown[],
  existingRiskTitles: ExistingRiskForDedup[],
  frameworkByRef: Map<string, RegulatoryFrameworkRow>,
): Promise<void> {
  const body = {
    category: triageCategory.category,
    estimated_risk_count: triageCategory.estimated_risk_count,
    ...siteProfile,
    regulatory_frameworks: regulatoryFrameworksPayload,
    // aexa-ai's wire contract only wants { title }[] (its own soft prompt
    // hint just lists titles) -- the richer category/regulatoryFrameworkId
    // fields on ExistingRiskForDedup are for the enforced check below,
    // server-side only, not sent over the wire.
    existing_risks: existingRiskTitles.map((r) => ({ title: r.title })),
  };

  const generation = await callAiJson('/risk_category_generation', body, ctx.organizationId);

  // Mutable, category-scoped copy of the pre-run snapshot: each risk this
  // loop persists is appended so the REST of this same category's batch is
  // deduped against it too, not just against risks that existed before the
  // run started. Catches the same LLM call proposing two near-duplicate
  // risks in one response, not just cross-run duplication.
  const dedupSet = [...existingRiskTitles];

  for (const raw of generation.risks ?? []) {
    const persisted = await persistGeneratedRisk(
      runId,
      site,
      ctx,
      triggeredByAccountId,
      triageCategory.category,
      raw,
      frameworkByRef,
      dedupSet,
    );
    if (persisted) dedupSet.push(persisted);
  }
}

async function persistGeneratedRisk(
  runId: string,
  site: Site,
  ctx: CallerOrgContext,
  triggeredByAccountId: string,
  category: RiskCategoryValue,
  raw: any,
  frameworkByRef: Map<string, RegulatoryFrameworkRow>,
  dedupSet: ExistingRiskForDedup[],
): Promise<ExistingRiskForDedup | null> {
  let legalStatus = raw.legal_status;
  let citationConfidence = raw.citation_confidence;
  let regulatoryFrameworkId: string | null = null;

  // design-docs §7: never trust the model's citation even if it's
  // schema-typed as a valid FK shape -- validate the claimed
  // regulatory_official_reference against the real curated table before
  // persisting.
  if (raw.regulatory_official_reference) {
    const framework = frameworkByRef.get(raw.regulatory_official_reference);
    if (framework) {
      regulatoryFrameworkId = framework.id;

      // design-docs §10: deterministic threshold check for the
      // threshold-bearing frameworks (Sapin II, Devoir de Vigilance,
      // CSRD) -- arithmetic, not a judgment call. Downgrades regardless
      // of what the generating call itself asserted.
      const threshold = framework.applicability_threshold as ApplicabilityThreshold | null;
      if (
        threshold &&
        hasKnownNumericThreshold(threshold) &&
        !meetsApplicabilityThreshold(threshold, site)
      ) {
        legalStatus = 'conditional_statutory';
        citationConfidence = 'ai_estimate';
      }
    }
  }

  // Review finding: the block above only downgraded a false
  // curated_verified claim when a regulatory_official_reference was
  // PRESENT but failed to resolve -- a claim with no reference at all (or
  // an empty one) slipped through untouched. This is the general form of
  // the same §7 requirement: curated_verified can only survive if it
  // actually resolved to a real curated framework row, for whatever reason
  // it didn't.
  if (citationConfidence === 'curated_verified' && !regulatoryFrameworkId) {
    citationConfidence = 'ai_estimate';
  }

  // External-data-anchoring plan. Two independent anchoring signals, either
  // sufficient:
  // 1. Phase 0a: a resolved curated regulatory citation (the same check
  //    citationConfidence above already performs). `raw.regulatory_official_reference`
  //    is safe to reuse as source_reference here specifically because we
  //    only reach this branch when it already resolved against the real
  //    curated table (regulatoryFrameworkId is non-null) -- it's the
  //    validated key, not an unverified model claim.
  // 2. Phase 1: a wired per-category external source (e.g. World Bank WGI
  //    for "geopolitical"). aexa-ai's risk_category_generation_service.py
  //    already does its own server-side normalization before this ever
  //    reaches us -- source_type can only come back "anchored" there if
  //    real external data was actually fetched for that category, and
  //    source_reference is always aexa-ai's own code-constructed citation,
  //    never raw model text (the request schema doesn't even expose a
  //    source_reference field to the model). aexa-server trusts that
  //    already-normalized output as-is, same trust boundary as every other
  //    field in this response -- no independent re-validation needed, this
  //    is an internal service call (X-Internal-Secret), not third-party
  //    input.
  const citationAnchored =
    citationConfidence === 'curated_verified' && Boolean(regulatoryFrameworkId);
  const externalAnchored =
    raw.source_type === 'anchored' &&
    typeof raw.source_reference === 'string' &&
    raw.source_reference.trim().length > 0;
  const sourceType: 'anchored' | 'estimated' =
    citationAnchored || externalAnchored ? 'anchored' : 'estimated';
  const sourceReference: string | null = citationAnchored
    ? raw.regulatory_official_reference
    : externalAnchored
      ? raw.source_reference
      : null;

  // design-docs §6's enforced dedup layer -- the free-text "existing risks"
  // prompt hint sent to aexa-ai doesn't guarantee anything on its own (bug
  // report: regenerating a site's AI analysis kept re-proposing risks
  // already sitting in the register). Skip persisting anything that matches
  // an existing PENDING_REVIEW/APPROVED risk in the same category, either
  // by resolved regulatory_framework_id or by title similarity -- see
  // isDuplicateOfExistingRisk.
  const candidateForDedup = {
    title: typeof raw.name === 'string' ? raw.name : '',
    category,
    regulatoryFrameworkId,
  };
  if (isDuplicateOfExistingRisk(candidateForDedup, dedupSet)) {
    logger.info(
      { runId, category, name: raw.name },
      'Skipped AI-generated risk: duplicate of an existing register entry',
    );
    return null;
  }

  // design-docs §4: same fixed enums risk_category_generation_schema.py's
  // Velocity/Trend target -- server-validated the same way category is,
  // rather than trusted as free text (velocity/trend are plain String?
  // columns, so an off-enum value wouldn't crash anything, but it would
  // reach the UI unfiltered).
  const velocity = VALID_VELOCITY.has(raw.velocity) ? raw.velocity : null;
  const trend = VALID_TREND.has(raw.trend) ? raw.trend : null;

  const probability = clamp(raw.probability, 0, 100);
  const impact = clamp(raw.impact, 0, 100);
  const controlDesignEff = clamp(raw.control_design_eff, 0, 100);
  const controlOperatingEff = clamp(raw.control_operating_eff, 0, 100);
  let financialImpactMin = clamp(raw.financial_impact_min, 0, 1_000_000);
  let financialImpactMax = clamp(raw.financial_impact_max, 0, 1_000_000);
  if (financialImpactMin > financialImpactMax) {
    [financialImpactMin, financialImpactMax] = [financialImpactMax, financialImpactMin];
  }

  const inherent = resolveInherentFields(
    { probability, impact, raw_inherent_score: null },
    {},
    triggeredByAccountId,
    null,
  );
  if (!inherent.ok) throw new AppError(inherent.message, 500);

  const residual = resolveResidualFields(
    {
      inherent_score: inherent.fields.inherent_score,
      control_design_eff: controlDesignEff,
      control_operating_eff: controlOperatingEff,
    },
    {},
    triggeredByAccountId,
    null,
  );
  if (!residual.ok) throw new AppError(residual.message, 500);

  const ebitda = resolveEbitdaFields(
    {
      site_revenue: site.revenue,
      site_activity: site.activity,
      probability,
      impact,
    },
    {},
    triggeredByAccountId,
    null,
  );
  if (!ebitda.ok) throw new AppError(ebitda.message, 500);

  const payload: Omit<Prisma.RiskUncheckedCreateInput, 'ref'> = {
    org_account_id: ctx.organizationId,
    site_id: site.id,
    name: raw.name,
    description: raw.description ?? null,
    category,
    status: 'open',
    ai_generated: true,
    // docs/design-docs/ai-risk-review-approval-workflow.md -- generated
    // risks start unreviewed, not the schema's APPROVED default (that
    // default is for manually-created risks and pre-existing rows only).
    review_status: 'PENDING_REVIEW',
    source_info: `AI risk analysis, ${new Date().toISOString().slice(0, 10)}`,
    probability,
    impact,
    financial_impact_min: financialImpactMin,
    financial_impact_max: financialImpactMax,
    velocity,
    trend,
    control_design_eff: controlDesignEff,
    control_operating_eff: controlOperatingEff,
    legal_status: legalStatus,
    regulatory_framework_id: regulatoryFrameworkId,
    regulatory_citation_note: raw.regulatory_citation_note ?? null,
    citation_confidence: citationConfidence,
    source_type: sourceType,
    source_reference: sourceReference,
    internal_pilot: raw.internal_pilot ?? null,
    ai_generation_run_id: runId,
    ...inherent.fields,
    ...residual.fields,
    ...ebitda.fields,
  };

  await createRiskWithGeneratedRef(payload);
  return candidateForDedup;
}

// computeEbitdaAtRisk is re-exported transitively via resolveEbitdaFields
// above; imported directly here only so the module graph is explicit about
// this file's dependency on ebitda_risk.ts's public surface, matching how
// risk.service.ts imports the same module.
void computeEbitdaAtRisk;

export const ai_risk_analysis_service = {
  start_ai_risk_analysis,
  get_ai_risk_analysis_run,
  retry_ai_risk_analysis,
};
