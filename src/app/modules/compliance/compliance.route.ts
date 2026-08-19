import { Router } from 'express';
import auth from '../../middlewares/auth.js';
import RequestValidator from '../../middlewares/request_validator.js';
import uploader, { enforceUploadSizeLimit } from '../../middlewares/uploader.js';
import { compliance_controller } from './compliance.controller.js';
import { compliance_validations } from './compliance.validation.js';

const router = Router();

router.get('/', auth('ORGANIZATION'), compliance_controller.get_all_compliance);
router.post(
  '/',
  auth('ORGANIZATION'),
  RequestValidator(compliance_validations.create_compliance),
  compliance_controller.create_compliance,
);
// Static segments (`/scorecard`, `/attachment`, `/suggest-regulatory-sources`)
// declared before the dynamic `/:id` route so they're never captured as an id.
router.get('/scorecard', auth('ORGANIZATION'), compliance_controller.get_compliance_scorecard);
router.post(
  '/attachment',
  auth('ORGANIZATION'),
  uploader.single('file'),
  enforceUploadSizeLimit,
  compliance_controller.upload_compliance_attachment,
);
// aexa-frontend#939: AI-suggests regulatory sources likely applicable to a
// site that aren't already tracked, for the CEO's "how do I know coverage
// is complete" question. Same review-then-import shape as POST
// /risk/suggest-fields — no obligation is created here.
router.post(
  '/suggest-regulatory-sources',
  auth('ORGANIZATION'),
  RequestValidator(compliance_validations.suggest_regulatory_sources),
  compliance_controller.suggest_regulatory_sources,
);
router.get('/:id', auth('ORGANIZATION'), compliance_controller.get_single_compliance);
router.patch(
  '/:id',
  auth('ORGANIZATION'),
  RequestValidator(compliance_validations.update_compliance),
  compliance_controller.update_compliance,
);
router.delete('/:id', auth('ORGANIZATION'), compliance_controller.delete_compliance);
router.post(
  '/:id/attest',
  auth('ORGANIZATION'),
  RequestValidator(compliance_validations.attest_compliance),
  compliance_controller.attest_compliance,
);
router.get(
  '/:id/attestations',
  auth('ORGANIZATION'),
  compliance_controller.get_compliance_attestations,
);
router.get(
  '/:id/edit-history',
  auth('ORGANIZATION'),
  compliance_controller.get_compliance_edit_history,
);
// aexa-server#346: obligation <-> risk linking. POST create-risk promotes a
// brand-new Risk (same shape as POST /intelligence/items/:id/create-risk);
// POST/DELETE link-risk attach/detach an existing one.
router.post(
  '/:id/create-risk',
  auth('ORGANIZATION'),
  RequestValidator(compliance_validations.create_risk_from_obligation),
  compliance_controller.create_risk_from_obligation,
);
router.post(
  '/:id/link-risk',
  auth('ORGANIZATION'),
  RequestValidator(compliance_validations.link_risk_to_obligation),
  compliance_controller.link_risk_to_obligation,
);
router.delete(
  '/:id/link-risk',
  auth('ORGANIZATION'),
  compliance_controller.unlink_risk_from_obligation,
);

export default router;
