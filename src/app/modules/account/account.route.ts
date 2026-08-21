import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { configs } from '../../configs/index.js';
import auth from '../../middlewares/auth.js';
import { makeRedisStore, sensitiveAuthLimiter } from '../../middlewares/rate_limiters.js';
import RequestValidator from '../../middlewares/request_validator.js';
import { passportConfig } from '../../passport-js/config.js';
import { customAccessTokenAndResponse } from '../../passport-js/customAccessTokenAndResponse.js';
import { account_controller } from './account.controller.js';
import { account_validation } from './account.validation.js';

// Session check: /me fires on every page load, no credential risk
const sessionCheckLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
  store: makeRedisStore('rl:auth:me:'),
});

// Same generous ceiling and reasoning as sessionCheckLimiter (fires on every
// sign-in modal open, no credential risk) but its own Redis prefix — sharing
// sessionCheckLimiter's instance would mean /me and /social-providers drew
// from a single combined 500/15min budget instead of each getting 500 of
// their own. Found by independent review.
const socialProvidersLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
  store: makeRedisStore('rl:auth:social-providers:'),
});

const accountRouter = Router();

accountRouter.post(
  '/sign-up',
  sensitiveAuthLimiter,
  RequestValidator(account_validation.sign_up),
  account_controller.create_account,
);
accountRouter.post(
  '/sign-in',
  sensitiveAuthLimiter,
  RequestValidator(account_validation.sing_in),
  account_controller.login_user,
);
accountRouter.put(
  '/verify-otp',
  sensitiveAuthLimiter,
  RequestValidator(account_validation.verify_otp),
  account_controller.verify_account_using_otp,
);
accountRouter.put(
  '/verify-link',
  sensitiveAuthLimiter,
  RequestValidator(account_validation.verify_link),
  account_controller.verify_account_using_link,
);
accountRouter.get(
  '/me',
  sessionCheckLimiter,
  auth('USER', 'ADMIN', 'ORGANIZATION'),
  account_controller.get_user_account,
);
accountRouter.put(
  '/change-password',
  sensitiveAuthLimiter,
  auth('USER', 'ADMIN', 'ORGANIZATION'),
  RequestValidator(account_validation.change_password),
  account_controller.change_password,
);
accountRouter.put(
  '/resend-otp',
  sensitiveAuthLimiter,
  RequestValidator(account_validation.resend_otp),
  account_controller.resend_otp_and_verification_link,
);
accountRouter.put(
  '/forget-password',
  sensitiveAuthLimiter,
  RequestValidator(account_validation.resend_otp),
  account_controller.forget_password_generate_reset_token,
);
accountRouter.put(
  '/reset-password',
  sensitiveAuthLimiter,
  RequestValidator(account_validation.reset_pass),
  account_controller.reset_password_using_token,
);
// auth() gated per issue #19's own spec. Consequence, intentional not
// overlooked: a client with an already-expired/missing token now gets 401
// here instead of a clean 200 + cookie clear, so "defensive logout" (call
// this even when the session might already be dead, just to be sure the
// cookie is gone) no longer no-ops silently. Accepted tradeoff for #19's
// stated goal (only an authenticated caller may invalidate a session) --
// revisit if the frontend needs a logout call that succeeds regardless of
// token validity.
accountRouter.post(
  '/logout',
  sensitiveAuthLimiter,
  auth('USER', 'ADMIN', 'ORGANIZATION'),
  account_controller.logout_user_from_browser_cookie,
);

// Lets the frontend render only "Sign in with X" buttons for providers that
// actually have real OAuth credentials configured (see the is_*_login
// gates below) — no auth required, this is read before a session exists,
// same as sign-in/sign-up. Uses socialProvidersLimiter (not
// sensitiveAuthLimiter) for the same reason /me's sessionCheckLimiter does:
// fires on every sign-in modal open, no credential risk — but its own
// limiter instance, not a shared budget with /me.
accountRouter.get(
  '/social-providers',
  socialProvidersLimiter,
  account_controller.get_social_providers,
);

//  Social provider login (Google)
if (configs.google_login_config.is_google_login) {
  accountRouter.get(
    '/social/google',
    passportConfig.authenticate('google', { scope: ['email', 'profile'] }),
  );
  accountRouter.get(
    '/social/google/callback',
    passportConfig.authenticate('google', { failureRedirect: '/', session: false }),
    (req: any, res: any) => {
      customAccessTokenAndResponse(req, res);
    },
  );
}

//  Social provider login (Facebook)
if (configs.facebook_login_config.is_facebook_login) {
  accountRouter.get(
    '/social/facebook',
    passportConfig.authenticate('facebook', { scope: ['email', 'public_profile'] }),
  );
  accountRouter.get(
    '/social/facebook/callback',
    passportConfig.authenticate('facebook', { failureRedirect: '/', session: false }),
    (req: any, res: any) => {
      customAccessTokenAndResponse(req, res);
    },
  );
}

//  Social provider login (Twitter)
if (configs.twitter.is_twitter_login) {
  accountRouter.get('/social/twitter', passportConfig.authenticate('twitter'));
  accountRouter.get(
    '/social/twitter/callback',
    passportConfig.authenticate('twitter', { failureRedirect: '/' }),
    (req: any, res: any) => {
      customAccessTokenAndResponse(req, res);
    },
  );
}

//  Social provider login (gitHub)
if (configs.github.is_github_login) {
  accountRouter.get('/social/github', passportConfig.authenticate('github'));
  accountRouter.get(
    '/social/github/callback',
    passportConfig.authenticate('github', { failureRedirect: '/', session: false }),
    (req: any, res: any) => {
      customAccessTokenAndResponse(req, res);
    },
  );
}

export default accountRouter;
