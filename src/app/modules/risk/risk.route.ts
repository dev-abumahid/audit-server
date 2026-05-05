import { Router } from 'express';
import auth from '../../middlewares/auth.js';
import RequestValidator from '../../middlewares/request_validator.js';
import { risk_controller } from './risk.controller.js';
import { risk_validations } from './risk.validation.js';

const router = Router();

router.get('/', auth('ORGANIZATION'), risk_controller.get_all_risk);
router.post(
  '/',
  auth('ORGANIZATION'),
  RequestValidator(risk_validations.create_risk),
  risk_controller.create_risk,
);
router.get('/:id', auth('ORGANIZATION'), risk_controller.get_single_risk);
router.patch(
  '/:id',
  auth('ORGANIZATION'),
  RequestValidator(risk_validations.update_risk),
  risk_controller.update_risk,
);
router.delete('/:id', auth('ORGANIZATION'), risk_controller.delete_risk);

export default router;
