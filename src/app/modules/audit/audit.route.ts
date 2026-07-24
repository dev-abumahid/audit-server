import { Router } from 'express';
import auth from '../../middlewares/auth.js';
import RequestValidator from '../../middlewares/request_validator.js';
import uploader from '../../middlewares/uploader.js';
import { audit_controller } from './audit.controller.js';
import { audit_validations } from './audit.validation.js';

const router = Router();

router.get('/', auth('ORGANIZATION'), audit_controller.get_all_audit);
router.post(
  '/',
  auth('ORGANIZATION'),
  RequestValidator(audit_validations.create_audit),
  audit_controller.create_audit,
);
// Static segment (`/attachment`) declared before the dynamic `/:id` route so
// it's never captured as an id. The frontend uploads the report file here to
// get a URL, then PATCHes it onto the engagement's report_url — mirrors the
// compliance module's /attachment upload flow.
router.post(
  '/attachment',
  auth('ORGANIZATION'),
  uploader.single('file'),
  audit_controller.upload_audit_report,
);
router.get('/:id', auth('ORGANIZATION'), audit_controller.get_single_audit);
router.patch(
  '/:id',
  auth('ORGANIZATION'),
  RequestValidator(audit_validations.update_audit),
  audit_controller.update_audit,
);
router.delete('/:id', auth('ORGANIZATION'), audit_controller.delete_audit);

export default router;
