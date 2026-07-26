import { describe, expect, it } from 'vitest';
import {
  computeControlEffectiveness,
  computeResidualScore,
  resolveResidualFields,
} from '../../app/modules/risk/risk_scoring.js';

describe('computeControlEffectiveness', () => {
  it('multiplies design and operating effectiveness (COSO two-dimensional model)', () => {
    expect(computeControlEffectiveness(80, 80)).toBeCloseTo(0.64);
  });

  it('returns null when design effectiveness is unassessed', () => {
    expect(computeControlEffectiveness(null, 80)).toBeNull();
  });

  it('returns null when operating effectiveness is unassessed', () => {
    expect(computeControlEffectiveness(80, undefined)).toBeNull();
  });

  it('caps combined effectiveness at 0.90 even for two perfect scores', () => {
    expect(computeControlEffectiveness(100, 100)).toBe(0.9);
  });

  it('clamps out-of-range inputs into [0, 100] before combining', () => {
    expect(computeControlEffectiveness(150, 100)).toBe(0.9);
    expect(computeControlEffectiveness(-10, 100)).toBe(0);
  });
});

describe('computeResidualScore', () => {
  it('discounts inherent score by control effectiveness', () => {
    // 100 x (1 - 0.64) = 36
    expect(computeResidualScore(100, 80, 80)).toBe(36);
  });

  it('returns null when inherent_score is unknown', () => {
    expect(computeResidualScore(null, 80, 80)).toBeNull();
  });

  it('defaults residual to the full inherent score when controls are unassessed', () => {
    expect(computeResidualScore(72, null, null)).toBe(72);
    expect(computeResidualScore(72, 80, null)).toBe(72);
  });

  it('rounds to the nearest integer on the 0-100 scale', () => {
    // 70 x (1 - 0.5*0.5) = 70 x 0.75 = 52.5 -> rounds to 53
    expect(computeResidualScore(70, 50, 50)).toBe(53);
  });
});

describe('resolveResidualFields', () => {
  const inputs = (over: Partial<Parameters<typeof resolveResidualFields>[0]> = {}) => ({
    inherent_score: 100,
    control_design_eff: 80,
    control_operating_eff: 80,
    ...over,
  });

  const overriddenExisting = (
    over: Partial<Parameters<typeof resolveResidualFields>[3] & object> = {},
  ) => ({
    ...inputs(),
    residual_score: 50,
    residual_is_override: true,
    residual_override_reason: 'board-directed figure',
    residual_overridden_by: 'user-1',
    residual_overridden_at: new Date('2026-01-01'),
    residual_override_stale: false,
    ...over,
  });

  it('auto-computes on create (no existing row, no override requested)', () => {
    const result = resolveResidualFields(inputs(), {}, 'user-1', null);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fields).toMatchObject({ residual_score: 36, residual_is_override: false });
  });

  it('rejects an override request missing residual_score', () => {
    const result = resolveResidualFields(
      inputs(),
      { residual_override: true, residual_override_reason: 'client-approved manual figure' },
      'user-1',
      null,
    );
    expect(result.ok).toBe(false);
  });

  it('rejects an override request missing a reason', () => {
    const result = resolveResidualFields(
      inputs(),
      { residual_override: true, residual_score: 50 },
      'user-1',
      null,
    );
    expect(result.ok).toBe(false);
  });

  it('rejects an override request with a blank/whitespace-only reason', () => {
    const result = resolveResidualFields(
      inputs(),
      { residual_override: true, residual_score: 50, residual_override_reason: '   ' },
      'user-1',
      null,
    );
    expect(result.ok).toBe(false);
  });

  it('accepts a valid override on create, tracking who/when/why', () => {
    const result = resolveResidualFields(
      inputs(),
      {
        residual_override: true,
        residual_score: 50,
        residual_override_reason: 'board-directed figure',
      },
      'user-1',
      null,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fields).toMatchObject({
      residual_score: 50,
      residual_is_override: true,
      residual_override_reason: 'board-directed figure',
      residual_overridden_by: 'user-1',
      residual_override_stale: false,
    });
    expect(result.fields.residual_overridden_at).toBeInstanceOf(Date);
  });

  it('auto-recomputes on update when the existing row was never overridden', () => {
    const existing = {
      ...inputs(),
      residual_score: 36,
      residual_is_override: false,
      residual_override_reason: null,
      residual_overridden_by: null,
      residual_overridden_at: null,
      residual_override_stale: false,
    };
    // control_design_eff improved from 80 -> 100.
    const result = resolveResidualFields(
      inputs({ control_design_eff: 100 }),
      {},
      'user-2',
      existing,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 100 x (1 - 1.0*0.8) = 20
    expect(result.fields).toMatchObject({ residual_score: 20, residual_is_override: false });
  });

  it('preserves an existing override untouched when inputs are unchanged', () => {
    const existing = overriddenExisting();
    const result = resolveResidualFields(inputs(), {}, 'user-2', existing);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fields).toMatchObject({
      residual_score: 50,
      residual_is_override: true,
      residual_override_reason: 'board-directed figure',
      residual_overridden_by: 'user-1',
      residual_override_stale: false,
    });
  });

  it('marks an existing override stale (but keeps it) when inherent_score changes', () => {
    const existing = overriddenExisting();
    // inherent_score changed from 100 -> 90 without re-confirming the override.
    const result = resolveResidualFields(inputs({ inherent_score: 90 }), {}, 'user-2', existing);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fields).toMatchObject({
      residual_score: 50,
      residual_is_override: true,
      residual_override_reason: 'board-directed figure',
      residual_override_stale: true,
    });
  });

  it('marks an existing override stale when only control_design_eff changes', () => {
    const existing = overriddenExisting();
    const result = resolveResidualFields(
      inputs({ control_design_eff: 50 }),
      {},
      'user-2',
      existing,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fields).toMatchObject({ residual_score: 50, residual_override_stale: true });
  });

  it('marks an existing override stale when both inherent_score and control_design_eff change at once', () => {
    const existing = overriddenExisting();
    const result = resolveResidualFields(
      inputs({ inherent_score: 90, control_design_eff: 50 }),
      {},
      'user-2',
      existing,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fields).toMatchObject({ residual_score: 50, residual_override_stale: true });
  });

  it('keeps an override stale on a later unrelated edit instead of silently clearing the flag', () => {
    // Simulates two successive updates: the first already marked the
    // override stale; a second, unrelated edit (inputs unchanged from this
    // point on) must not un-stale it just because THIS request's delta is
    // empty.
    const existing = overriddenExisting({ residual_override_stale: true });
    const result = resolveResidualFields(inputs(), {}, 'user-2', existing);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fields).toMatchObject({ residual_score: 50, residual_override_stale: true });
  });

  it('clears an override and reverts to the computed value when residual_override is explicitly false', () => {
    const existing = overriddenExisting();
    const result = resolveResidualFields(
      inputs(),
      { residual_override: false },
      'user-2',
      existing,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fields).toMatchObject({
      residual_score: 36,
      residual_is_override: false,
      residual_override_reason: null,
      residual_overridden_by: null,
    });
  });

  it('replaces an existing override with a fresh one when residual_override is requested again', () => {
    const existing = overriddenExisting();
    const result = resolveResidualFields(
      inputs(),
      {
        residual_override: true,
        residual_score: 44,
        residual_override_reason: 'revised board figure',
      },
      'user-2',
      existing,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fields).toMatchObject({
      residual_score: 44,
      residual_is_override: true,
      residual_override_reason: 'revised board figure',
      residual_overridden_by: 'user-2',
      residual_override_stale: false,
    });
  });
});
