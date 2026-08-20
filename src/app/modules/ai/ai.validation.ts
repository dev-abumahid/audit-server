import { z } from 'zod';

const generate_with_prompt = z.object({
  prompt: z.string(),
});

const generate_with_risk = z.object({
  riskId: z.string(),
});

const generate_recommendation_payload = z.object({
  inspectionId: z.string('Inspection Id is required!'),
});

export const ai_validations = {
  generate_with_prompt,
  generate_with_risk,
  generate_recommendation_payload,
};
