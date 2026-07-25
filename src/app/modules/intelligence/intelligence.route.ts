import { Router } from 'express';
import auth from '../../middlewares/auth.js';
import RequestValidator from '../../middlewares/request_validator.js';
import { intelligence_controller } from './intelligence.controller.js';
import { intelligence_validations } from './intelligence.validation.js';

const router = Router();

// aexa-frontend#141 stage 2: no role restriction on scrape/analyze/view --
// any org member can trigger a scrape, run analysis/prediction, or read the
// persisted history, same as this codebase's other read-mostly org-scoped
// modules. create-risk is the one exception (auth('ORGANIZATION') here plus
// assertCanWriteOrgResource inside the service, see intelligence.service.ts)
// since it creates a real Risk row -- same write gate POST /risk already
// enforces for the identical side effect.
router.post('/scrape', auth('ORGANIZATION'), intelligence_controller.scrape_sources);
router.post(
  '/analyze',
  auth('ORGANIZATION'),
  RequestValidator(intelligence_validations.analyze_items),
  intelligence_controller.analyze_items,
);
router.post('/predict', auth('ORGANIZATION'), intelligence_controller.predict);
router.post('/mitigations', auth('ORGANIZATION'), intelligence_controller.generate_mitigations);
router.post('/rcsa', auth('ORGANIZATION'), intelligence_controller.generate_rcsa);
router.post('/resilience-scan', auth('ORGANIZATION'), intelligence_controller.resilience_scan);

router.get('/items', auth('ORGANIZATION'), intelligence_controller.get_all_items);
router.get('/runs', auth('ORGANIZATION'), intelligence_controller.get_all_runs);

router.post(
  '/items/:id/create-risk',
  auth('ORGANIZATION'),
  RequestValidator(intelligence_validations.create_risk_from_item),
  intelligence_controller.create_risk_from_item,
);

export default router;
