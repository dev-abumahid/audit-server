import { Router } from 'express';
import auth from '../../middlewares/auth.js';
import { orgInviteAcceptLimiter, orgInviteSendLimiter } from '../../middlewares/rate_limiters.js';
import RequestValidator from '../../middlewares/request_validator.js';
import { organization_controller } from './organization.controller.js';
import { organization_validations } from './organization.validation.js';

const router = Router();

// Admin-only tenant creation (#96). Net-new: there was previously no way to
// create an Organization anywhere in this codebase. Lives under the admin
// surface, matching where org creation sits in the frontend today.
router.post(
  '/',
  auth('ADMIN'),
  RequestValidator(organization_validations.create_organization),
  organization_controller.create_organization,
);

router.post(
  '/invite',
  auth('ORGANIZATION'),
  orgInviteSendLimiter,
  RequestValidator(organization_validations.invite_member),
  organization_controller.invite_member,
);

router.get('/invitations', auth('ORGANIZATION'), organization_controller.get_pending_invitations);

// Any active org member, not just admins (see get_org_members_from_db's
// doc comment for why) — an admin needs it to discover the OrgMember.id
// that POST /inspection/:id/assignments requires, and any member needs it
// to populate the finding-assignment picker (#40).
router.get('/members', auth('ORGANIZATION'), organization_controller.get_org_members);

// Admin-only (enforced in the service via requireCallerIsOrgAdmin). The only
// way to set OrgMember.status/expiresAt at all — see organization.service.ts.
router.patch(
  '/members/:id',
  auth('ORGANIZATION'),
  RequestValidator(organization_validations.update_member),
  organization_controller.update_org_member,
);

router.post(
  '/invite/:id/resend',
  auth('ORGANIZATION'),
  orgInviteSendLimiter,
  organization_controller.resend_invitation,
);

// Admin-only (enforced in the service via requireCallerIsOrgAdmin). Slice 4
// (#55): toggles whether a finding sub-assignment needs Admin approval
// before it takes effect — see action.service.ts.
router.get('/settings', auth('ORGANIZATION'), organization_controller.get_organization_settings);
router.patch(
  '/settings',
  auth('ORGANIZATION'),
  RequestValidator(organization_validations.update_settings),
  organization_controller.update_organization_settings,
);

// Public — the invitation token itself is the credential that gets you to
// this endpoint at all; no JWT auth middleware in front of it. The token is
// taken from the request body, not the URL (matches this repo's existing
// verify-link/reset-password convention — see account.route.ts) so it never
// lands in server-side URL logging, APM traces, or a Referer header.
router.post(
  '/invite/accept',
  orgInviteAcceptLimiter,
  RequestValidator(organization_validations.accept_invitation),
  organization_controller.accept_invitation,
);

// Slice 5 (#55): admin management of external (non-Account) Light User
// members. Admin-only (enforced in the service via requireCallerIsOrgAdmin),
// same as /members above.
router.post(
  '/external-members',
  auth('ORGANIZATION'),
  orgInviteSendLimiter,
  RequestValidator(organization_validations.invite_external_member),
  organization_controller.invite_external_member,
);
router.get('/external-members', auth('ORGANIZATION'), organization_controller.get_external_members);
router.patch(
  '/external-members/:id',
  auth('ORGANIZATION'),
  RequestValidator(organization_validations.update_external_member),
  organization_controller.update_external_member,
);

export default router;
