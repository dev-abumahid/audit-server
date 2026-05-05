import { z } from 'zod';

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
});
const update_risk = create_risk.partial();

export const risk_validations = {
  create_risk,
  update_risk,
};
