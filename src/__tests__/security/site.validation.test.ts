import { describe, expect, it } from 'vitest';
import { site_validations } from '../../app/modules/site/site.validation.js';

const BASE = {
  name: 'Cebi Luxembourg HQ',
  site_type: 'manufacturing',
  revenue: 1_000_000,
  employees_count: 100,
};

// 2026-08-19 audit: revenue/employees_count were unbounded z.number().int(),
// so a negative or absurd value passed validation and fed straight into the
// EBITDA-at-risk benchmark margin calculation (ebitda_risk.ts) and general
// risk-severity scaling for the whole site.
describe('site_validations.create_site — revenue/employees_count bounds', () => {
  it.each([
    ['revenue', 5_000_000],
    ['employees_count', 250],
  ])('accepts an in-range %s', (field, value) => {
    const result = site_validations.create_site.safeParse({ ...BASE, [field]: value });
    expect(result.success).toBe(true);
  });

  it.each([
    ['revenue', -1],
    ['employees_count', -1],
  ])('rejects a negative %s', (field, value) => {
    const result = site_validations.create_site.safeParse({ ...BASE, [field]: value });
    expect(result.success).toBe(false);
  });

  it('rejects an absurdly large revenue', () => {
    const result = site_validations.create_site.safeParse({ ...BASE, revenue: 1_000_000_001 });
    expect(result.success).toBe(false);
  });

  it('rejects an absurdly large employees_count', () => {
    const result = site_validations.create_site.safeParse({
      ...BASE,
      employees_count: 1_000_001,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a negative revenue on a partial update too', () => {
    const result = site_validations.update_site.safeParse({ revenue: -1 });
    expect(result.success).toBe(false);
  });
});

// design-docs/site-ai-risk-register-generation.md §3/§7: description is
// free text fed into the AI risk-generation prompt, capped at 2,000 chars
// before it reaches any prompt.
describe('site_validations.create_site — description', () => {
  it('accepts a missing description', () => {
    const result = site_validations.create_site.safeParse(BASE);
    expect(result.success).toBe(true);
  });

  it('accepts a description at the 2,000-char cap', () => {
    const result = site_validations.create_site.safeParse({
      ...BASE,
      description: 'x'.repeat(2000),
    });
    expect(result.success).toBe(true);
  });

  it('rejects a description over the 2,000-char cap', () => {
    const result = site_validations.create_site.safeParse({
      ...BASE,
      description: 'x'.repeat(2001),
    });
    expect(result.success).toBe(false);
  });

  it('rejects an over-cap description on a partial update too', () => {
    const result = site_validations.update_site.safeParse({
      description: 'x'.repeat(2001),
    });
    expect(result.success).toBe(false);
  });
});

// External-data-anchoring plan, Phase 1 (Cyber/IT category). Optional
// per-site override of the org's OrganizationProfile.organizationWebsite --
// review finding: without this being client-settable at all, the site-level
// half of aiRiskAnalysis.service.ts's resolveSiteWebsiteDomain fallback
// could never actually fire in practice.
describe('site_validations.create_site — website_domain', () => {
  it('accepts a missing website_domain', () => {
    const result = site_validations.create_site.safeParse(BASE);
    expect(result.success).toBe(true);
  });

  it('accepts a bare domain', () => {
    const result = site_validations.create_site.safeParse({
      ...BASE,
      website_domain: 'plant.acme.example',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a full URL (parsed permissively on the aexa-ai side, not restricted here)', () => {
    const result = site_validations.create_site.safeParse({
      ...BASE,
      website_domain: 'https://www.acme.example',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an over-cap website_domain', () => {
    const result = site_validations.create_site.safeParse({
      ...BASE,
      website_domain: 'x'.repeat(256),
    });
    expect(result.success).toBe(false);
  });

  it('accepts website_domain on a partial update', () => {
    const result = site_validations.update_site.safeParse({
      website_domain: 'plant.acme.example',
    });
    expect(result.success).toBe(true);
  });
});
