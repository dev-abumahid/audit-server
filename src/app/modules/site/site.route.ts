import { Router } from 'express';
import auth from '../../middlewares/auth.js';
import RequestValidator from '../../middlewares/request_validator.js';
import { site_controller } from './site.controller.js';
import { site_validations } from './site.validation.js';

const router = Router();

router.get('/', auth('ORGANIZATION'), site_controller.get_all_site);
router.post(
  '/',
  auth('ORGANIZATION'),
  RequestValidator(site_validations.create_site),
  site_controller.create_site,
);
router.get('/:id', auth('ORGANIZATION'), site_controller.get_single_site);
router.patch(
  '/:id',
  auth('ORGANIZATION'),
  RequestValidator(site_validations.update_site),
  site_controller.update_site,
);
router.delete('/:id', auth('ORGANIZATION'), site_controller.delete_site);

export default router;
