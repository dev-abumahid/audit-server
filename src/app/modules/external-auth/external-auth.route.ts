import { Router } from 'express';
import {
  externalCodeRequestLimiter,
  externalCodeVerifyLimiter,
} from '../../middlewares/rate_limiters.js';
import RequestValidator from '../../middlewares/request_validator.js';
import { external_auth_controller } from './external-auth.controller.js';
import { external_auth_validations } from './external-auth.validation.js';

const router = Router();

// Both public — an external member has no Account/JWT yet at this point, so
// there's no auth() middleware to gate these with (mirrors account.route.ts's
// login/verify-otp endpoints, which are equally public for the same reason).
router.post(
  '/request-code',
  externalCodeRequestLimiter,
  RequestValidator(external_auth_validations.request_code),
  external_auth_controller.request_code,
);

router.post(
  '/verify-code',
  externalCodeVerifyLimiter,
  RequestValidator(external_auth_validations.verify_code),
  external_auth_controller.verify_code,
);

export default router;
