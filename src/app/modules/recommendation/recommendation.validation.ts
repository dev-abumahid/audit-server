import { z } from 'zod';

const result = z.object({
  question: z.string(),
  observation: z.string(),
  standard: z.string(),
  recommendation: z.string(),
});

const create_recommendation = z.object({
  results: z.array(result),
  summary: z.string(),
  orgAccountId: z.string(),
  inspectionId: z.string(),
  riskId: z.string().optional(),
  siteId: z.string().optional(),
});
const update_recommendation_summary = z.object({
  summary: z.string().optional(),
});

const update_recommendation_question = z.object({
  observation: z.string().optional(),
  standard: z.string().optional(),
  recommendation: z.string().optional(),
});

export const recommendation_validations = {
  create_recommendation,
  update_recommendation_summary,
  update_recommendation_question,
};
