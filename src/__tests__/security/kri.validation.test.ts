import { describe, expect, it } from 'vitest';
import { kri_validations } from '../../app/modules/kri/kri.validation.js';

const BASE = {
  risk_id: 'risk-1',
  name: 'Failed login attempts',
  unit: 'count',
  current_value: 10,
  alert_threshold: 100,
  target_value: 0,
};

// 2026-08-19 audit: current_value/alert_threshold/target_value were bare
// z.number(), which rejects NaN by default but NOT +/-Infinity -- an
// Infinity value would pass validation and reach compute_kri_status's
// threshold comparisons, producing a meaningless/NaN alert-status result.
describe('kri_validations — finite() on numeric fields', () => {
  it.each(['current_value', 'alert_threshold', 'target_value'])(
    'rejects Infinity on create for %s',
    (field) => {
      const result = kri_validations.create_kri.safeParse({ ...BASE, [field]: Infinity });
      expect(result.success).toBe(false);
    },
  );

  it.each(['current_value', 'alert_threshold', 'target_value'])(
    'rejects -Infinity on create for %s',
    (field) => {
      const result = kri_validations.create_kri.safeParse({ ...BASE, [field]: -Infinity });
      expect(result.success).toBe(false);
    },
  );

  it('accepts a normal, finite create payload', () => {
    const result = kri_validations.create_kri.safeParse(BASE);
    expect(result.success).toBe(true);
  });

  it('rejects Infinity in alert_threshold on a partial update', () => {
    const result = kri_validations.update_kri.safeParse({ alert_threshold: Infinity });
    expect(result.success).toBe(false);
  });

  it('rejects Infinity on submit_value', () => {
    const result = kri_validations.submit_value.safeParse({ current_value: Infinity });
    expect(result.success).toBe(false);
  });
});
