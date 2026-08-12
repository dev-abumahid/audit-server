import { Router } from 'express';
import RequestValidator from '../../middlewares/request_validator.js';
import { profile_controller } from './profile.controller.js';
import { profile_validations } from './profile.validation.js';
import auth from '../../middlewares/auth.js';
import uploader, { enforceUploadSizeLimit } from '../../middlewares/uploader.js';
import { AppError } from '../../utils/app_error.js';

const router = Router();

router.patch(
  '/',
  auth('ADMIN', 'ORGANIZATION'),
  uploader.single('file'),
  enforceUploadSizeLimit,
  (req, res, next) => {
    try {
      req.body = JSON.parse(req?.body?.data);
    } catch {
      return next(new AppError('Invalid JSON in request body', 400));
    }
    next();
  },
  RequestValidator(profile_validations.update_profile),
  profile_controller.update_profile,
);

export default router;
