import { Router } from 'express';
import auth from '../../middlewares/auth.js';
import RequestValidator from '../../middlewares/request_validator.js';
import { report_controller } from './report.controller.js';
import { report_validations } from './report.validation.js';

const router = Router();

router.post(
  '/generate',
  auth('ORGANIZATION'),
  RequestValidator(report_validations.generate_report),
  report_controller.generate_report,
);
router.get('/', auth('ORGANIZATION'), report_controller.get_all_report);
router.get('/:id', auth('ORGANIZATION'), report_controller.get_single_report);
router.get('/:id/download', auth('ORGANIZATION'), report_controller.download_report);
router.patch('/:id/publish', auth('ORGANIZATION'), report_controller.publish_report);

export default router;
