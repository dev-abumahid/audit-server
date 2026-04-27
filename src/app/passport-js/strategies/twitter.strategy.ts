import passport from 'passport';
import { Strategy as TwitterStrategy } from 'passport-twitter';
import { configs } from '../../configs/index.js';
import { accountCreatorHelper } from '../accountCreatorHelper.js';

if (configs.twitter.is_twitter_login) {
  passport.use(
    new TwitterStrategy(
      {
        consumerKey: configs.twitter.consumer_key as string,
        consumerSecret: configs.twitter.consumer_secret as string,
        callbackURL: configs.twitter.callback_url as string,
      },
      async (_accessToken, _refreshToken, profile, done) => {
        accountCreatorHelper(profile, done, 'TWITTER');
      },
    ),
  );
}
