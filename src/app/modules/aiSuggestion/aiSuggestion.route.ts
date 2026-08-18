import { Router } from 'express';
import auth from '../../middlewares/auth.js';
import RequestValidator from '../../middlewares/request_validator.js';
import { ai_suggestion_controller } from './aiSuggestion.controller.js';
import { ai_suggestion_validations } from './aiSuggestion.validation.js';

const router = Router();

// aexa-frontend#922: AI-suggested-risk lifecycle. Mounted at /ai/suggestions
// (this router is registered under the existing '/ai' prefix in routes.ts)
// so it reads as a sub-resource of the existing /ai/analyze-site-risks
// endpoint rather than a wholly separate top-level module, even though the
// implementation lives in its own aiSuggestion module folder for clarity.
router.post(
  '/dismiss',
  auth('ORGANIZATION'),
  RequestValidator(ai_suggestion_validations.suggestion_action_payload),
  ai_suggestion_controller.dismiss_suggestion,
);
router.post(
  '/mark-imported',
  auth('ORGANIZATION'),
  RequestValidator(ai_suggestion_validations.suggestion_action_payload),
  ai_suggestion_controller.mark_suggestion_imported,
);
router.get(
  '/site/:siteId',
  auth('ORGANIZATION'),
  ai_suggestion_controller.get_site_suggestion_states,
);

export default router;
