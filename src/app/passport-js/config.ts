import passport from 'passport';
import './strategies/facebook.strategy.js';
import './strategies/github.strategy.js';
import './strategies/google.strategy.js';
import './strategies/twitter.strategy.js';

export const passportConfig = passport;
