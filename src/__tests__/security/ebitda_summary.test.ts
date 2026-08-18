import { describe, expect, it } from 'vitest';
import { computeEbitdaSummary } from '../../app/modules/risk/ebitda_summary.js';

describe('computeEbitdaSummary', () => {
  it('produces all seven percentile buckets matching the frontend chart shape', () => {
    const values = Array.from({ length: 100 }, (_, i) => (i + 1) * 1000);
    const summary = computeEbitdaSummary(values, 500_000, 100);
    expect(summary.data.map((d) => d.name)).toEqual([
      'P5',
      'P10',
      'P25',
      'P50',
      'P75',
      'P90',
      'P95',
    ]);
  });

  it('nearest-rank percentiles only return values that actually exist in the sample', () => {
    const values = [10, 20, 30, 40, 50];
    const summary = computeEbitdaSummary(values, 0, 5);
    for (const point of summary.data) {
      expect(values).toContain(point.value);
    }
  });

  it('p5 and p50 match the corresponding bucket in `data`', () => {
    const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    const summary = computeEbitdaSummary(values, 0, 10);
    const p5Point = summary.data.find((d) => d.name === 'P5');
    const p50Point = summary.data.find((d) => d.name === 'P50');
    expect(summary.p5).toBe(p5Point?.value);
    expect(summary.p50).toBe(p50Point?.value);
  });

  it('handles an empty sample without throwing, returning zeros', () => {
    const summary = computeEbitdaSummary([], 250_000, 12);
    expect(summary.data.every((d) => d.value === 0)).toBe(true);
    expect(summary.p5).toBe(0);
    expect(summary.p50).toBe(0);
    expect(summary.risksWithData).toBe(0);
    expect(summary.risksTotal).toBe(12);
  });

  it('passes totalEstimatedEbitda through unchanged (org-level baseline, not derived from the sample)', () => {
    const summary = computeEbitdaSummary([1, 2, 3], 12_345_678, 3);
    expect(summary.totalEstimatedEbitda).toBe(12_345_678);
  });

  it('reports risksWithData as the count of risks with a computed value, separate from risksTotal', () => {
    const summary = computeEbitdaSummary([100, 200], 0, 10);
    expect(summary.risksWithData).toBe(2);
    expect(summary.risksTotal).toBe(10);
  });

  it('is not affected by input ordering', () => {
    const a = computeEbitdaSummary([50, 10, 30, 20, 40], 0, 5);
    const b = computeEbitdaSummary([10, 20, 30, 40, 50], 0, 5);
    expect(a.data).toEqual(b.data);
  });
});
