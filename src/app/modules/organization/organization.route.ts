import { Router } from 'express';
import auth from '../../middlewares/auth.js';
import { orgInviteAcceptLimiter } from '../../middlewares/rate_limiters.js';
import RequestValidator from '../../middlewares/request_validator.js';
import { organization_controller } from './organization.controller.js';
import { organization_validations } from './organization.validation.js';

const router = Router();

router.post(
  '/invite',
  auth('ORGANIZATION'),
  RequestValidator(organization_validations.invite_member),
  organization_controller.invite_member,
);

router.get('/invitations', auth('ORGANIZATION'), organization_controller.get_pending_invitations);

// Admin-only (enforced in the service via requireCallerIsOrgAdmin). Without
// this, an admin has no way to discover the OrgMember.id that
// POST /inspection/:id/assignments requires — found by independent review
// tracing the real invite -> accept -> assign workflow end to end.
router.get('/members', auth('ORGANIZATION'), organization_controller.get_org_members);

// Admin-only (enforced in the service via requireCallerIsOrgAdmin). The only
// way to set OrgMember.status/expiresAt at all — see organization.service.ts.
router.patch(
  '/members/:id',
  auth('ORGANIZATION'),
  RequestValidator(organization_validations.update_member),
  organization_controller.update_org_member,
);

router.post('/invite/:id/resend', auth('ORGANIZATION'), organization_controller.resend_invitation);

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

export default router;
