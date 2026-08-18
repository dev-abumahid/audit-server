import { z } from 'zod';

// #97: Three Lines of Defense classification. Not required on create — Risk
// has a sensible schema-level default (FIRST, see risk.prisma), unlike
// Action which requires this explicitly. Reassignment is gated in
// risk.service.ts: ADMIN/LEAD_AUDITOR via assertCanWriteOrgResource for the
// whole payload, plus (aexa-frontend#208) a stricter ADMIN-only check
// specifically when line_of_defense itself is being changed — a
// LEAD_AUDITOR (third line) must not get to reclassify a first/second-line
// entity's ownership, per the Three Lines Model's third-line-independence
// principle. GOVERNING_BODY (aexa-frontend#208) added as a 4th selectable
// value — see risk.prisma's LineOfDefense enum comment.
const LINE_OF_DEFENSE_ENUM = z.enum(['FIRST', 'SECOND', 'THIRD', 'GOVERNING_BODY']);

const create_risk = z.object({
  name: z.string().min(1, 'Name is required'),
  description: z.string().optional(),
  category: z.string().min(1, 'Category is required'),
  inherent_score: z.number().int().min(0).max(100).optional(),
  pagerank_score: z.number().int().optional(),
  financial_impact_min: z.number().int().optional(),
  financial_impact_max: z.number().int().optional(),
  probability: z.number().int().min(0).max(100).optional(),
  // aexa-server#241: real, independent impact axis for the risk matrix
  // (previously faked from inherent_score — see #202).
  impact: z.number().int().min(0).max(100).optional(),
  velocity: z.string().optional(),
  trend: z.string().optional(),
  status: z.string(),
  ai_generated: z.boolean().optional(),
  is_edited: z.boolean().optional(),
  site_id: z.string(),
  source_info: z.string().optional(),

  control_design_eff: z.number().int().min(0).max(100).optional(),
  control_operating_eff: z.number().int().min(0).max(100).optional(),
  line_of_defense: LINE_OF_DEFENSE_ENUM.optional(),

  // aexa-server#241: residual_score is derived by default (risk_scoring.ts).
  // These three are the client's opt-in to a manual override — never
  // persisted directly, consumed by risk.service.ts and stripped/replaced
  // with the resolved residual_* fields before the Prisma write.
  residual_override: z.boolean().optional(),
  residual_score: z.number().int().min(0).max(100).optional(),
  residual_override_reason: z.string().min(1).optional(),

  // aexa-server#247: same opt-in-override shape as residual_override above,
  // for inherent_score (derived from probability x impact when both are
  // known).
  inherent_override: z.boolean().optional(),
  inherent_override_reason: z.string().min(1).optional(),

  // aexa-server#347: same opt-in-override shape as residual/inherent above,
  // for the EBITDA-at-risk benchmark margin (see ebitda_risk.ts). The
  // override targets the 0-1 margin fraction, not the final at-risk
  // currency amount — see that file's header comment for why.
  ebitda_override: z.boolean().optional(),
  ebitda_override_margin: z.number().min(0).max(1).optional(),
  ebitda_override_reason: z.string().min(1).optional(),
});
const update_risk = create_risk.partial();

export const risk_validations = {
  create_risk,
  update_risk,
};
