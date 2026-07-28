import { describe, expect, it } from 'vitest';
import { onboarding_validations } from '../../app/modules/onboarding/onboarding.validation.js';

const { commit } = onboarding_validations;

// A minimal valid commit body; helpers below scale up the nested arrays.
const baseBody = (sites: unknown[]) => ({
  organizationName: 'Acme Corp',
  email: 'admin@acme.test',
  password: 'supersecret',
  sector: 'Manufacturing',
  country: 'France',
  sites,
});

const makeRisk = (kriCount = 0) => ({
  name: 'Supplier concentration',
  category: 'Supply Chain',
  probability: 60,
  status: 'open',
  kris: Array.from({ length: kriCount }, (_, i) => ({ name: `KRI ${i}`, unit: '%' })),
});

const makeSite = (riskCount = 0, krisPerRisk = 0) => ({
  name: 'Lyon Plant',
  revenue: 1000,
  employees_count: 10,
  site_type: 'Production',
  risks: Array.from({ length: riskCount }, () => makeRisk(krisPerRisk)),
});

describe('onboarding commit — probability range safety net (#211)', () => {
  it('accepts an in-range integer percentage', () => {
    const result = commit.safeParse(baseBody([makeSite(1, 0)]));
    expect(result.success).toBe(true);
  });

  it('rejects a runaway probability like 6000 (the percentage-scale bug)', () => {
    const site = makeSite(1, 0);
    (site.risks[0] as { probability: number }).probability = 6000;
    const result = commit.safeParse(baseBody([site]));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message.includes('between 0 and 100'))).toBe(true);
    }
  });

  it('rejects a negative probability', () => {
    const site = makeSite(1, 0);
    (site.risks[0] as { probability: number }).probability = -5;
    expect(commit.safeParse(baseBody([site])).success).toBe(false);
  });
});

// Issue #296 — inherent_score (and, mirroring it, residual_score) lacked the
// same 0-100 safety net that probability already has above, unlike
// risk.validation.ts's equivalent fields which have always had it.
describe('onboarding commit — inherent_score / residual_score range safety net (#296)', () => {
  it('accepts an in-range integer inherent_score and residual_score', () => {
    const site = makeSite(1, 0);
    (site.risks[0] as Record<string, unknown>).inherent_score = 75;
    (site.risks[0] as Record<string, unknown>).residual_score = 40;
    const result = commit.safeParse(baseBody([site]));
    expect(result.success).toBe(true);
  });

  it('rejects an out-of-range inherent_score like 140', () => {
    const site = makeSite(1, 0);
    (site.risks[0] as Record<string, unknown>).inherent_score = 140;
    const result = commit.safeParse(baseBody([site]));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((i) => i.message.includes('Inherent score must be between')),
      ).toBe(true);
    }
  });

  it('rejects a negative inherent_score', () => {
    const site = makeSite(1, 0);
    (site.risks[0] as Record<string, unknown>).inherent_score = -5;
    expect(commit.safeParse(baseBody([site])).success).toBe(false);
  });

  it('rejects an out-of-range residual_score like 140', () => {
    const site = makeSite(1, 0);
    (site.risks[0] as Record<string, unknown>).residual_score = 140;
    const result = commit.safeParse(baseBody([site]));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((i) => i.message.includes('Residual score must be between')),
      ).toBe(true);
    }
  });
});

describe('onboarding commit — payload size caps vs transaction timeout (#210)', () => {
  it('accepts a realistically-sized payload (well under the caps)', () => {
    // 3 sites, ~5 risks each, ~2 KRIs each — a normal onboarding.
    const sites = Array.from({ length: 3 }, () => makeSite(5, 2));
    expect(commit.safeParse(baseBody(sites)).success).toBe(true);
  });

  it('rejects more than 20 sites', () => {
    const sites = Array.from({ length: 21 }, () => makeSite(0, 0));
    const result = commit.safeParse(baseBody(sites));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message.includes('20 sites'))).toBe(true);
    }
  });

  it('rejects more than 100 total risks across all sites', () => {
    // 10 sites x 11 risks = 110 total risks > 100, even though each site alone is modest.
    const sites = Array.from({ length: 10 }, () => makeSite(11, 0));
    const result = commit.safeParse(baseBody(sites));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message.includes('100 risks'))).toBe(true);
    }
  });

  it('rejects more than 200 total KRIs across all risks', () => {
    // 5 sites x 5 risks x 9 KRIs = 225 total KRIs > 200 (risks = 25, under the risk cap).
    const sites = Array.from({ length: 5 }, () => makeSite(5, 9));
    const result = commit.safeParse(baseBody(sites));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message.includes('200 KRIs'))).toBe(true);
    }
  });
});
