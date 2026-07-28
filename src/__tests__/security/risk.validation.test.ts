import { describe, expect, it } from 'vitest';
import { risk_validations } from '../../app/modules/risk/risk.validation.js';

const BASE = {
  name: 'Supply chain disruption',
  category: 'supply_chain',
  status: 'open',
  site_id: 'site-1',
};

// aexa-server#259: inherent_score/impact/residual_score already had
// .min(0).max(100) -- probability/control_design_eff/control_operating_eff
// didn't, even though risk_scoring.ts's own comments describe all six as
// 0-100 percentages/scores and clampPercent clamps the control-effectiveness
// fields internally when deriving inherent/residual scores. This suite
// covers all six together so a future field added to this schema without
// bounds gets caught by the parallel-structure of these describe blocks.
describe('risk_validations.create_risk — 0-100 bounded fields', () => {
  it.each([
    ['inherent_score', 8],
    ['impact', 8],
    ['residual_score', 5],
    ['probability', 40],
    ['control_design_eff', 60],
    ['control_operating_eff', 60],
  ])('accepts an in-range %s', (field, value) => {
    const result = risk_validations.create_risk.safeParse({ ...BASE, [field]: value });
    expect(result.success).toBe(true);
  });

  it.each([
    ['inherent_score', -1],
    ['impact', -1],
    ['residual_score', -1],
    ['probability', -500],
    ['control_design_eff', -1],
    ['control_operating_eff', -1],
  ])('rejects a negative %s', (field, value) => {
    const result = risk_validations.create_risk.safeParse({ ...BASE, [field]: value });
    expect(result.success).toBe(false);
  });

  it.each([
    ['inherent_score', 101],
    ['impact', 101],
    ['residual_score', 101],
    ['probability', 9999],
    ['control_design_eff', 9999],
    ['control_operating_eff', 9999],
  ])('rejects an out-of-range %s', (field, value) => {
    const result = risk_validations.create_risk.safeParse({ ...BASE, [field]: value });
    expect(result.success).toBe(false);
  });

  it('allows omitting all six bounded fields entirely', () => {
    const result = risk_validations.create_risk.safeParse(BASE);
    expect(result.success).toBe(true);
  });
});

describe('risk_validations.update_risk — 0-100 bounded fields (partial)', () => {
  it.each([
    ['probability', -1],
    ['control_design_eff', -1],
    ['control_operating_eff', -1],
  ])('rejects an out-of-range %s on a partial update too', (field, value) => {
    const result = risk_validations.update_risk.safeParse({ [field]: value });
    expect(result.success).toBe(false);
  });
});
