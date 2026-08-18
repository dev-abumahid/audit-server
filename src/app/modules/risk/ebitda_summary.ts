/**
 * aexa-server#347 — org-wide EBITDA-at-risk distribution, backing the
 * dashboard's "Distribution EBITDA at Risk" chart
 * (aexa-frontend/src/dashboard/organization/overview/Overview.tsx), which
 * today renders a hardcoded static P5...P95 array (see that file's own
 * comment). This module is the pure percentile/aggregation logic; the
 * service layer (risk.service.ts) is responsible for the org-scoped DB
 * reads that feed it.
 *
 * Percentile buckets match the frontend's existing seven buckets exactly
 * (P5, P10, P25, P50, P75, P90, P95) so the chart's shape doesn't need to
 * change, only its data source.
 */

const PERCENTILE_BUCKETS = [5, 10, 25, 50, 75, 90, 95] as const;

export type EbitdaDistributionPoint = { name: string; value: number };

/**
 * Nearest-rank percentile (no interpolation) — simplest correct choice for
 * a small, discrete sample (an org's risk count is realistically dozens to
 * low hundreds, not a scale where interpolation-method choice matters) and
 * avoids inventing a "value between two real risks" number that doesn't
 * correspond to any actual risk.
 */
function percentile(sortedValues: number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sortedValues.length);
  const index = Math.min(Math.max(rank - 1, 0), sortedValues.length - 1);
  return sortedValues[index];
}

export type EbitdaSummary = {
  data: EbitdaDistributionPoint[];
  p5: number;
  p50: number;
  /** Sum of each site's revenue x benchmark margin (estimated EBITDA) across the org's sites — the "budget"/baseline figure, not itself at risk. */
  totalEstimatedEbitda: number;
  /** How many of the org's risks actually had a computed ebitda_at_risk (vs. missing probability/impact/revenue) — lets the frontend show "N of M risks" instead of silently treating a sparse org as a healthy one. */
  risksWithData: number;
  risksTotal: number;
};

export function computeEbitdaSummary(
  ebitdaAtRiskValues: number[],
  totalEstimatedEbitda: number,
  risksTotal: number,
): EbitdaSummary {
  const sorted = [...ebitdaAtRiskValues].sort((a, b) => a - b);
  const data = PERCENTILE_BUCKETS.map((p) => ({
    name: `P${p}`,
    value: percentile(sorted, p),
  }));
  return {
    data,
    p5: percentile(sorted, 5),
    p50: percentile(sorted, 50),
    totalEstimatedEbitda,
    risksWithData: sorted.length,
    risksTotal,
  };
}
