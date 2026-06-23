import { Router } from 'express';
import auth from '../../middlewares/auth.js';
import RequestValidator from '../../middlewares/request_validator.js';
import uploader from '../../middlewares/uploader.js';
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
router.post(
  '/upload-file-aws',
  auth('ORGANIZATION', 'ADMIN', 'USER'),
  uploader.single('file'),
  inspection_controller.upload_any_file_into_aws,
);
router.post(
  '/split-note-into-inspection/:inspectionId',
  auth('ORGANIZATION'),
  inspection_controller.split_note_into_inspection,
);

export default router;
