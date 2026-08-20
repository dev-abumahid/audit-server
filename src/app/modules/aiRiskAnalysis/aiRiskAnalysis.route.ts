import { Router } from 'express';
import auth from '../../middlewares/auth.js';
import RequestValidator from '../../middlewares/request_validator.js';
import { ai_risk_analysis_controller } from './aiRiskAnalysis.controller.js';
import { ai_risk_analysis_validations } from './aiRiskAnalysis.validation.js';

const router = Router();

// design-docs/site-ai-risk-register-generation.md §2/§6: kicks off the
// two-phase generation (Phase 1 triage + Phase 2 parallel category
// generation) for a site and returns the created AiRiskAnalysisRun
// immediately -- the actual generation work continues after this
// responds, polled via GET /:id below (same RTK Query polling shape
// KnowledgeBaseUploadingForm.tsx/ReportsPage.tsx already use).
router.post(
  '/',
  auth('ORGANIZATION'),
  RequestValidator(ai_risk_analysis_validations.start_ai_risk_analysis),
  ai_risk_analysis_controller.start_ai_risk_analysis,
);

router.get('/:id', auth('ORGANIZATION'), ai_risk_analysis_controller.get_ai_risk_analysis_run);

// design-docs §7: "a scoped retry limited to just those categories,
// updating the same run row." No request body -- the run id in the URL is
// the only input, same "action verb, no body" shape as report.route.ts's
// PATCH /:id/publish.
router.post('/:id/retry', auth('ORGANIZATION'), ai_risk_analysis_controller.retry_ai_risk_analysis);

export default router;
