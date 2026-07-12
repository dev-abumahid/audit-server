import { rateLimit } from 'express-rate-limit';
import { RedisStore, type RedisReply } from 'rate-limit-redis';
import { redisConnection } from '../queues/connection.js';

export const makeRedisStore = (prefix: string) =>
  new RedisStore({
    prefix,
    sendCommand: (command: string, ...args: string[]) =>
      redisConnection.call(command, ...args) as Promise<RedisReply>,
  });

// Brute-force sensitive: sign-in, sign-up, OTP, password reset
export const sensitiveAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  store: makeRedisStore('rl:auth:sensitive:'),
  message: { success: false, message: 'Too many attempts. Please try again later.' },
});

// Same brute-force budget as sensitiveAuthLimiter, but its own Redis key
// space — org invite acceptance is a login-equivalent surface (password
// check against an existing account) but an unrelated attack surface from
// sign-in/sign-up. Sharing one IP-keyed bucket would let ordinary login
// traffic from a shared IP (office NAT, VPN) collaterally lock out someone
// accepting an invite, and vice versa.
export const orgInviteAcceptLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  store: makeRedisStore('rl:org:invite-accept:'),
  message: { success: false, message: 'Too many attempts. Please try again later.' },
});
