import { z } from 'zod';

// Stage 1: only a company name is required to kick off the grounded lookup.
const identify = z.object({
  company_name: z.string('Company name is required.').min(1).max(255),
});

// A site as confirmed on the Stage 2 screen and sent into Stage 3 generation.
// Mirrors aexa-ai's /risk_analysis request fields (all optional except a
// name), since these get forwarded per-site to produce starter risks.
const generate_site = z.object({
  site_name: z.string('Site name is required.').min(1).max(255),
  site_location: z.string().max(255).nullish(),
  site_legal_entity: z.string().max(255).nullish(),
  site_primary_activity: z.string().max(2000).nullish(),
  site_country: z.string().max(255).nullish(),
  site_revenue: z.string().max(255).nullish(),
  site_employees: z.string().max(255).nullish(),
  site_type: z.string().max(255).nullish(),
  source_info: z.string().max(2000).nullish(),
});

// Stage 3: the confirmed profile fans out to /risk_analysis per site plus
// /kri-baseline. Nothing is persisted.
const generate = z.object({
  sector: z.string().max(255).nullish(),
  country: z.string().max(255).nullish(),
  sites: z.array(generate_site).min(1, 'At least one site is required.'),
});

// --- Commit (Stage 4) --------------------------------------------------------
// The user's edited/selected subset of the Stage 3 draft. KRIs are nested
// under their risk so each Kri's risk_id is unambiguous, and risks are nested
// under their site so each Risk's site_id is unambiguous — the whole tree is
// created in one $transaction.

const commit_kri = z.object({
  name: z.string('KRI name is required.').min(1).max(255),
  unit: z.string().max(255).default(''),
  current_value: z.coerce.number().default(0),
  alert_threshold: z.coerce.number().default(0),
  target_value: z.coerce.number().default(0),
  frequency: z.string().max(255).nullish(),
});

const commit_risk = z.object({
  name: z.string('Risk name is required.').min(1).max(500),
  description: z.string().max(5000).nullish(),
  category: z.string('Risk category is required.').min(1).max(255),
  inherent_score: z.coerce.number().int().nullish(),
  residual_score: z.coerce.number().int().nullish(),
  // Probability is an integer percentage (0-100). Range-checked here as a
  // safety net so a malformed/out-of-scale value (e.g. a 0-1 fraction that
  // slipped through unmultiplied, or a runaway 6000) can't be persisted even
  // if it bypasses the AI-response normalization in the service layer.
  probability: z.coerce
    .number()
    .int()
    .min(0, 'Probability must be between 0 and 100.')
    .max(100, 'Probability must be between 0 and 100.')
    .nullish(),
  velocity: z.string().max(255).nullish(),
  trend: z.string().max(255).nullish(),
  status: z.string().max(255).default('open'),
  source_info: z.string().max(2000).nullish(),
  financial_impact_min: z.coerce.number().int().nullish(),
  financial_impact_max: z.coerce.number().int().nullish(),
  kris: z.array(commit_kri).default([]),
});

const commit_site = z.object({
  name: z.string('Site name is required.').min(1).max(255),
  location: z.string().max(255).nullish(),
  country: z.string().max(255).nullish(),
  activity: z.string().max(2000).nullish(),
  revenue: z.coerce.number().int().default(0),
  employees_count: z.coerce.number().int().default(0),
  site_type: z.string().max(255).default('other'),
  source_info: z.string().max(2000).nullish(),
  risks: z.array(commit_risk).default([]),
});

// Upper bounds on the committed tree. Everything is created as one awaited
// insert per row inside a single interactive $transaction, so an unbounded
// payload (an unusually large AI draft, or a malformed/malicious
// admin-authenticated request) could exceed the transaction timeout and roll
// the whole commit back with an opaque P2028. These caps are generous versus
// any realistic onboarding but keep the transaction's total insert count
// bounded. Kept as total counts (not per-parent) so the bound holds no matter
// how the rows are distributed across sites/risks.
const MAX_SITES = 20;
const MAX_RISKS = 100;
const MAX_KRIS = 200;

const commit = z
  .object({
    organizationName: z.string('Organization name is required.').min(1).max(255),
    email: z.string('Email is required.').email('Must be a valid email address.').max(255),
    password: z.string('Password is required.').min(8, 'Password must be at least 8 characters.'),
    sector: z.string().max(255).nullish(),
    country: z.string().max(255).nullish(),
    sites: z
      .array(commit_site)
      .min(1, 'At least one site is required.')
      .max(MAX_SITES, `A maximum of ${MAX_SITES} sites can be committed at once.`),
  })
  .superRefine((value, ctx) => {
    let totalRisks = 0;
    let totalKris = 0;
    for (const site of value.sites) {
      totalRisks += site.risks.length;
      for (const risk of site.risks) {
        totalKris += risk.kris.length;
      }
    }
    if (totalRisks > MAX_RISKS) {
      ctx.addIssue({
        code: 'custom',
        path: ['sites'],
        message: `A maximum of ${MAX_RISKS} risks can be committed at once (received ${totalRisks}).`,
      });
    }
    if (totalKris > MAX_KRIS) {
      ctx.addIssue({
        code: 'custom',
        path: ['sites'],
        message: `A maximum of ${MAX_KRIS} KRIs can be committed at once (received ${totalKris}).`,
      });
    }
  });

export const onboarding_validations = {
  identify,
  generate,
  commit,
};

export type OnboardingCommitInput = z.infer<typeof commit>;
