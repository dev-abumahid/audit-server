import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
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
  // Keyed by the invitation token, not IP: accept_invitation_into_db's
  // existing-account branch checks `password` against that one account's
  // stored hash, so this endpoint is a password-verification oracle
  // against a *specific* target identified by the token in the request
  // body. An IP-keyed limit gives an attacker with multiple source IPs
  // (proxy pool, botnet) an effectively unbounded budget against one
  // target — each IP gets its own fresh window. Falling back to IP (via
  // the IPv6-safe helper) only for the rare malformed-body request that
  // has no token to key by, so those still get *a* limit.
  keyGenerator: (req) =>
    typeof req.body?.token === 'string' && req.body.token
      ? `token:${req.body.token}`
      : ipKeyGenerator(req.ip ?? ''),
  message: { success: false, message: 'Too many attempts. Please try again later.' },
});
