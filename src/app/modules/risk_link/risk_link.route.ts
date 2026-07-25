import { Router } from 'express';
import auth from '../../middlewares/auth.js';
import RequestValidator from '../../middlewares/request_validator.js';
import { risk_link_controller } from './risk_link.controller.js';
import { risk_link_validations } from './risk_link.validation.js';

const router = Router();

router.get('/', auth('ORGANIZATION'), risk_link_controller.get_all_risk_links);
router.post(
  '/',
  auth('ORGANIZATION'),
  RequestValidator(risk_link_validations.create_risk_link),
  risk_link_controller.create_risk_link,
);
router.delete('/:id', auth('ORGANIZATION'), risk_link_controller.delete_risk_link);

export default router;
