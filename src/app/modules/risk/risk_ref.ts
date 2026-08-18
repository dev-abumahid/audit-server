import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';

/**
 * aexa-frontend#142 — human-readable Risk reference codes (e.g. "CYB-001"),
 * mirroring Fullbloom's `Risk.ref` field. Fullbloom's own scheme isn't
 * documented anywhere reusable (it's whatever the reference app's seed data
 * happened to use), so the exact prefix mapping and sequencing rule below
 * are an engineering call made for this PR, not a value carried over from
 * the reference implementation.
 *
 * Format: `<PREFIX>-<sequence>`, where PREFIX is a short category-derived
 * code and sequence is a zero-padded (3-digit minimum) integer, scoped per
 * (org_account_id, prefix) — so two orgs each numbering their own "Cyber"
 * risks both start at CYB-001, and a "Financial" risk never competes with a
 * "Cyber" risk's numbering within the same org.
 *
 * The category -> prefix map below was derived from every literal Risk
 * `category` string actually used in this codebase today: onboarding's AI
 * mapper defaults to 'Operational' (onboarding.service.ts), the RSS/
 * intelligence pipeline uses 'cyber' | 'regulatory' | 'financial'
 * (rss_sources.ts), and 'Supply Chain' / 'Cyber' / 'Cybersecurity' /
 * 'Financial' / 'OPERATIONAL' show up across risk.swagger.ts and existing
 * test fixtures. A handful of categories that don't appear as literals yet
 * but are standard GRC taxonomy (Strategic, Reputational, Legal,
 * Environmental, Health & Safety, HR, Technology, Compliance) are mapped
 * too, since a new org's onboarding or manual risk entry can introduce any
 * of them. Matching is case-insensitive (categories show up in this
 * codebase in at least 3 different cases — 'Cyber', 'cyber', 'CYBER' would
 * all need to land on the same prefix).
 */
export const RISK_CATEGORY_PREFIX_MAP: Record<string, string> = {
  cyber: 'CYB',
  cybersecurity: 'CYB',
  'it security': 'CYB',
  'supply chain': 'SUP',
  financial: 'FIN',
  finance: 'FIN',
  operational: 'OPS',
  regulatory: 'REG',
  compliance: 'CMP',
  strategic: 'STR',
  reputational: 'REP',
  reputation: 'REP',
  legal: 'LEG',
  environmental: 'ENV',
  'health and safety': 'HAS',
  'health & safety': 'HAS',
  hr: 'HR',
  'human resources': 'HR',
  technology: 'TEC',
  it: 'ITS',
};

// Fallback for any category not in the explicit map above: first 3
// alphabetic characters, uppercased. E.g. "Geopolitical" -> "GEO". A
// category with fewer than 3 letters (or none at all — an empty/whitespace
// string) falls back further to "GEN" ("General") so a prefix is never
// empty, which the `${prefix}-` unique-scoping below relies on.
export function categoryPrefix(category: string): string {
  const key = category.trim().toLowerCase();
  if (RISK_CATEGORY_PREFIX_MAP[key]) return RISK_CATEGORY_PREFIX_MAP[key];
  const lettersOnly = category.replace(/[^a-zA-Z]/g, '');
  const fallback = lettersOnly.slice(0, 3).toUpperCase();
  return fallback.length >= 2 ? fallback : 'GEN';
}

// Quality-bar-loop review finding (aexa-server#346): this exact
// critical/high/medium/low -> 90/70/50/30 mapping used to be duplicated
// verbatim in intelligence.service.ts's create_risk_from_item_into_db and
// compliance.service.ts's create_risk_from_obligation_into_db -- both
// "promote this record into a Risk" call sites need the identical
// severity-label-has-no-direct-Risk-column translation (Risk scores
// inherent/residual risk numerically, see risk.prisma, not as a severity
// label), so it's shared here rather than copy-pasted a third time.
export const SEVERITY_TO_SCORE: Record<string, number> = {
  critical: 90,
  high: 70,
  medium: 50,
  low: 30,
};

const REF_PADDING = 3;

// PrismaTxClient-shaped type covering just what this module needs, so it
// can be called with either the top-level `prisma` client or a
// `$transaction` callback's `tx` client (same pattern as
// organization.create.service.ts's PrismaTxClient).
type RiskRefClient = {
  risk: {
    findMany: (args: {
      where: { org_account_id: string; ref: { startsWith: string } };
      select: { ref: true };
    }) => Promise<Array<{ ref: string }>>;
  };
};

/**
 * Computes the next unused ref for (orgAccountId, category)'s prefix, by
 * scanning existing refs under that prefix and taking max(sequence) + 1.
 * Deliberately NOT backed by a DB sequence/counter table — this is a
 * best-effort computation, not a guarantee of uniqueness under concurrent
 * callers. Callers that create a Risk row off this value (risk.service.ts,
 * onboarding.service.ts) are responsible for handling a unique-constraint
 * conflict on (org_account_id, ref) themselves — see
 * `createRiskWithGeneratedRef` below, which wraps exactly that retry for the
 * single-risk-creation call site.
 */
export async function computeNextRiskRef(
  client: RiskRefClient,
  orgAccountId: string,
  category: string,
): Promise<string> {
  const prefix = categoryPrefix(category);
  const existing = await client.risk.findMany({
    where: { org_account_id: orgAccountId, ref: { startsWith: `${prefix}-` } },
    select: { ref: true },
  });

  const pattern = new RegExp(`^${prefix}-(\\d+)$`);
  let maxSeq = 0;
  for (const row of existing) {
    const match = row.ref.match(pattern);
    if (match) {
      const value = parseInt(match[1], 10);
      if (value > maxSeq) maxSeq = value;
    }
  }

  const next = maxSeq + 1;
  return `${prefix}-${String(next).padStart(REF_PADDING, '0')}`;
}

const MAX_REF_CREATE_ATTEMPTS = 5;

export function isUniqueRefConflict(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002' &&
    !!(error.meta?.target as string[] | undefined)?.includes('ref')
  );
}

/**
 * Creates a Risk row with a freshly-computed `ref`, retrying on a unique
 * constraint conflict (P2002 on the (org_account_id, ref) index) by
 * recomputing the next ref and trying again. This is the concurrency
 * safety net for `computeNextRiskRef`'s otherwise-racy
 * read-then-write: two concurrent POST /risk calls for the same org+category
 * can both read the same max(sequence) and both attempt the same candidate
 * ref, but only one create can win the unique constraint — the loser
 * recomputes (now seeing the winner's row) and retries, rather than 500ing
 * the request.
 */
export async function createRiskWithGeneratedRef(
  data: Omit<Prisma.RiskUncheckedCreateInput, 'ref'>,
): Promise<Awaited<ReturnType<typeof prisma.risk.create>>> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_REF_CREATE_ATTEMPTS; attempt += 1) {
    const ref = await computeNextRiskRef(prisma, data.org_account_id, data.category);
    try {
      return await prisma.risk.create({ data: { ...data, ref } });
    } catch (error) {
      lastError = error;
      if (!isUniqueRefConflict(error)) throw error;
      // else: fall through and retry with a recomputed ref.
    }
  }
  throw lastError;
}

/**
 * Retries an ENTIRE `prisma.$transaction(...)` invocation on a ref
 * unique-constraint conflict, for callers where `computeNextRiskRef` +
 * `tx.risk.create` happen INSIDE a transaction alongside other writes (so
 * `createRiskWithGeneratedRef`'s bare `prisma.risk.create` retry doesn't
 * apply — you can't retry a single statement after a Postgres constraint
 * violation without rolling back first; once one statement in a transaction
 * errors, Postgres refuses every subsequent statement until the whole
 * transaction is rolled back). Each retry re-invokes `runTransaction` from
 * scratch, which opens a brand-new transaction and recomputes the ref fresh
 * against however far concurrent callers have advanced.
 *
 * Only needed where the Risk being created can genuinely race against
 * ANOTHER already-committed transaction for the same (org, category) --
 * i.e. an existing, live org (see intelligence.service.ts's
 * create_risk_from_item_into_db). NOT needed for onboarding.service.ts's
 * commit path: that transaction creates a brand-new org (a fresh UUID no
 * other process can reference until this transaction commits) and generates
 * every risk's ref sequentially (awaited, not parallel) within that same
 * transaction, so there is no other transaction that could possibly be
 * racing it for the same org+category.
 */
export async function retryTransactionOnRefConflict<T>(
  runTransaction: () => Promise<T>,
  maxAttempts = MAX_REF_CREATE_ATTEMPTS,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await runTransaction();
    } catch (error) {
      lastError = error;
      if (!isUniqueRefConflict(error)) throw error;
      // else: fall through and retry the whole transaction from scratch.
    }
  }
  throw lastError;
}
