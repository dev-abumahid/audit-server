import { Router } from 'express';
import verify_ai_internal_secret from '../../middlewares/verify_ai_internal_secret.js';
import RequestValidator from '../../middlewares/request_validator.js';
import { notification_controller } from './notification.controller.js';
import { notification_validations } from './notification.validation.js';

const router = Router();

// Called by aexa-ai, not an end user — see #96.
router.post(
  '/',
  verify_ai_internal_secret,
  RequestValidator(notification_validations.create_notification_from_webhook),
  notification_controller.create_notification_from_webhook,
);

export default router;
