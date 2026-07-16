import { Router } from 'express';
import RequestValidator from '../../middlewares/request_validator.js';
import { profile_controller } from './profile.controller.js';
import { profile_validations } from './profile.validation.js';
import auth from '../../middlewares/auth.js';
import uploader from '../../middlewares/uploader.js';

const router = Router();

router.patch(
  '/',
  auth('ADMIN', 'ORGANIZATION'),
  uploader.single('file'),
  (req, res, next) => {
    req.body = JSON.parse(req?.body?.data);
    next();
  },
  RequestValidator(profile_validations.update_profile),
  profile_controller.update_profile,
);

export default router;
