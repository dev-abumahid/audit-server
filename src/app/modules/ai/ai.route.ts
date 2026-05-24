import { Router } from 'express';
import auth from '../../middlewares/auth.js';
import RequestValidator from '../../middlewares/request_validator.js';
import uploader from '../../middlewares/uploader.js';
import { ai_controller } from './ai.controller.js';
import { ai_validations } from './ai.validation.js';

const router = Router();

router.post(
  '/generate-with-prompt',
  auth('ORGANIZATION'),
  RequestValidator(ai_validations.generate_with_prompt),
  ai_controller.generate_template_with_prompt,
);
router.post(
  '/generate-with-pdf',
  auth('ORGANIZATION'),
  uploader.single('file'),
  ai_controller.generate_template_with_pdf,
);
router.post(
  '/generate-with-risk',
  auth('ORGANIZATION'),
  RequestValidator(ai_validations.generate_with_risk),
  ai_controller.generate_template_with_risk,
);
router.post(
  '/generate-recommendation',
  auth('ORGANIZATION'),
  RequestValidator(ai_validations.generate_recommendation_payload),
  ai_controller.generate_recommendation_with_inspection,
);

export default router;
