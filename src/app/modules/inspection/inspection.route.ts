import { Router } from 'express';
import auth from '../../middlewares/auth.js';
import RequestValidator from '../../middlewares/request_validator.js';
import uploader, { enforceUploadSizeLimit } from '../../middlewares/uploader.js';
import { inspection_controller } from './inspection.controller.js';
import { inspection_validations } from './inspection.validation.js';

const router = Router();

router.get('/', auth('ORGANIZATION'), inspection_controller.get_all_inspection);
router.post(
  '/',
  auth('ORGANIZATION'),
  RequestValidator(inspection_validations.create_inspection),
  inspection_controller.create_inspection,
);
router.post(
  '/upload-file-aws',
  auth('ORGANIZATION', 'ADMIN', 'USER'),
  uploader.single('file'),
  enforceUploadSizeLimit,
  inspection_controller.upload_any_file_into_aws,
);
router.post(
  '/split-note-into-inspection/:inspectionId',
  auth('ORGANIZATION'),
  inspection_controller.split_note_into_inspection,
);
router.get('/:id', auth('ORGANIZATION'), inspection_controller.get_single_inspection);
router.patch(
  '/:id',
  auth('ORGANIZATION'),
  RequestValidator(inspection_validations.update_inspection),
  inspection_controller.update_inspection,
);
router.delete('/:id', auth('ORGANIZATION'), inspection_controller.delete_inspection);
router.put(
  '/:id',
  auth('ORGANIZATION'),
  RequestValidator(inspection_validations.update_question_answer),
  inspection_controller.update_inspection_question,
);

// Org-role assignment (issue #55 slice 3) — admin-only, enforced inside the
// service via resolveCallerOrgContext, same as the rest of this module.
router.get(
  '/:id/assignments',
  auth('ORGANIZATION'),
  inspection_controller.get_inspection_assignments,
);
router.post(
  '/:id/assignments',
  auth('ORGANIZATION'),
  RequestValidator(inspection_validations.assign_inspection_member),
  inspection_controller.assign_inspection_member,
);
router.delete(
  '/:id/assignments/:orgMemberId',
  auth('ORGANIZATION'),
  inspection_controller.unassign_inspection_member,
);

// aexa-frontend#270: self-scoped — any member can see their own inspection
// assignments (active and revoked), mirroring action.route.ts's
// `/assignments/mine`. Not nested under `/:id` since it's not about one
// inspection. Declared as a distinct two-segment path, so it can never
// collide with the single-segment `/:id` route above regardless of order.
router.get(
  '/assignments/mine',
  auth('ORGANIZATION'),
  inspection_controller.get_my_inspection_assignments,
);

export default router;
