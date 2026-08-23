import { z } from 'zod';

const create_site = z.object({
  name: z.string(),
  location: z.string().optional(),
  country: z.string().optional(),
  activity: z.string().optional(),
  // design-docs/site-ai-risk-register-generation.md §3: free text fed into
  // the AI risk-generation prompt -- capped here at the same 2,000-char
  // bound §7 mandates before any prompt (aiRiskAnalysis.service.ts's
  // cap() enforces it again at the prompt boundary itself; this is
  // defense-in-depth at the API boundary, not the only place it's bounded).
  description: z.string().max(2000).optional(),
  // Unbounded before meant a negative revenue/headcount passed validation
  // and fed straight into the EBITDA-at-risk benchmark margin calculation
  // (ebitda_risk.ts) and general risk-severity scaling, silently poisoning
  // downstream financial-risk math for the whole site.
  revenue: z.number().int().min(0).max(1_000_000_000),
  employees_count: z.number().int().min(0).max(1_000_000),
  site_type: z.string(),
  lat: z.number().optional(),
  lng: z.number().optional(),
  // External-data-anchoring plan, Phase 1 (Cyber/IT category). Optional
  // override of the org's OrganizationProfile.organizationWebsite for this
  // specific site -- see aiRiskAnalysis.service.ts's
  // resolveSiteWebsiteDomain for the fallback resolution. Accepts either a
  // bare domain or a full URL; parsed permissively on the aexa-ai side, not
  // strictly validated here (review finding: without this field being
  // client-settable at all, the site-level half of that resolution could
  // never actually fire in practice).
  website_domain: z.string().max(255).optional(),
});
const update_site = create_site.partial();

export const site_validations = {
  create_site,
  update_site,
};
