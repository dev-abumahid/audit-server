import { Router } from 'express';
import auth from '../../middlewares/auth.js';
import RequestValidator from '../../middlewares/request_validator.js';
import uploader from '../../middlewares/uploader.js';
import { template_controller } from './template.controller.js';
import { template_validations } from './template.validation.js';

const router = Router();

router.get('/', auth('ORGANIZATION'), template_controller.get_all_template);
router.post(
  '/',
  auth('ORGANIZATION'),
  uploader.single('file'),
  (req, res, next) => {
    req.body = JSON.parse(req?.body?.data);
    next();
  },
  RequestValidator(template_validations.create_template),
  template_controller.create_template,
);

// update part by part
router.patch(
  '/update-or-create-new-page',
  auth('ORGANIZATION'),
  RequestValidator(template_validations.update_or_create_new_page),
  template_controller.update_or_create_new_page,
);
router.delete(
  '/delete-template-page/:id',
  auth('ORGANIZATION'),
  template_controller.delete_template_page_by_id,
);

router.patch(
  '/update-or-create-new-question',
  auth('ORGANIZATION'),
  RequestValidator(template_validations.update_or_create_new_question),
  template_controller.update_or_delete_new_question,
);
router.delete(
  '/delete-page-question/:id',
  auth('ORGANIZATION'),
  template_controller.delete_page_question_by_id,
);

router.get('/:id', auth('ORGANIZATION'), template_controller.get_single_template);
router.patch(
  '/:id',
  auth('ORGANIZATION'),
  uploader.single('file'),
  (req, res, next) => {
    req.body = JSON.parse(req?.body?.data);
    next();
  },
  RequestValidator(template_validations.update_template),
  template_controller.update_template,
);
router.delete('/:id', auth('ORGANIZATION'), template_controller.delete_template);

export default router;
