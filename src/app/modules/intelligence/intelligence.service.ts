import { Request } from 'express';
import { configs } from '../../configs/index.js';
import {
  buildAiHeaders,
  fetchWithTimeout,
  LLM_CALL_TIMEOUT_MS,
  wrapAiServiceError,
} from '../ai/ai.service.js';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../utils/app_error.js';
import { JwtPayloadType } from '../../utils/JWT.js';
import { assertCanWriteOrgResource, resolveCallerOrgContext } from '../../utils/org_scope.js';
import { buildPaginationMeta, paginationHelper } from '../../utils/paginationHelper.js';
import { ALL_RSS_SOURCES } from './rss_sources.js';
import { dedupeScrapedItems, ScrapedFeedItem, scrapeAllSources } from './rss_scraper.js';
import {
  computeNextRiskRef,
  retryTransactionOnRefConflict,
  SEVERITY_TO_SCORE,
} from '../risk/risk_ref.js';
import { clampPercent } from '../risk/risk_scoring.js';

type OrgContext = { name: string; sector?: string | null; country?: string | null };
type ExistingRisk = { id: string; name: string; category: string; description?: string | null };
type SiteContext = { id: string; country?: string | null; activity?: string | null };

// Resolves {name, sector, country} for aexa-ai's OrgContext shape from the
// caller's OrganizationProfile. organizationName is required on
// OrganizationProfile but the profile row itself is optional (1:1, nullable)
// -- same "not every account has one yet" gap organization.service.ts's own
// per-org listing already falls back for, mirrored here identically
// (organizationProfile?.organizationName ?? account.email).
const buildOrgContext = async (organizationId: string): Promise<OrgContext> => {
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

const fetchExistingRisks = async (organizationId: string): Promise<ExistingRisk[]> => {
  // docs/design-docs/ai-risk-review-approval-workflow.md -- APPROVED +
  // PENDING_REVIEW for dedup, excluding only DISMISSED (same rationale as
  // aiRiskAnalysis.service.ts's fetchExistingRiskTitles).
  const risks = await prisma.risk.findMany({
    where: {
      org_account_id: organizationId,
      review_status: { in: ['APPROVED', 'PENDING_REVIEW'] },
    },
    select: { id: true, name: true, category: true, description: true },
  });
  return risks;
};

const fetchSites = async (organizationId: string): Promise<SiteContext[]> => {
  const sites = await prisma.site.findMany({
    where: { org_account_id: organizationId },
    select: { id: true, country: true, activity: true },
  });
  return sites;
};

// Every outbound call to one of aexa-ai's 5 /intelligence/* endpoints shares
// this shape (POST, JSON body, buildAiHeaders, non-ok -> 502) -- mirrors
// ai.service.ts's per-call-site pattern exactly, just factored once since
// both analyze_items_into_db (/analyze) and runOrgLevelAction (which fans
// out to 4 more routes: predict/mitigations/rcsa/resilience-scan) call
// through this one helper. Takes the caller's org id so it can mint a fresh
// signed org-identity token per call (issue #56) instead of each caller
// building the headers itself.
const callAexaAiIntelligence = async <T>(
  path: string,
  body: unknown,
  orgAccountId: string,
): Promise<T> => {
  const aiResponse = await fetchWithTimeout(
    `${configs.ai_server_end_point}/intelligence${path}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...buildAiHeaders(orgAccountId),
      },
      body: JSON.stringify(body),
    },
    // Analysis/generation calls, not PDF processing — same tier as
    // ai.service.ts's own non-PDF calls (issue #275 follow-up to #233).
    LLM_CALL_TIMEOUT_MS,
  );
  if (!aiResponse.ok) {
    throw new AppError(`AI service error: ${aiResponse.status}`, 502);
  }
  return (await aiResponse.json()) as T;
};

// --------------------------------------------------------------------------
// POST /intelligence/scrape
// --------------------------------------------------------------------------

// #298: same "make the Express route's own deadline deterministic" reasoning
// as REPORT_ROUTE_TIMEOUT_MS (report.service.ts, #220) -- /scrape was the
// only other endpoint in the app with a comparably heavy fan-out (55
// concurrent RSS fetches, each individually bounded at 10s by
// rss_scraper.ts's per-feed AbortController, followed by a serialized,
// advisory-lock-protected create pass over every new item) but no route-level
// timeout at all. Sized smaller than report's 120s: no headless Chromium/S3
// step here, just network fetch (bounded ~10-15s by the per-feed timeouts
// running concurrently) plus DB writes, so 60s gives generous headroom over
// the expected case without leaving a hung request to whatever a fronting
// proxy's default happens to be.
export const SCRAPE_ROUTE_TIMEOUT_MS = 60_000;

// #298 round-1 review: the advisory-lock transaction below runs the create
// pass sequentially (one connection, see the comment at the call site) and
// this module's own worst case is ~750 new items in one scrape -- Prisma's
// interactive $transaction defaults to a 5s `timeout` (and 2s `maxWait`) when
// no options are passed, which a batch that size can easily exceed, throwing
// P2028 and rolling back every item in the batch, not just the slow tail.
// `timeout` is set generously above that worst case (accounting for a
// realistic per-create round-trip plus whatever time this call might spend
// blocked on the advisory lock behind an in-flight scrape for the same org,
// itself bounded by this same constant) rather than relying on the 5s
// default meant for typical short interactive transactions.
const SCRAPE_TRANSACTION_OPTIONS = { timeout: 180_000, maxWait: 10_000 };

const toDate = (value: string | undefined): Date | null => {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const scrape_sources_into_db = async (req: Request) => {
  try {
    const user = req.user as JwtPayloadType;
    const ctx = await resolveCallerOrgContext(user.accountId);

    const { items, sourcesTotal, sourcesSucceeded } = await scrapeAllSources(ALL_RSS_SOURCES);
    const deduped = dedupeScrapedItems(items);

    // #298: the existence-check-then-create sequence below is read-then-write
    // with no unique constraint backing it, so two concurrent scrapes for the
    // same org (e.g. a double-click, or an org's onboarding + manual "scrape
    // now" landing in the same second) could both read "not present yet" for
    // the same item and both insert it, duplicating every row in the overlap.
    // A clean unique constraint isn't available here: the dedup key is two
    // different comparisons depending on the row (link when the feed
    // provided one, else a case-insensitive source_name+title pair) --
    // Postgres unique constraints can't express "OR one of two different
    // key shapes, one of them case-insensitive" in a single index. Instead,
    // the whole read+write sequence runs inside one DB transaction holding a
    // Postgres advisory lock keyed on this org's id (auto-released at
    // commit/rollback) -- same fix already established in this codebase for
    // the identical class of problem (risk.correlation.service.ts's
    // findOrCreateSyntheticInspection). Two concurrent scrapes for the SAME
    // org fully serialize (the second waits for the first to commit, then
    // re-reads and sees what the first just created, so it correctly treats
    // those items as already-existing); scrapes for DIFFERENT orgs never
    // block each other at all (the lock key is per-org). The external
    // network fetch above deliberately stays OUTSIDE the lock/transaction --
    // only the DB read+write is serialized, so a slow RSS fetch never holds
    // a DB transaction (or blocks a concurrent scrape for the same org) for
    // longer than the writes themselves take.
    const created = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${ctx.organizationId})::bigint)`;

      // Skip items already persisted for this org, so re-running scrape never
      // duplicates rows. Matched by link (when the feed provided one) or by
      // source_name + title (case-insensitive), the same key the in-batch
      // dedupe above uses. The existence lookup is bounded to rows whose title
      // or link actually appears in this batch, rather than pulling every
      // IntelligenceItem the org has ever scraped.
      const titles = deduped.map((item) => item.title);
      const links = deduped.map((item) => item.link).filter((link): link is string => !!link);
      const existing =
        titles.length > 0 || links.length > 0
          ? await tx.intelligenceItem.findMany({
              where: {
                org_account_id: ctx.organizationId,
                OR: [
                  ...(links.length > 0 ? [{ link: { in: links } }] : []),
                  ...(titles.length > 0 ? [{ title: { in: titles } }] : []),
                ],
              },
              select: { title: true, source_name: true, link: true },
            })
          : [];
      const existingKeys = new Set(
        existing.map((row) => `${row.source_name.toLowerCase()}::${row.title.toLowerCase()}`),
      );
      const existingLinks = new Set(
        existing.filter((row) => row.link).map((row) => row.link as string),
      );

      const toPersist: ScrapedFeedItem[] = deduped.filter((item) => {
        if (item.link && existingLinks.has(item.link)) return false;
        const key = `${item.source_name.toLowerCase()}::${item.title.toLowerCase()}`;
        return !existingKeys.has(key);
      });

      // Sequential, not Promise.all: this now runs inside the single
      // connection an interactive $transaction holds, so concurrent awaits
      // here would just queue on that one connection anyway (and some
      // Prisma/driver combinations reject overlapping queries on the same
      // transaction outright) -- awaiting one at a time is both correct and
      // no slower in practice than the previous Promise.all was.
      const rows = [];
      for (const item of toPersist) {
        rows.push(
          await tx.intelligenceItem.create({
            data: {
              org_account_id: ctx.organizationId,
              title: item.title,
              description: item.description || null,
              link: item.link || null,
              source_name: item.source_name,
              source_category: item.source_category,
              source_credibility: item.source_credibility,
              source_language: item.source_language,
              published_at: toDate(item.published_at),
            },
          }),
        );
      }
      return rows;
    }, SCRAPE_TRANSACTION_OPTIONS);

    return {
      items: created,
      sourcesTotal,
      sourcesSucceeded,
      itemsScraped: deduped.length,
      itemsNew: created.length,
    };
  } catch (error) {
    return wrapAiServiceError(error, 'Failed to scrape threat intelligence sources');
  }
};

// --------------------------------------------------------------------------
// POST /intelligence/analyze
// --------------------------------------------------------------------------

const analyze_items_into_db = async (req: Request) => {
  try {
    const user = req.user as JwtPayloadType;
    const ctx = await resolveCallerOrgContext(user.accountId);
    const itemIds = (req.body?.itemIds as string[] | undefined) ?? [];

    const items = await prisma.intelligenceItem.findMany({
      where:
        itemIds.length > 0
          ? { id: { in: itemIds }, org_account_id: ctx.organizationId }
          : { org_account_id: ctx.organizationId, analyzed_at: null },
    });

    if (items.length === 0) {
      return { items: [], count: 0 };
    }

    const org = await buildOrgContext(ctx.organizationId);
    const existingRisks = await fetchExistingRisks(ctx.organizationId);

    // aexa-ai's AnalyzeResponse matches analyzed items back by
    // `original_title` only (its ScrapedItem request shape carries no id) --
    // a real constraint of the merged aexa-ai schema. Two DIFFERENT items can
    // legitimately share an exact title (our own scrape dedup only collapses
    // same-source/same-title duplicates, so two different sources publishing
    // an identically-titled story both get persisted) -- sending every
    // occurrence to the AI separately and then keying the response back by
    // title alone would silently misattribute one item's analysis onto
    // another whenever the AI's response collapses (or reorders) same-titled
    // entries. Instead, dedupe by title BEFORE the request -- send only one
    // representative item per unique title -- and deliberately apply that one
    // analysis to every persisted item sharing that title. This is the same
    // "identical title = same story" judgment call the RSS-scrape dedup
    // already makes, just applied consistently at analyze time too, and it
    // avoids paying to analyze the same story twice.
    const itemsByTitle = new Map<string, typeof items>();
    for (const item of items) {
      const bucket = itemsByTitle.get(item.title);
      if (bucket) bucket.push(item);
      else itemsByTitle.set(item.title, [item]);
    }
    const representativeItems = Array.from(itemsByTitle.values(), (bucket) => bucket[0]);

    const result = await callAexaAiIntelligence<{
      analyzed: Array<{
        original_title: string;
        is_risk: boolean;
        severity: string;
        category: string;
        relevance_score: number;
        risk_summary: string;
        root_cause: string;
        potential_impact: string;
        recommended_actions: unknown;
        confidence: number;
        source_evidence?: string | null;
      }>;
      count: number;
    }>(
      '/analyze',
      {
        org,
        existing_risks: existingRisks,
        items: representativeItems.map((item) => ({
          title: item.title,
          description: item.description ?? undefined,
          source_name: item.source_name,
          source_category: item.source_category ?? undefined,
          source_credibility: item.source_credibility ?? undefined,
          published_at: item.published_at ? item.published_at.toISOString() : undefined,
        })),
      },
      ctx.organizationId,
    );

    const analyzedByTitle = new Map(result.analyzed.map((entry) => [entry.original_title, entry]));

    const updated = await Promise.all(
      Array.from(itemsByTitle.entries())
        .filter(([title]) => analyzedByTitle.has(title))
        .flatMap(([title, bucket]) => {
          const analysis = analyzedByTitle.get(title)!;
          return bucket.map((item) =>
            prisma.intelligenceItem.update({
              where: { id: item.id },
              data: {
                is_risk: analysis.is_risk,
                severity: analysis.severity,
                category: analysis.category,
                relevance_score: analysis.relevance_score,
                risk_summary: analysis.risk_summary,
                root_cause: analysis.root_cause,
                potential_impact: analysis.potential_impact,
                recommended_actions: analysis.recommended_actions as never,
                confidence: analysis.confidence,
                source_evidence: analysis.source_evidence ?? null,
                analyzed_at: new Date(),
              },
            }),
          );
        }),
    );

    return { items: updated, count: updated.length };
  } catch (error) {
    return wrapAiServiceError(error, 'Failed to analyze threat intelligence items');
  }
};

// --------------------------------------------------------------------------
// POST /intelligence/predict | /mitigations | /rcsa | /resilience-scan
// --------------------------------------------------------------------------

const runOrgLevelAction = async (
  req: Request,
  runType: 'PREDICT' | 'MITIGATIONS' | 'RCSA' | 'RESILIENCE_SCAN',
  aiPath: string,
  fallbackMessage: string,
) => {
  try {
    const user = req.user as JwtPayloadType;
    const ctx = await resolveCallerOrgContext(user.accountId);

    const org = await buildOrgContext(ctx.organizationId);
    const existingRisks = await fetchExistingRisks(ctx.organizationId);

    const body: Record<string, unknown> = { org, existing_risks: existingRisks };
    if (runType === 'RESILIENCE_SCAN') {
      body.sites = await fetchSites(ctx.organizationId);
    }

    const result = await callAexaAiIntelligence(aiPath, body, ctx.organizationId);

    const run = await prisma.intelligenceRun.create({
      data: {
        org_account_id: ctx.organizationId,
        run_type: runType,
        result: result as never,
      },
    });

    return run;
  } catch (error) {
    return wrapAiServiceError(error, fallbackMessage);
  }
};

const predict_into_db = (req: Request) =>
  runOrgLevelAction(
    req,
    'PREDICT',
    '/predict',
    'Failed to generate threat intelligence prediction',
  );

const generate_mitigations_into_db = (req: Request) =>
  runOrgLevelAction(req, 'MITIGATIONS', '/mitigations', 'Failed to generate mitigations');

const generate_rcsa_into_db = (req: Request) =>
  runOrgLevelAction(req, 'RCSA', '/rcsa', 'Failed to generate RCSA');

const resilience_scan_into_db = (req: Request) =>
  runOrgLevelAction(req, 'RESILIENCE_SCAN', '/resilience-scan', 'Failed to run resilience scan');

// --------------------------------------------------------------------------
// GET /intelligence/items
// --------------------------------------------------------------------------

const get_all_items_from_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  const { analyzed, searchTerm, severity } = req.query as Record<string, string>;

  const pagination = paginationHelper({
    page: req.query.page as string,
    limit: req.query.limit as string,
  });

  const whereCondition: Record<string, unknown> = { org_account_id: ctx.organizationId };
  if (analyzed === 'true') {
    whereCondition.analyzed_at = { not: null };
  } else if (analyzed === 'false') {
    whereCondition.analyzed_at = null;
  }

  // aexa-frontend#253: search across the two free-text fields a scraped item
  // actually carries (title always populated, description often is) --
  // same case-insensitive `contains` OR convention as risk.service.ts's
  // get_all_risk_from_db, just spread across two fields instead of one since
  // an IntelligenceItem has no single canonical name field.
  if (searchTerm) {
    whereCondition.OR = [
      { title: { contains: searchTerm, mode: 'insensitive' } },
      { description: { contains: searchTerm, mode: 'insensitive' } },
    ];
  }

  // severity (critical|high|medium|low, set by analyze_items_into_db) --
  // exact match, same convention as this function's own `category` filter on
  // risk.service.ts. IntelligencePage's filter buttons are single-select
  // (one SeverityFilter value at a time, see IntelligencePage.tsx), so this
  // stays a plain equality filter rather than an `in` — no multi-select UI
  // exists on the frontend to justify accepting an array here.
  if (severity) {
    whereCondition.severity = severity;
  }

  const [data, total] = await Promise.all([
    prisma.intelligenceItem.findMany({
      where: whereCondition,
      skip: pagination.skip,
      take: pagination.limit,
      orderBy: { scraped_at: 'desc' },
    }),
    prisma.intelligenceItem.count({ where: whereCondition }),
  ]);

  return { data, meta: buildPaginationMeta(pagination, total) };
};

// --------------------------------------------------------------------------
// GET /intelligence/runs
// --------------------------------------------------------------------------

const VALID_RUN_TYPES = new Set(['PREDICT', 'MITIGATIONS', 'RCSA', 'RESILIENCE_SCAN']);

const get_all_runs_from_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  const { run_type } = req.query as Record<string, string>;

  const pagination = paginationHelper({
    page: req.query.page as string,
    limit: req.query.limit as string,
  });

  const whereCondition: Record<string, unknown> = { org_account_id: ctx.organizationId };
  if (run_type && VALID_RUN_TYPES.has(run_type)) {
    whereCondition.run_type = run_type;
  }

  const [data, total] = await Promise.all([
    prisma.intelligenceRun.findMany({
      where: whereCondition,
      skip: pagination.skip,
      take: pagination.limit,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.intelligenceRun.count({ where: whereCondition }),
  ]);

  return { data, meta: buildPaginationMeta(pagination, total) };
};

// --------------------------------------------------------------------------
// POST /intelligence/items/:id/create-risk
// --------------------------------------------------------------------------

// severity (critical|high|medium|low, from aexa-ai's AnalyzedItem) has no
// direct Risk column -- Risk scores inherent/residual risk numerically
// (0-100-ish Int?, see risk.prisma) rather than as a severity label. Mapped
// to a representative score for both inherent_score and residual_score:
// residual == inherent at creation time because no controls have been
// assessed yet for a risk that's only just been promoted from a scraped
// article -- that assessment is exactly what a human does next, in the
// existing risk.route.ts PATCH flow.
//
// aexa-server#346 review finding: this mapping is now shared (risk_ref.ts's
// SEVERITY_TO_SCORE) with compliance.service.ts's create_risk_from_obligation_into_db,
// the other "promote this record into a Risk" call site that needed the
// identical translation -- was duplicated verbatim here before.

const create_risk_from_item_into_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  // Promoting an IntelligenceItem into a real Risk produces exactly the same
  // side effect (a new org Risk row) as POST /risk, which is already gated
  // by assertCanWriteOrgResource (ADMIN/LEAD_AUDITOR only) --
  // risk.service.ts's create_risk_into_db. The design brief for this module
  // only called out scrape/analyze/view as unrestricted; create-risk wasn't
  // explicitly listed either way. Applying the existing write gate here
  // (rather than leaving this one path to Risk creation unrestricted) is a
  // judgment call made while implementing, flagged in the PR description as
  // instructed.
  assertCanWriteOrgResource(ctx);
  const { id } = req.params as Record<string, string>;
  const { siteId } = (req.body ?? {}) as { siteId?: string };

  const item = await prisma.intelligenceItem.findFirst({
    where: { id, org_account_id: ctx.organizationId },
  });
  if (!item) throw new AppError('Intelligence item not found', 404);
  if (!item.analyzed_at) {
    throw new AppError('This item has not been analyzed yet', 409);
  }
  if (item.created_risk_id) {
    throw new AppError('This item has already been promoted to a Risk', 409);
  }

  // Risk.site_id is a required FK with no analog on IntelligenceItem (a
  // scraped article isn't tied to one of the org's physical sites). Caller
  // may specify which site the new Risk belongs to; falling back to the
  // org's earliest-created Site keeps this a one-click action in the common
  // single-site case instead of forcing a siteId on every call. No sites at
  // all -> 409 (nothing sensible to default to), not a 500.
  const site = siteId
    ? await prisma.site.findFirst({ where: { id: siteId, org_account_id: ctx.organizationId } })
    : await prisma.site.findFirst({
        where: { org_account_id: ctx.organizationId },
        orderBy: { createdAt: 'asc' },
      });
  if (!site) {
    throw new AppError(
      siteId ? 'Site not found' : 'This organization has no sites to attach the new risk to',
      siteId ? 404 : 409,
    );
  }

  // Unlike onboarding.service.ts's commit transaction (a brand-new org no
  // other transaction can see until it commits), this Risk is created for an
  // EXISTING, live org -- a second create-risk-from-item call (or a
  // concurrent POST /risk) for the same org+category can genuinely race
  // computeNextRiskRef's read-then-write. retryTransactionOnRefConflict
  // retries the whole transaction (fresh ref computed against whatever
  // committed in between) rather than leaving a real, if narrow, race that
  // would 500 the loser instead of just recomputing a fresh ref.
  const result = await retryTransactionOnRefConflict(() =>
    prisma.$transaction(async (tx) => {
      const category = item.category ?? item.source_category ?? 'Uncategorized';
      const ref = await computeNextRiskRef(tx, ctx.organizationId, category);
      const risk = await tx.risk.create({
        data: {
          org_account_id: ctx.organizationId,
          ref,
          name: item.title,
          description: item.risk_summary ?? item.description ?? null,
          category,
          inherent_score: item.severity ? SEVERITY_TO_SCORE[item.severity] : null,
          residual_score: item.severity ? SEVERITY_TO_SCORE[item.severity] : null,
          probability:
            item.relevance_score != null
              ? clampPercent(Math.round(item.relevance_score * 100))
              : null,
          status: 'open',
          ai_generated: true,
          is_edited: false,
          site_id: site.id,
          source_info: item.source_evidence ?? item.link ?? null,
        },
      });
      // Conditional claim (created_risk_id: null in the WHERE, not just the
      // pre-check above) closes the TOCTOU window between that check and this
      // write: two concurrent create-risk calls on the same item would
      // otherwise both pass the earlier `if (item.created_risk_id)` guard and
      // both create a Risk. Whichever request's updateMany actually matches a
      // row (count 1) wins the claim; the loser's transaction throws below and
      // Prisma rolls its `risk.create` back with it, so at most one Risk ever
      // ends up linked to this item.
      const claim = await tx.intelligenceItem.updateMany({
        where: { id: item.id, created_risk_id: null },
        data: { created_risk_id: risk.id },
      });
      if (claim.count === 0) {
        throw new AppError('This item has already been promoted to a Risk', 409);
      }
      return risk;
    }),
  );

  return result;
};

export const intelligence_service = {
  scrape_sources_into_db,
  analyze_items_into_db,
  predict_into_db,
  generate_mitigations_into_db,
  generate_rcsa_into_db,
  resilience_scan_into_db,
  get_all_items_from_db,
  get_all_runs_from_db,
  create_risk_from_item_into_db,
};
