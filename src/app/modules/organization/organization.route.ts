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
