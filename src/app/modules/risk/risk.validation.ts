import { z } from 'zod';

// #97: Three Lines of Defense classification. Not required on create — Risk
// has a sensible schema-level default (FIRST, see risk.prisma), unlike
// Action which requires this explicitly. Reassignment is further gated in
// risk.service.ts (only ADMIN/LEAD_AUDITOR via assertCanWriteOrgResource,
// which update_risk_into_db already applies to the whole payload).
const LINE_OF_DEFENSE_ENUM = z.enum(['FIRST', 'SECOND', 'THIRD']);

const create_risk = z.object({
  name: z.string().min(1, 'Name is required'),
  description: z.string().optional(),
  category: z.string().min(1, 'Category is required'),
  inherent_score: z.number().int().min(0).max(100).optional(),
  pagerank_score: z.number().int().optional(),
  financial_impact_min: z.number().int().optional(),
  financial_impact_max: z.number().int().optional(),
  probability: z.number().int().optional(),
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

  control_design_eff: z.number().int().optional(),
  control_operating_eff: z.number().int().optional(),
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
});
const update_risk = create_risk.partial();

export const risk_validations = {
  create_risk,
  update_risk,
};
