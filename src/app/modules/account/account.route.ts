import { Router } from 'express';
import { configs } from '../../configs/index.js';
import auth from '../../middlewares/auth.js';
import RequestValidator from '../../middlewares/request_validator.js';
import { passportConfig } from '../../passport-js/config.js';
import { customAccessTokenAndResponse } from '../../passport-js/customAccessTokenAndResponse.js';
import { account_controller } from './account.controller.js';
import { account_validation } from './account.validation.js';

const accountRouter = Router();

accountRouter.post(
  '/sign-up',
  RequestValidator(account_validation.sign_up),
  account_controller.create_account,
);
accountRouter.post(
  '/sign-in',
  RequestValidator(account_validation.sing_in),
  account_controller.login_user,
);
accountRouter.put(
  '/verify-otp',
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
  RequestValidator(account_validation.resend_otp),
  account_controller.resend_otp_and_verification_link,
);
accountRouter.put(
  '/forget-password',
  RequestValidator(account_validation.resend_otp),
  account_controller.forget_password_generate_reset_token,
);
accountRouter.put(
  '/reset-password',
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
