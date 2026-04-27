import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { configs } from '../../configs/index.js';
import { accountCreatorHelper } from '../accountCreatorHelper.js';

if (configs.google_login_config.is_google_login) {
  passport.use(
    new GoogleStrategy(
      {
        clientID: configs.google_login_config.client_id as string,
        clientSecret: configs.google_login_config.client_secret as string,
        callbackURL: configs.google_login_config.callback_url as string,
      },
      async (_accessToken, _refreshToken, profile, done) => {
        accountCreatorHelper(profile, done, 'GOOGLE');
      },
    ),
  );
}
