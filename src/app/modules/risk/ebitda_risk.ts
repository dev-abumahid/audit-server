/**
 * aexa-server#347 — EBITDA-at-risk calculation, per the CEO's proposed
 * actuarial methodology (ticket #347, French original quoted in full
 * there):
 *
 *   EBITDA estimé du site = CA du site x Marge EBITDA moyenne du secteur (benchmark)
 *   EBITDA à Risque       = CA du site x Marge EBITDA benchmark x Probabilité de défaillance x Sévérité
 *
 * Mapping onto this codebase's existing fields (documented here since the
 * ticket's French terms don't have 1:1 field names in risk.prisma):
 *   - "CA du site" (site revenue)         -> Site.revenue
 *   - "Marge EBITDA benchmark"            -> sector_benchmarks.ts, matched
 *                                             via sector_mapper.ts from
 *                                             Site.activity
 *   - "Probabilité de défaillance"        -> Risk.probability (0-100)
 *   - "Sévérité"                          -> Risk.impact (0-100) — the
 *                                             existing, already-collected
 *                                             severity/impact axis (see
 *                                             risk.prisma's impact comment,
 *                                             #241) rather than adding a
 *                                             new field for the same concept.
 * Both probability and impact are stored 0-100 (percent-like ints, same
 * scale risk_scoring.ts already assumes) and divided by 100 here to become
 * the 0-1 fractions the formula's "Probabilité" x "Sévérité" needs.
 *
 * Same derived-with-override shape as risk_scoring.ts's inherent/residual
 * score pair: computed automatically by default, but user-overridable per
 * the ticket ("modifiable par l'utilisateur (devient alors l'EBITDA réel)")
 * -- override targets the BENCHMARK MARGIN (the CEO's "devient l'EBITDA
 * réel" language describes the estimated benchmark being replaced by a
 * real, org-supplied figure, not the final at-risk number being hand-typed
 * over top of a calculation nobody can then audit), and the resulting
 * ebitda_at_risk is still always the live product of the formula using
 * whatever margin (benchmark or overridden) is in effect -- never a bare
 * override number floating independently of probability/impact.
 */

import { clampPercent } from './risk_scoring.js';
import { mapActivityToSector } from './sector_mapper.js';
import { getSectorBenchmark } from './sector_benchmarks.js';

/** CA du site x Marge EBITDA benchmark. Null if revenue is missing/non-positive. */
export function computeEbitdaEstimate(
  siteRevenue: number | null | undefined,
  marginFraction: number,
): number | null {
  if (siteRevenue == null || siteRevenue <= 0) return null;
  return siteRevenue * marginFraction;
}

/**
 * Full formula: CA x Marge x Probabilité x Sévérité. Null whenever any
 * input needed to compute a meaningful number is missing — matching
 * computeInherentScore/computeResidualScore's "unknown input -> null,
 * never a silently-wrong zero" convention (a risk with no probability or
 * impact assessed yet has an UNKNOWN ebitda-at-risk, not a zero one).
 */
export function computeEbitdaAtRisk(
  siteRevenue: number | null | undefined,
  marginFraction: number | null | undefined,
  probability: number | null | undefined,
  impact: number | null | undefined,
): number | null {
  if (siteRevenue == null || siteRevenue <= 0) return null;
  if (marginFraction == null) return null;
  if (probability == null || impact == null) return null;
  const probabilityFraction = clampPercent(probability) / 100;
  const severityFraction = clampPercent(impact) / 100;
  return Math.round(siteRevenue * marginFraction * probabilityFraction * severityFraction);
}

export type EbitdaInputs = {
  site_revenue: number | null | undefined;
  site_activity: string | null | undefined;
  probability: number | null | undefined;
  impact: number | null | undefined;
};

export type EbitdaOverrideRequest = {
  ebitda_override?: boolean;
  // The user-supplied "real" benchmark margin, as a 0-1 fraction (e.g. 0.15
  // for 15%) -- NOT the final at-risk currency amount. See file comment for
  // why the override targets the margin rather than the derived total.
  ebitda_override_margin?: number | null;
  ebitda_override_reason?: string | null;
};

// Deliberately NOT extending EbitdaInputs: site_revenue/site_activity live
// on Site, not Risk, so there's no "previous value" stored on the Risk row
// to diff a fresh Site read against. Staleness detection below is scoped to
// what's actually stored on the Risk (probability/impact) plus whether the
// activity->sector match itself changed -- a same-sector revenue change on
// the Site alone won't flip an existing override to stale. Documented scope
// narrowing (ship-with-review-loop Phase 1): the derived-with-override
// pattern's staleness guarantee is "the inputs THIS row tracks changed",
// and extending that to "any upstream Site field ever changes" would need
// a stored revenue snapshot this ticket doesn't add tonight.
export type EbitdaExistingState = {
  probability: number | null | undefined;
  impact: number | null | undefined;
  ebitda_at_risk: number | null;
  ebitda_benchmark_sector: string | null;
  ebitda_benchmark_margin: number | null;
  ebitda_is_override: boolean;
  ebitda_override_reason: string | null;
  ebitda_overridden_by: string | null;
  ebitda_overridden_at: Date | null;
  ebitda_override_stale: boolean;
};

export type EbitdaFields = {
  ebitda_at_risk: number | null;
  ebitda_benchmark_sector: string | null;
  ebitda_benchmark_margin: number | null;
  ebitda_is_override: boolean;
  ebitda_override_reason: string | null;
  ebitda_overridden_by: string | null;
  ebitda_overridden_at: Date | null;
  ebitda_override_stale: boolean;
};

const autoEbitdaFields = (
  inputs: EbitdaInputs,
  sector: string | null,
  margin: number | null,
): EbitdaFields => ({
  ebitda_at_risk: computeEbitdaAtRisk(
    inputs.site_revenue,
    margin,
    inputs.probability,
    inputs.impact,
  ),
  ebitda_benchmark_sector: sector,
  ebitda_benchmark_margin: margin,
  ebitda_is_override: false,
  ebitda_override_reason: null,
  ebitda_overridden_by: null,
  ebitda_overridden_at: null,
  ebitda_override_stale: false,
});

/**
 * Resolves the full set of ebitda_* fields to persist on a Risk create or
 * update. Mirrors resolveInherentFields/resolveResidualFields's shape
 * exactly: auto-compute by default, honor an explicit override request,
 * preserve an existing override across unrelated edits (marking it stale
 * if a formula input changed underneath it).
 *
 * `inputs.site_activity` is looked up fresh by the caller from the Risk's
 * Site every time (site_id can't itself change on a Risk, but Site.revenue/
 * activity can change independently of any Risk edit — see risk.service.ts's
 * call site for how the current Site row is re-read).
 */
export function resolveEbitdaFields(
  inputs: EbitdaInputs,
  overrideRequest: EbitdaOverrideRequest,
  actorId: string,
  existing: EbitdaExistingState | null,
): { ok: true; fields: EbitdaFields } | { ok: false; message: string } {
  const matchedSector = mapActivityToSector(inputs.site_activity);
  const autoMargin = matchedSector.margin;
  const autoSector = matchedSector.sector;

  if (overrideRequest.ebitda_override === true) {
    if (overrideRequest.ebitda_override_margin == null) {
      return {
        ok: false,
        message: 'ebitda_override_margin is required when ebitda_override is true.',
      };
    }
    if (overrideRequest.ebitda_override_margin < 0 || overrideRequest.ebitda_override_margin > 1) {
      return {
        ok: false,
        message: 'ebitda_override_margin must be a fraction between 0 and 1 (e.g. 0.15 for 15%).',
      };
    }
    if (!overrideRequest.ebitda_override_reason?.trim()) {
      return {
        ok: false,
        message: 'ebitda_override_reason is required when ebitda_override is true.',
      };
    }
    return {
      ok: true,
      fields: {
        ebitda_at_risk: computeEbitdaAtRisk(
          inputs.site_revenue,
          overrideRequest.ebitda_override_margin,
          inputs.probability,
          inputs.impact,
        ),
        // The matched sector label is still recorded even under an
        // override -- it's what the user is overriding FROM, useful
        // context on the risk detail UI ("benchmark: Chemical (Basic)
        // 12.3%, overridden to 18% -- real site data").
        ebitda_benchmark_sector: autoSector,
        ebitda_benchmark_margin: overrideRequest.ebitda_override_margin,
        ebitda_is_override: true,
        ebitda_override_reason: overrideRequest.ebitda_override_reason.trim(),
        ebitda_overridden_by: actorId,
        ebitda_overridden_at: new Date(),
        ebitda_override_stale: false,
      },
    };
  }

  if (overrideRequest.ebitda_override === false) {
    return { ok: true, fields: autoEbitdaFields(inputs, autoSector, autoMargin) };
  }

  if (!existing) {
    return { ok: true, fields: autoEbitdaFields(inputs, autoSector, autoMargin) };
  }

  if (!existing.ebitda_is_override) {
    return { ok: true, fields: autoEbitdaFields(inputs, autoSector, autoMargin) };
  }

  // Existing override in place, untouched by this request: keep the
  // overridden margin, but flag stale if a tracked formula input changed
  // underneath it (probability, impact, or the activity->sector match --
  // see EbitdaExistingState's comment for why a same-sector Site.revenue
  // change alone isn't tracked here) -- same monotonic staleness rule as
  // risk_scoring.ts.
  const inputsChanged =
    inputs.probability !== existing.probability ||
    inputs.impact !== existing.impact ||
    autoSector !== existing.ebitda_benchmark_sector;

  return {
    ok: true,
    fields: {
      ebitda_at_risk: computeEbitdaAtRisk(
        inputs.site_revenue,
        existing.ebitda_benchmark_margin,
        inputs.probability,
        inputs.impact,
      ),
      ebitda_benchmark_sector: existing.ebitda_benchmark_sector,
      ebitda_benchmark_margin: existing.ebitda_benchmark_margin,
      ebitda_is_override: true,
      ebitda_override_reason: existing.ebitda_override_reason,
      ebitda_overridden_by: existing.ebitda_overridden_by,
      ebitda_overridden_at: existing.ebitda_overridden_at,
      ebitda_override_stale: existing.ebitda_override_stale || inputsChanged,
    },
  };
}

export { getSectorBenchmark };
