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
  inherent_score: z.number().int().optional(),
  residual_score: z.number().int().optional(),
  pagerank_score: z.number().int().optional(),
  financial_impact_min: z.number().int().optional(),
  financial_impact_max: z.number().int().optional(),
  probability: z.number().int().optional(),
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
});
const update_risk = create_risk.partial();

export const risk_validations = {
  create_risk,
  update_risk,
};
