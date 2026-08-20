import { z } from 'zod';

const start_ai_risk_analysis = z.object({
  siteId: z.string().min(1, 'siteId is required'),
});

export const ai_risk_analysis_validations = {
  start_ai_risk_analysis,
};
