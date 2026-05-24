
import { z } from "zod";

const result = z.object({
  question: z.string(),
  observation: z.string(),
  standard: z.string(),
  recommendation: z.string(),
})

const create_recommendation = z.object({
  results: z.array(result),
  summary: z.string(),
  orgAccountId: z.string(),
  inspectionId: z.string(),
  riskId: z.string().optional(),
  siteId:z.string().optional()
});
const update_recommendation = create_recommendation.partial()

export const recommendation_validations = {
  create_recommendation,
  update_recommendation,
};
