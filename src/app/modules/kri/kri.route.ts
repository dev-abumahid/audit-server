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
// #97: records that `line` independently reviewed this KRI (distinct from
// PATCH /:id's line_of_defense, which reassigns OWNERSHIP -- see
// line_of_defense_review.ts's file comment). Permission is enforced inside
// the service (assertCanRecordLineReview), same "role-gated in the service,
// not the route" convention as risk.route.ts's identical endpoint. Fixed
// sub-path, registered before /:id, same reasoning as every other fixed
// sub-path in this codebase's route files.
router.post(
  '/:id/line-reviews',
  auth('ORGANIZATION'),
  RequestValidator(kri_validations.record_line_review),
  kri_controller.record_line_review,
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
