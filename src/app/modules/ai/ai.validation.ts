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

// Deliberately no system_prompt field here: aexa-ai's /risk_analysis accepts
// an optional user-controlled system_prompt that fully replaces the LLM's
// system persona (a known open issue on the aexa-ai side, #13). Not exposing
// it in this schema means it can never be forwarded, regardless of what a
// client sends.
const analyze_site_risks = z.object({
  siteId: z.string('Site Id is required!'),
});

// Shape of a single suggestion inside aexa-ai's /risk_analysis response
// (app/schemas/risk_analysis_schema.py RiskAnalysisResponse). Field casing
// (Probability, Velocity, Trend, Responsable) is exactly what the LLM is
// prompted to produce on the aexa-ai side — kept as-is here rather than
// renamed, so this schema stays a faithful check of what aexa-ai actually
// sends, not a reshaped version of it.
const risk_suggestion = z.object({
  risk_id: z.string(),
  title: z.string(),
  description: z.string(),
  category: z.string(),
  site: z.string(),
  inherent_risk_score: z.string(),
  residual_risk_score: z.string(),
  Probability: z.number().min(0).max(1),
  minimum_Impact: z.string(),
  maximum_impact: z.string(),
  Velocity: z.string(),
  Trend: z.string(),
  Responsable: z.string(),
  score: z.number().int().min(0).max(20),
});

const risk_analysis_response = z.object({
  risks: z.array(risk_suggestion),
});

export const ai_validations = {
  generate_with_prompt,
  generate_with_risk,
  generate_recommendation_payload,
  analyze_site_risks,
  risk_analysis_response,
  risk_suggestion,
};
