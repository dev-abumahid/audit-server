import { Router } from 'express';
import verify_ai_internal_secret from '../../middlewares/verify_ai_internal_secret.js';
import RequestValidator from '../../middlewares/request_validator.js';
import { knowledge_base_controller } from './knowledge_base.controller.js';
import { knowledge_base_validations } from './knowledge_base.validation.js';

const router = Router();

// Called by aexa-ai, not an end user — see #96.
router.post(
  '/upload-pdf',
  verify_ai_internal_secret,
  RequestValidator(knowledge_base_validations.upload_pdf_webhook),
  knowledge_base_controller.acknowledge_upload_pdf_webhook,
);

export default router;
