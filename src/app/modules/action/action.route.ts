import { Router } from 'express';
import auth from '../../middlewares/auth.js';
import RequestValidator from '../../middlewares/request_validator.js';
import { action_controller } from './action.controller.js';
import { action_validations } from './action.validation.js';

const router = Router();

router.get('/', auth('ORGANIZATION'), action_controller.get_all_action);
router.post(
  '/',
  auth('ORGANIZATION'),
  RequestValidator(action_validations.create_action),
  action_controller.create_action,
);
router.get('/:id', auth('ORGANIZATION'), action_controller.get_single_action);
router.patch(
  '/:id',
  auth('ORGANIZATION'),
  RequestValidator(action_validations.update_action),
  action_controller.update_action,
);
router.delete('/:id', auth('ORGANIZATION'), action_controller.delete_action);

export default router;
