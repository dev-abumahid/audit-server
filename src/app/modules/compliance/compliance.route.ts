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
// Static segments (`/scorecard`, `/attachment`) declared before the dynamic
// `/:id` route so they're never captured as an id.
router.get('/scorecard', auth('ORGANIZATION'), compliance_controller.get_compliance_scorecard);
router.post(
  '/attachment',
  auth('ORGANIZATION'),
  uploader.single('file'),
  enforceUploadSizeLimit,
  compliance_controller.upload_compliance_attachment,
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

export default router;
