import { Router } from 'express';
import auth from '../../middlewares/auth.js';
import RequestValidator from '../../middlewares/request_validator.js';
import { supplier_controller } from './supplier.controller.js';
import { supplier_validations } from './supplier.validation.js';

const router = Router();

router.get('/', auth('ORGANIZATION'), supplier_controller.get_all_supplier);
router.post(
  '/',
  auth('ORGANIZATION'),
  RequestValidator(supplier_validations.create_supplier),
  supplier_controller.create_supplier,
);
// Placed before /:id so "discover" is never captured as an :id param --
// Express matches routes in registration order, and this is a POST (not
// GET) so it doesn't collide with GET /:id regardless, but keeping it
// grouped with the other fixed-path routes for readability.
router.post(
  '/discover',
  auth('ORGANIZATION'),
  RequestValidator(supplier_validations.discover_suppliers),
  supplier_controller.discover_suppliers,
);
// Bulk actions -- POST (not DELETE-with-body) for both, same convention
// as risk.route.ts's bulk-approve/bulk-dismiss. Placed before /:id for the
// same reason /discover is: readability grouping with the other fixed-path
// routes (Express matches by HTTP method + path, so a POST here never
// collides with the GET/PATCH/DELETE /:id routes regardless of order).
router.post(
  '/bulk-status',
  auth('ORGANIZATION'),
  RequestValidator(supplier_validations.bulk_update_status),
  supplier_controller.bulk_update_status,
);
router.post(
  '/bulk-delete',
  auth('ORGANIZATION'),
  RequestValidator(supplier_validations.bulk_delete),
  supplier_controller.bulk_delete,
);
router.get('/:id', auth('ORGANIZATION'), supplier_controller.get_single_supplier);
router.patch(
  '/:id',
  auth('ORGANIZATION'),
  RequestValidator(supplier_validations.update_supplier),
  supplier_controller.update_supplier,
);
router.delete('/:id', auth('ORGANIZATION'), supplier_controller.delete_supplier);

export default router;
