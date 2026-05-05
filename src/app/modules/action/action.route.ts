import { Router } from 'express';
import RequestValidator from '../../middlewares/request_validator';
import { action_controller } from './action.controller';
import { action_validations } from './action.validation';

const router = Router();

router.get('/', action_controller.get_all_action);
router.post(
  '/',
  RequestValidator(action_validations.create_action),
  action_controller.create_action,
);
router.get('/:id', action_controller.get_single_action);
router.patch(
  '/:id',
  RequestValidator(action_validations.update_action),
  action_controller.update_action,
);
router.delete('/:id', action_controller.delete_action);

export default router;
