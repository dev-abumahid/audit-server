import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { RedisStore, type RedisReply } from 'rate-limit-redis';
import { redisConnection } from '../queues/connection.js';
import { JwtPayloadType } from '../utils/JWT.js';

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

// POST /invite and POST /invite/:id/resend both trigger an outbound email to
// an admin-supplied address, but had no throttle at all — unlike
// orgInviteAcceptLimiter on the acceptance side. A compromised or malicious
// ADMIN account could otherwise call either in a tight loop to spam
// arbitrary external addresses with invite emails, or exhaust the email
// queue. Keyed by the caller's own accountId (not IP) since these are
// always authenticated requests — an admin working from multiple IPs still
// shares one budget, and unrelated admins in the same office/VPN don't
// collide. Must be mounted after auth() so req.user is populated. Found by
// independent review.
export const orgInviteSendLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  store: makeRedisStore('rl:org:invite-send:'),
  keyGenerator: (req) =>
    (req.user as JwtPayloadType | undefined)?.accountId ?? ipKeyGenerator(req.ip ?? ''),
  message: { success: false, message: 'Too many invitations sent. Please try again later.' },
});

// Zero-input onboarding (#96): each identify/generate call fans out to
// several Tavily + LLM calls on the aexa-ai side — the costliest endpoint
// class in this service (decision #5 on the ticket: treat it like the most
// expensive existing endpoint, nothing more elaborate). Admin-only, keyed by
// the caller's accountId (not IP) so an admin on multiple IPs still shares one
// budget and unrelated admins behind one NAT don't collide. Mounted after
// auth() so req.user is populated.
export const onboardingLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  store: makeRedisStore('rl:onboarding:'),
  keyGenerator: (req) =>
    (req.user as JwtPayloadType | undefined)?.accountId ?? ipKeyGenerator(req.ip ?? ''),
  message: { success: false, message: 'Too many onboarding attempts. Please try again later.' },
});

// Report generation (#94, hardening #219): POST /report/generate runs the full
// synchronous pipeline in one request — fetch org data -> aexa-ai -> a ~300MB
// headless Chromium (Puppeteer) render -> S3 upload. It is by far the heaviest
// endpoint class in this service: heavier per-call than onboarding (which only
// fans out to Tavily+LLM calls, no local Chromium), so it gets a *tighter*
// budget than onboardingLimiter's 20, not merely an equal one. Admin/org-write
// only, keyed by the caller's accountId (not IP) so an admin on multiple IPs
// still shares one budget and unrelated orgs behind one NAT don't collide.
// This bounds burst volume; the per-org in-flight GENERATING guard in
// report.service.ts is the separate concurrency/OOM defense. Mounted after
// auth() so req.user is populated. Found by independent review.
export const reportGenerateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  store: makeRedisStore('rl:report:generate:'),
  keyGenerator: (req) =>
    (req.user as JwtPayloadType | undefined)?.accountId ?? ipKeyGenerator(req.ip ?? ''),
  message: {
    success: false,
    message: 'Too many report generation requests. Please try again later.',
  },
});

// Threat intelligence module (#298): all 6 POST endpoints share one budget.
// /scrape is the heaviest single call in the app after report-generate --
// up to 55 concurrent external RSS fetches, then a serialized (advisory-lock
// protected, see intelligence.service.ts) create pass over every new item --
// while the other 5 (analyze/predict/mitigations/rcsa/resilience-scan) are a
// single ~45s LLM_CALL_TIMEOUT_MS call each, the same cost tier as
// onboardingLimiter's Tavily+LLM fan-out. Sized below onboardingLimiter's 20
// (this module's per-call cost is higher: scrape's fan-out alone dwarfs
// onboarding's, and all 6 routes drawing from one shared budget means the
// effective request volume against the org is broader than onboarding's
// single action) but above reportGenerateLimiter's 5 (no local Chromium
// render, no S3 upload -- the single most expensive thing this module does
// is still cheaper per-call than a full report generation). Admin-only
// (auth('ORGANIZATION')), keyed by the caller's accountId like the other
// per-org limiters above so an admin on multiple IPs still shares one budget.
export const intelligenceLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  store: makeRedisStore('rl:intelligence:'),
  keyGenerator: (req) =>
    (req.user as JwtPayloadType | undefined)?.accountId ?? ipKeyGenerator(req.ip ?? ''),
  message: {
    success: false,
    message: 'Too many threat intelligence requests. Please try again later.',
  },
});

// Slice 5 (#55): public, unauthenticated endpoint that triggers an outbound
// email — same abuse shape as orgInviteSendLimiter (spam/queue-exhaustion)
// but reachable by anyone, not just an authenticated admin, so it needs its
// own budget rather than sharing sensitiveAuthLimiter's window with sign-in/
// sign-up/password-reset traffic. Keyed by the (organizationId, email)
// target — same target-oracle reasoning as orgInviteAcceptLimiter — with an
// IP fallback for a malformed body that has neither field.
// .trim() matters here, not just .toLowerCase() — external-auth.service.ts
// normalizes the email with .trim().toLowerCase() before its DB lookup, so
// every whitespace-padded variant of the same email resolves to the same
// ExternalOrgMember row server-side. Without trimming here too, each padded
// variant produced a distinct rate-limit key, letting a caller cycle through
// ' e@x.com', 'e@x.com ', '  e@x.com' etc. to dodge the limiter entirely
// against a single real target. Found by independent review.
const externalCodeKeyGenerator = (req: { body?: { organizationId?: unknown; email?: unknown } }) =>
  typeof req.body?.organizationId === 'string' && typeof req.body?.email === 'string'
    ? `target:${req.body.organizationId}:${req.body.email.trim().toLowerCase()}`
    : undefined;

export const externalCodeRequestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  store: makeRedisStore('rl:external:code-request:'),
  keyGenerator: (req) => externalCodeKeyGenerator(req) ?? ipKeyGenerator(req.ip ?? ''),
  message: { success: false, message: 'Too many attempts. Please try again later.' },
});

// Verifying a code is a brute-force oracle against the 6-digit numeric
// keyspace — the per-row failedAttempts/lockedUntil lockout in
// external-auth.service.ts is the primary defense (see
// ExternalOrgMemberVerificationCode's schema comment), this is
// defense-in-depth against a caller cycling through fresh codes/rows faster
// than the lockout can catch.
export const externalCodeVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  store: makeRedisStore('rl:external:code-verify:'),
  keyGenerator: (req) => externalCodeKeyGenerator(req) ?? ipKeyGenerator(req.ip ?? ''),
  message: { success: false, message: 'Too many attempts. Please try again later.' },
});
