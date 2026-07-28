import { Router } from 'express';
import auth from '../../middlewares/auth.js';
import { intelligenceLimiter } from '../../middlewares/rate_limiters.js';
import RequestValidator from '../../middlewares/request_validator.js';
import { routeTimeout } from '../../middlewares/route_timeout.js';
import { intelligence_controller } from './intelligence.controller.js';
import { intelligence_validations } from './intelligence.validation.js';
import { SCRAPE_ROUTE_TIMEOUT_MS } from './intelligence.service.js';

const router = Router();

// aexa-frontend#141 stage 2: no role restriction on scrape/analyze/view --
// any org member can trigger a scrape, run analysis/prediction, or read the
// persisted history, same as this codebase's other read-mostly org-scoped
// modules. create-risk is the one exception (auth('ORGANIZATION') here plus
// assertCanWriteOrgResource inside the service, see intelligence.service.ts)
// since it creates a real Risk row -- same write gate POST /risk already
// enforces for the identical side effect.
//
// #298: none of these 6 endpoints had a rate limiter, unlike every other
// comparably expensive endpoint in the app (onboardingLimiter,
// reportGenerateLimiter) -- see intelligenceLimiter's own comment in
// rate_limiters.ts for the sizing rationale. auth() first so req.user is
// populated for the accountId-keyed limiter, same ordering convention as
// report.route.ts. /scrape additionally gets a routeTimeout (its fan-out --
// 55 concurrent RSS fetches then a serialized create pass -- is the largest
// in this module, same "make the client's timeout deterministic" reasoning
// as report.route.ts's #220 fix); the other 5 endpoints each make a single
// LLM_CALL_TIMEOUT_MS-bounded (45s) call and don't independently risk
// running past a typical proxy default the way /scrape's larger fan-out
// could, so they're left to that existing per-call timeout rather than
// adding a second, redundant one.
router.post(
  '/scrape',
  auth('ORGANIZATION'),
  intelligenceLimiter,
  routeTimeout(SCRAPE_ROUTE_TIMEOUT_MS),
  intelligence_controller.scrape_sources,
);
router.post(
  '/analyze',
  auth('ORGANIZATION'),
  intelligenceLimiter,
  RequestValidator(intelligence_validations.analyze_items),
  intelligence_controller.analyze_items,
);
router.post('/predict', auth('ORGANIZATION'), intelligenceLimiter, intelligence_controller.predict);
router.post(
  '/mitigations',
  auth('ORGANIZATION'),
  intelligenceLimiter,
  intelligence_controller.generate_mitigations,
);
router.post(
  '/rcsa',
  auth('ORGANIZATION'),
  intelligenceLimiter,
  intelligence_controller.generate_rcsa,
);
router.post(
  '/resilience-scan',
  auth('ORGANIZATION'),
  intelligenceLimiter,
  intelligence_controller.resilience_scan,
);

router.get('/items', auth('ORGANIZATION'), intelligence_controller.get_all_items);
router.get('/runs', auth('ORGANIZATION'), intelligence_controller.get_all_runs);

router.post(
  '/items/:id/create-risk',
  auth('ORGANIZATION'),
  RequestValidator(intelligence_validations.create_risk_from_item),
  intelligence_controller.create_risk_from_item,
);

export default router;
