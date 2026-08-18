import { z } from 'zod';
import { ai_validations } from '../ai/ai.validation.js';

// aexa-frontend#922: dismiss / mark-imported both take the same shape --
// the site the suggestion belongs to, plus the full suggestion object as
// returned by POST /ai/analyze-site-risks. Reusing ai_validations.risk_suggestion
// (rather than duplicating its field list here) keeps this in lockstep with
// whatever aexa-ai's /risk_analysis actually returns.
const suggestion_action_payload = z.object({
  siteId: z.string('Site Id is required!'),
  suggestion: ai_validations.risk_suggestion,
});

export const ai_suggestion_validations = {
  suggestion_action_payload,
};
