
import { z } from "zod";

const generate_with_prompt = z.object({
  prompt: z.string(),
});

const generate_with_risk = z.object({
  riskId: z.string(),
});

export const ai_validations = {
  generate_with_prompt,
  generate_with_risk
};
