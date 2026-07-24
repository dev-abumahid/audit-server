import { Router } from 'express';
import auth from '../../middlewares/auth.js';
import { onboardingLimiter } from '../../middlewares/rate_limiters.js';
import RequestValidator from '../../middlewares/request_validator.js';
import { onboarding_controller } from './onboarding.controller.js';
import { onboarding_validations } from './onboarding.validation.js';

const router = Router();

// All three stages are admin-only (#96 decision 1: admin-triggered tenant
// creation, not self-serve signup) and rate-limited via onboardingLimiter
// since identify/generate fan out to expensive Tavily+LLM calls. None of
// identify/generate persist anything — only commit writes, and it does so in
// a single all-or-nothing transaction.
router.post(
  '/identify',
  auth('ADMIN'),
  onboardingLimiter,
  RequestValidator(onboarding_validations.identify),
  onboarding_controller.identify,
);

router.post(
  '/generate',
  auth('ADMIN'),
  onboardingLimiter,
  RequestValidator(onboarding_validations.generate),
  onboarding_controller.generate,
);

router.post(
  '/commit',
  auth('ADMIN'),
  onboardingLimiter,
  RequestValidator(onboarding_validations.commit),
  onboarding_controller.commit,
);

export default router;
