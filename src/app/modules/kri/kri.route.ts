import { Router } from 'express';
import auth from '../../middlewares/auth.js';
import RequestValidator from '../../middlewares/request_validator.js';
import { kri_controller } from './kri.controller.js';
import { kri_validations } from './kri.validation.js';

const router = Router();

router.get('/', auth('ORGANIZATION'), kri_controller.get_all_kri);
router.post(
  '/',
  auth('ORGANIZATION'),
  RequestValidator(kri_validations.create_kri),
  kri_controller.create_kri,
);
router.get('/:id', auth('ORGANIZATION'), kri_controller.get_single_kri);
router.patch(
  '/:id',
  auth('ORGANIZATION'),
  RequestValidator(kri_validations.update_kri),
  kri_controller.update_kri,
);
router.post(
  '/:id/value',
  auth('ORGANIZATION'),
  RequestValidator(kri_validations.submit_value),
  kri_controller.submit_kri_value,
);
router.get('/:id/readings', auth('ORGANIZATION'), kri_controller.get_kri_readings);
router.delete('/:id', auth('ORGANIZATION'), kri_controller.delete_kri);

export default router;
