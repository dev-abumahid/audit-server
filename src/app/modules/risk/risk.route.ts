import { Router } from 'express';
import auth from '../../middlewares/auth.js';
import RequestValidator from '../../middlewares/request_validator.js';
import { risk_approval_controller } from './risk.approval.controller.js';
import { risk_approval_validations } from './risk.approval.validation.js';
import { risk_controller } from './risk.controller.js';
import { risk_correlation_controller } from './risk.correlation.controller.js';
import { risk_correlation_validations } from './risk.correlation.validation.js';
import { risk_validations } from './risk.validation.js';

const router = Router();

// aexa-frontend#142: correlation-matrix/root-cause-bucketing are fixed
// sub-paths, not risk ids — must be registered before the `/:id` routes
// below or Express would match "correlation-matrix" as an :id param.
router.get(
  '/correlation-matrix',
  auth('ORGANIZATION'),
  risk_correlation_controller.get_correlation_matrix,
);
router.post(
  '/root-cause-bucketing',
  auth('ORGANIZATION'),
  risk_correlation_controller.root_cause_bucketing,
);
// aexa-frontend#191: nested under root-cause-bucketing, not a sibling
// top-level path — this only ever acts on one bucket's groupedAction, same
// "fixed sub-path, must come before /:id" reasoning as the two routes
// above.
router.post(
  '/root-cause-bucketing/create-action',
  auth('ORGANIZATION'),
  RequestValidator(risk_correlation_validations.create_action_from_bucket),
  risk_correlation_controller.create_action_from_bucket,
);

router.get('/', auth('ORGANIZATION'), risk_controller.get_all_risk);
router.post(
  '/',
  auth('ORGANIZATION'),
  RequestValidator(risk_validations.create_risk),
  risk_controller.create_risk,
);

// aexa-frontend#95: risk maker-checker approval workflow. Role checks are
// enforced in the service (assertCanWriteOrgResource for submit,
// assertIsOrgAdmin for approve/reject), mirroring the FindingAssignment
// endpoints in action.route.ts. Approve/reject key off the approval row's own
// id (an admin acts from a pending-approvals list, not necessarily while
// looking at one specific risk), same shape as /action/assignments/:id/approve.
router.post(
  '/:id/submit-for-approval',
  auth('ORGANIZATION'),
  risk_approval_controller.submit_risk_for_approval,
);
router.get('/:id/approval', auth('ORGANIZATION'), risk_approval_controller.get_risk_approval_state);
router.post('/approvals/:id/approve', auth('ORGANIZATION'), risk_approval_controller.approve_risk);
router.post(
  '/approvals/:id/reject',
  auth('ORGANIZATION'),
  RequestValidator(risk_approval_validations.reject_risk),
  risk_approval_controller.reject_risk,
);

router.get('/:id', auth('ORGANIZATION'), risk_controller.get_single_risk);
router.patch(
  '/:id',
  auth('ORGANIZATION'),
  RequestValidator(risk_validations.update_risk),
  risk_controller.update_risk,
);
router.delete('/:id', auth('ORGANIZATION'), risk_controller.delete_risk);

export default router;
