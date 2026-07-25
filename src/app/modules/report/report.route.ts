import { Router } from 'express';
import auth from '../../middlewares/auth.js';
import RequestValidator from '../../middlewares/request_validator.js';
import { reportGenerateLimiter } from '../../middlewares/rate_limiters.js';
import { routeTimeout } from '../../middlewares/route_timeout.js';
import { report_controller } from './report.controller.js';
import { report_validations } from './report.validation.js';
import { REPORT_ROUTE_TIMEOUT_MS } from './report.service.js';

const router = Router();

router.post(
  '/generate',
  // Order matters: auth() first so req.user is populated for the accountId-keyed
  // limiter; the limiter before the (expensive) route timeout + pipeline so a
  // rate-limited caller never launches Chromium; the route timeout wraps the
  // synchronous generate pipeline so a hung request fails deterministically at
  // REPORT_ROUTE_TIMEOUT_MS (#220) rather than relying on an upstream proxy's
  // default.
  auth('ORGANIZATION'),
  reportGenerateLimiter,
  routeTimeout(REPORT_ROUTE_TIMEOUT_MS),
  RequestValidator(report_validations.generate_report),
  report_controller.generate_report,
);
router.get('/', auth('ORGANIZATION'), report_controller.get_all_report);
router.get('/:id', auth('ORGANIZATION'), report_controller.get_single_report);
router.get('/:id/download', auth('ORGANIZATION'), report_controller.download_report);
router.patch('/:id/publish', auth('ORGANIZATION'), report_controller.publish_report);

export default router;
