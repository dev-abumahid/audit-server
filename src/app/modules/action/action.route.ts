import { Router } from 'express';
import auth from '../../middlewares/auth.js';
import authExternal from '../../middlewares/auth_external.js';
import RequestValidator from '../../middlewares/request_validator.js';
import uploader from '../../middlewares/uploader.js';
import { action_controller } from './action.controller.js';
import { action_validations } from './action.validation.js';

const router = Router();

router.get('/', auth('ORGANIZATION'), action_controller.get_all_action);
router.post(
  '/',
  auth('ORGANIZATION'),
  RequestValidator(action_validations.create_action),
  action_controller.create_action,
);
router.post(
  '/attachment',
  auth('ORGANIZATION'),
  uploader.single('file'),
  action_controller.upload_action_attachment,
);
router.get('/:id', auth('ORGANIZATION'), action_controller.get_single_action);
router.patch(
  '/:id',
  auth('ORGANIZATION'),
  RequestValidator(action_validations.update_action),
  action_controller.update_action,
);
router.put(
  '/:id',
  auth('ORGANIZATION'),
  RequestValidator(action_validations.update_action_messages),
  action_controller.update_action_messages,
);
router.delete('/:id', auth('ORGANIZATION'), action_controller.delete_action);

// Slice 4 (#55): sub-assign one finding to an internal Light User member.
// Admin-only and assigned-Lead-Auditor-only, enforced in the service via
// assertCanWriteToInspection — see action.service.ts.
router.post(
  '/:id/assign',
  auth('ORGANIZATION'),
  RequestValidator(action_validations.assign_light_user),
  action_controller.assign_light_user,
);
router.delete(
  '/:id/assign/:orgMemberId',
  auth('ORGANIZATION'),
  action_controller.unassign_light_user,
);
// Slice 5 (#55): external-member counterpart. A distinct path segment
// (`/external/:externalOrgMemberId`) rather than reusing `:orgMemberId` —
// the two id spaces are different tables, and collapsing them into one
// route param would mean guessing which table to check first (or checking
// both on every call) instead of the route itself saying which one.
router.delete(
  '/:id/assign/external/:externalOrgMemberId',
  auth('ORGANIZATION'),
  action_controller.unassign_external_light_user,
);
router.get('/:id/assignments', auth('ORGANIZATION'), action_controller.get_finding_assignments);

// aexa-server#252: finding closure maker-checker workflow. Submission is
// nested under /:id (it's about one specific finding); approve/reject
// mirror the assignments pattern above (not nested under /:id — a
// verifier reviews from a pending-closures list, not necessarily while
// looking at one specific finding).
router.post(
  '/:id/closure/submit',
  auth('ORGANIZATION'),
  RequestValidator(action_validations.submit_action_closure),
  action_controller.submit_action_closure,
);
router.get('/:id/closure', auth('ORGANIZATION'), action_controller.get_action_closure_state);
router.post('/closure/:id/approve', auth('ORGANIZATION'), action_controller.approve_action_closure);
router.post(
  '/closure/:id/reject',
  auth('ORGANIZATION'),
  RequestValidator(action_validations.reject_action_closure),
  action_controller.reject_action_closure,
);

// Self-scoped — any member can see their own sub-assignments (including
// pending/rejected ones), since there's no cross-member data exposed. Not
// nested under /:id since it's not about one finding.
router.get('/assignments/mine', auth('ORGANIZATION'), action_controller.get_my_finding_assignments);

// Admin-only (enforced in the service via assertIsOrgAdmin). Not nested
// under /:id — an admin approves/rejects from a pending-approvals list, not
// necessarily while looking at one specific finding.
router.post(
  '/assignments/:id/approve',
  auth('ORGANIZATION'),
  action_controller.approve_finding_assignment,
);
router.post(
  '/assignments/:id/reject',
  auth('ORGANIZATION'),
  action_controller.reject_finding_assignment,
);

// Slice 5 (#55): external Light User's own view of findings they've been
// sub-assigned — gated by authExternal, not auth('ORGANIZATION'), since an
// external member has no Account/internal JWT at all. Multi-segment paths
// (`external/mine`, `external/:id`) never collide with the single-segment
// `/:id` route above regardless of declaration order — see the unassign
// route above for the same reasoning.
router.get('/external/mine', authExternal(), action_controller.get_my_finding_assignments_external);
router.get('/external/:id', authExternal(), action_controller.get_single_action_external);
router.patch(
  '/external/:id',
  authExternal(),
  RequestValidator(action_validations.update_action),
  action_controller.update_action_external,
);

export default router;
