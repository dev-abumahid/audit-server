import { Router } from 'express';
import auth from '../../middlewares/auth.js';
import RequestValidator from '../../middlewares/request_validator.js';
import uploader, { enforceUploadSizeLimit } from '../../middlewares/uploader.js';
import { note_controller } from './note.controller.js';
import { note_validations } from './note.validation.js';
import { AppError } from '../../utils/app_error.js';

const router = Router();

router.get('/', auth('ORGANIZATION'), note_controller.get_all_note);
router.post(
  '/save-raw-note',
  auth('ORGANIZATION'),
  RequestValidator(note_validations.create_note),
  note_controller.save_raw_note,
);
router.post(
  '/extract-note-from-file',
  auth('ORGANIZATION'),
  uploader.single('file'),
  enforceUploadSizeLimit,
  (req, res, next) => {
    try {
      req.body = JSON.parse(req.body.data);
      next();
    } catch {
      next(new AppError('Invalid JSON in data field', 400));
    }
  },
  RequestValidator(note_validations.from_file),
  note_controller.extract_note_from_any_file_or_image,
);
router.get(
  '/by-inspection/:inspectionId',
  auth('ORGANIZATION'),
  note_controller.get_note_by_inspection_id,
);
router.get('/:id', auth('ORGANIZATION'), note_controller.get_single_note);
router.patch(
  '/:id',
  auth('ORGANIZATION'),
  RequestValidator(note_validations.update_note),
  note_controller.update_note,
);
router.delete('/:id', auth('ORGANIZATION'), note_controller.delete_note);

export default router;
