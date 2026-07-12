import { rateLimit } from 'express-rate-limit';
import { RedisStore, type RedisReply } from 'rate-limit-redis';
import { redisConnection } from '../queues/connection.js';

export const makeRedisStore = (prefix: string) =>
  new RedisStore({
    prefix,
    sendCommand: (command: string, ...args: string[]) =>
      redisConnection.call(command, ...args) as Promise<RedisReply>,
  });

// Brute-force sensitive: sign-in, sign-up, OTP, password reset, org invite accept
export const sensitiveAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  store: makeRedisStore('rl:auth:sensitive:'),
  message: { success: false, message: 'Too many attempts. Please try again later.' },
});
