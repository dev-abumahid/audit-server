import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { RedisStore, type RedisReply } from 'rate-limit-redis';
import { configs } from '../../configs/index.js';
import auth from '../../middlewares/auth.js';
import RequestValidator from '../../middlewares/request_validator.js';
import { passportConfig } from '../../passport-js/config.js';
import { customAccessTokenAndResponse } from '../../passport-js/customAccessTokenAndResponse.js';
import { redisConnection } from '../../queues/connection.js';
import { account_controller } from './account.controller.js';
import { account_validation } from './account.validation.js';

const makeRedisStore = (prefix: string) =>
  new RedisStore({
    prefix,
    sendCommand: (command: string, ...args: string[]) =>
      redisConnection.call(command, ...args) as Promise<RedisReply>,
  });

// Brute-force sensitive: sign-in, sign-up, OTP, password reset
const sensitiveAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  store: makeRedisStore('rl:auth:sensitive:'),
  message: { success: false, message: 'Too many attempts. Please try again later.' },
});

// Session check: /me fires on every page load, no credential risk
const sessionCheckLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
  store: makeRedisStore('rl:auth:me:'),
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
