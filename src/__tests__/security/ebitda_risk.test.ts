import { describe, expect, it } from 'vitest';
import {
  computeEbitdaAtRisk,
  computeEbitdaEstimate,
  resolveEbitdaFields,
  type EbitdaExistingState,
} from '../../app/modules/risk/ebitda_risk.js';

describe('computeEbitdaEstimate', () => {
  it('multiplies revenue by the margin fraction', () => {
    expect(computeEbitdaEstimate(1_000_000, 0.15)).toBe(150_000);
  });

  it('returns null when revenue is missing', () => {
    expect(computeEbitdaEstimate(null, 0.15)).toBeNull();
    expect(computeEbitdaEstimate(undefined, 0.15)).toBeNull();
  });

  it('returns null when revenue is zero or negative (no meaningful estimate)', () => {
    expect(computeEbitdaEstimate(0, 0.15)).toBeNull();
    expect(computeEbitdaEstimate(-500, 0.15)).toBeNull();
  });
});

describe('computeEbitdaAtRisk', () => {
  it('applies the full CEO formula: CA x Marge x Probabilite x Severite', () => {
    // 1,000,000 x 0.15 x 0.40 x 0.60 = 36,000
    expect(computeEbitdaAtRisk(1_000_000, 0.15, 40, 60)).toBe(36_000);
  });

  it('rounds to the nearest integer', () => {
    // 1,000,000 x 0.1234 x 0.33 x 0.5 = 20,361.0 (already integer after rounding)
    expect(computeEbitdaAtRisk(1_000_000, 0.1234, 33, 50)).toBe(
      Math.round(1_000_000 * 0.1234 * 0.33 * 0.5),
    );
  });

  it('returns null when revenue is missing or non-positive', () => {
    expect(computeEbitdaAtRisk(null, 0.15, 40, 60)).toBeNull();
    expect(computeEbitdaAtRisk(0, 0.15, 40, 60)).toBeNull();
  });

  it('returns null when margin is missing', () => {
    expect(computeEbitdaAtRisk(1_000_000, null, 40, 60)).toBeNull();
  });

  it('returns null when probability is missing (never silently treats unknown as zero)', () => {
    expect(computeEbitdaAtRisk(1_000_000, 0.15, null, 60)).toBeNull();
  });

  it('returns null when impact/severity is missing', () => {
    expect(computeEbitdaAtRisk(1_000_000, 0.15, 40, null)).toBeNull();
  });

  it('clamps out-of-range probability/impact into [0, 100]', () => {
    expect(computeEbitdaAtRisk(1_000_000, 0.1, 150, 150)).toBe(
      computeEbitdaAtRisk(1_000_000, 0.1, 100, 100),
    );
    expect(computeEbitdaAtRisk(1_000_000, 0.1, -10, 50)).toBe(
      computeEbitdaAtRisk(1_000_000, 0.1, 0, 50),
    );
  });
});

describe('resolveEbitdaFields', () => {
  const chemicalInputs = (over: Partial<Parameters<typeof resolveEbitdaFields>[0]> = {}) => ({
    site_revenue: 1_000_000,
    site_activity: 'Industrial chemical manufacturing and storage',
    probability: 40,
    impact: 60,
    ...over,
  });

  it('auto-computes from the matched sector benchmark on create (no existing row)', () => {
    const result = resolveEbitdaFields(chemicalInputs(), {}, 'actor-1', null);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fields.ebitda_benchmark_sector).toBe('CHEMICAL_BASIC');
    expect(result.fields.ebitda_benchmark_margin).toBeCloseTo(0.1234);
    expect(result.fields.ebitda_at_risk).toBe(Math.round(1_000_000 * 0.1234 * 0.4 * 0.6));
    expect(result.fields.ebitda_is_override).toBe(false);
  });

  it('falls back to the OTHER bucket for unrecognized activity text, never blocking', () => {
    const result = resolveEbitdaFields(
      chemicalInputs({ site_activity: 'Bespoke artisanal umbrella repair' }),
      {},
      'actor-1',
      null,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fields.ebitda_benchmark_sector).toBe('OTHER_UNCLASSIFIED');
    expect(result.fields.ebitda_benchmark_margin).toBeCloseTo(0.1742);
  });

  it('requires ebitda_override_margin when ebitda_override is true', () => {
    const result = resolveEbitdaFields(
      chemicalInputs(),
      { ebitda_override: true, ebitda_override_reason: 'Real audited figure' },
      'actor-1',
      null,
    );
    expect(result.ok).toBe(false);
  });

  it('requires ebitda_override_reason when ebitda_override is true', () => {
    const result = resolveEbitdaFields(
      chemicalInputs(),
      { ebitda_override: true, ebitda_override_margin: 0.2 },
      'actor-1',
      null,
    );
    expect(result.ok).toBe(false);
  });

  it('rejects an override margin outside [0, 1]', () => {
    const result = resolveEbitdaFields(
      chemicalInputs(),
      { ebitda_override: true, ebitda_override_margin: 1.5, ebitda_override_reason: 'typo test' },
      'actor-1',
      null,
    );
    expect(result.ok).toBe(false);
  });

  it('accepts a valid override, tracking who set it, why, and recomputing ebitda_at_risk from the overridden margin', () => {
    const result = resolveEbitdaFields(
      chemicalInputs(),
      {
        ebitda_override: true,
        ebitda_override_margin: 0.2,
        ebitda_override_reason: 'Audited 2026 accounts',
      },
      'actor-1',
      null,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fields.ebitda_is_override).toBe(true);
    expect(result.fields.ebitda_benchmark_margin).toBe(0.2);
    // Still the matched sector, recorded as context for what was overridden.
    expect(result.fields.ebitda_benchmark_sector).toBe('CHEMICAL_BASIC');
    expect(result.fields.ebitda_overridden_by).toBe('actor-1');
    expect(result.fields.ebitda_at_risk).toBe(Math.round(1_000_000 * 0.2 * 0.4 * 0.6));
    expect(result.fields.ebitda_override_reason).toBe('Audited 2026 accounts');
  });

  it('trims the override reason', () => {
    const result = resolveEbitdaFields(
      chemicalInputs(),
      { ebitda_override: true, ebitda_override_margin: 0.2, ebitda_override_reason: '  padded  ' },
      'actor-1',
      null,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fields.ebitda_override_reason).toBe('padded');
  });

  it('rejects a whitespace-only override reason', () => {
    const result = resolveEbitdaFields(
      chemicalInputs(),
      { ebitda_override: true, ebitda_override_margin: 0.2, ebitda_override_reason: '   ' },
      'actor-1',
      null,
    );
    expect(result.ok).toBe(false);
  });

  it('clears an override when ebitda_override is explicitly false', () => {
    const existing: EbitdaExistingState = {
      probability: 40,
      impact: 60,
      ebitda_at_risk: 999,
      ebitda_benchmark_sector: 'CHEMICAL_BASIC',
      ebitda_benchmark_margin: 0.5,
      ebitda_is_override: true,
      ebitda_override_reason: 'old override',
      ebitda_overridden_by: 'actor-old',
      ebitda_overridden_at: new Date('2026-01-01'),
      ebitda_override_stale: false,
    };
    const result = resolveEbitdaFields(
      chemicalInputs(),
      { ebitda_override: false },
      'actor-2',
      existing,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fields.ebitda_is_override).toBe(false);
    expect(result.fields.ebitda_benchmark_margin).toBeCloseTo(0.1234);
  });

  it('preserves an existing override untouched by the request, keeping the overridden margin', () => {
    const existing: EbitdaExistingState = {
      probability: 40,
      impact: 60,
      ebitda_at_risk: Math.round(1_000_000 * 0.2 * 0.4 * 0.6),
      ebitda_benchmark_sector: 'CHEMICAL_BASIC',
      ebitda_benchmark_margin: 0.2,
      ebitda_is_override: true,
      ebitda_override_reason: 'audited',
      ebitda_overridden_by: 'actor-1',
      ebitda_overridden_at: new Date('2026-01-01'),
      ebitda_override_stale: false,
    };
    const result = resolveEbitdaFields(chemicalInputs(), {}, 'actor-2', existing);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fields.ebitda_is_override).toBe(true);
    expect(result.fields.ebitda_benchmark_margin).toBe(0.2);
    expect(result.fields.ebitda_override_stale).toBe(false);
  });

  it('flags an existing override stale when probability changes underneath it', () => {
    const existing: EbitdaExistingState = {
      probability: 40,
      impact: 60,
      ebitda_at_risk: 100,
      ebitda_benchmark_sector: 'CHEMICAL_BASIC',
      ebitda_benchmark_margin: 0.2,
      ebitda_is_override: true,
      ebitda_override_reason: 'audited',
      ebitda_overridden_by: 'actor-1',
      ebitda_overridden_at: new Date('2026-01-01'),
      ebitda_override_stale: false,
    };
    const result = resolveEbitdaFields(
      chemicalInputs({ probability: 90 }),
      {},
      'actor-2',
      existing,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fields.ebitda_is_override).toBe(true);
    expect(result.fields.ebitda_override_stale).toBe(true);
    // Still recomputes the live amount from the frozen overridden margin +
    // fresh probability/impact -- never a bare frozen total.
    expect(result.fields.ebitda_at_risk).toBe(Math.round(1_000_000 * 0.2 * 0.9 * 0.6));
  });

  it('flags an existing override stale when the activity/sector match changes', () => {
    const existing: EbitdaExistingState = {
      probability: 40,
      impact: 60,
      ebitda_at_risk: 100,
      ebitda_benchmark_sector: 'CHEMICAL_BASIC',
      ebitda_benchmark_margin: 0.2,
      ebitda_is_override: true,
      ebitda_override_reason: 'audited',
      ebitda_overridden_by: 'actor-1',
      ebitda_overridden_at: new Date('2026-01-01'),
      ebitda_override_stale: false,
    };
    const result = resolveEbitdaFields(
      chemicalInputs({ site_activity: 'Hospital and clinic operations' }),
      {},
      'actor-2',
      existing,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fields.ebitda_override_stale).toBe(true);
  });

  it('keeps staleness monotonic: an already-stale override stays stale even if this edit does not itself change anything tracked', () => {
    const existing: EbitdaExistingState = {
      probability: 40,
      impact: 60,
      ebitda_at_risk: 100,
      ebitda_benchmark_sector: 'CHEMICAL_BASIC',
      ebitda_benchmark_margin: 0.2,
      ebitda_is_override: true,
      ebitda_override_reason: 'audited',
      ebitda_overridden_by: 'actor-1',
      ebitda_overridden_at: new Date('2026-01-01'),
      ebitda_override_stale: true,
    };
    const result = resolveEbitdaFields(chemicalInputs(), {}, 'actor-2', existing);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fields.ebitda_override_stale).toBe(true);
  });
});
