import { Router } from 'express';
import auth from '../../middlewares/auth.js';
import RequestValidator from '../../middlewares/request_validator.js';
import { alert_controller } from './alert.controller.js';
import { alert_validations } from './alert.validation.js';

const router = Router();

router.get('/', auth('ORGANIZATION'), alert_controller.get_all_alert);
router.post(
  '/',
  auth('ORGANIZATION'),
  RequestValidator(alert_validations.create_alert),
  alert_controller.create_alert,
);
router.get('/:id', auth('ORGANIZATION'), alert_controller.get_single_alert);
router.patch(
  '/:id/read',
  auth('ORGANIZATION'),
  RequestValidator(alert_validations.mark_read),
  alert_controller.mark_alert_read,
);
router.delete('/:id', auth('ORGANIZATION'), alert_controller.delete_alert);

export default router;
