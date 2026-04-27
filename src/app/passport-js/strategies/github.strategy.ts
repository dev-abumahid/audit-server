import passport from 'passport';
import { Strategy as GithubStrategy } from 'passport-github';
import { configs } from '../../configs/index.js';
import { accountCreatorHelper } from '../accountCreatorHelper.js';

if (configs.github.is_github_login) {
  passport.use(
    new GithubStrategy(
      {
        clientID: configs.github.client_id as string,
        clientSecret: configs.github.client_secret as string,
        callbackURL: configs.github.callback_url as string,
        scope: ['user:email'],
      },
      async (_accessToken, _refreshToken, profile, done) => {
        accountCreatorHelper(profile, done, 'GITHUB');
      },
    ),
  );
}
