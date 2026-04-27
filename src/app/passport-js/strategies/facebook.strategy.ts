import passport from 'passport';
import { Strategy as FacebookStrategy } from 'passport-facebook';
import { configs } from '../../configs/index.js';
import { accountCreatorHelper } from '../accountCreatorHelper.js';

if (configs.facebook_login_config.is_facebook_login) {
  passport.use(
    new FacebookStrategy(
      {
        clientID: configs.facebook_login_config.app_id as string,
        clientSecret: configs.facebook_login_config.app_secret as string,
        callbackURL: configs.facebook_login_config.callback_url as string,
        profileFields: ['id', 'displayName', 'emails'],
      },
      async (_accessToken, _refreshToken, profile, done) => {
        accountCreatorHelper(profile, done, 'FACEBOOK');
      },
    ),
  );
}
