import express from 'express';
import { rateLimit } from 'express-rate-limit';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

/**
 * Real limiters (app.ts + account.route.ts) are wired against a Redis-backed
 * store created eagerly at module import time (real ioredis connection + Lua
 * EVAL scripts via rate-limit-redis). That's third-party infra, not our
 * logic — faithfully mocking it would mean re-implementing Redis's EVAL
 * semantics. What's ours to verify is the config *shape*, currently:
 *
 *   app.ts:           app.use('/api', apiLimiter)              — 300/15min, all API traffic
 *   account.route.ts: POST /sign-up, /sign-in,
 *                      PUT /verify-otp, /resend-otp,
 *                      /forget-password, /reset-password,
 *                      /verify-link                             — sensitiveAuthLimiter, 10/15min
 *                      GET /me                                  — sessionCheckLimiter, 500/15min
 *                      GET /social-providers                    — socialProvidersLimiter, 500/15min
 *                      PUT /change-password                     — no auth-specific limiter
 *
 * Every account route still sits under apiLimiter too (mounted broadly on
 * /api in app.ts), so sensitive routes are double-counted: the tight
 * per-route limiter (10) will always bind before the broad one (300) does.
 * This suite reconstructs that real shape — using the actual max=10 for the
 * sensitive limiter (small enough to test directly) and scaled-down but
 * proportionate maxes for the broad/session limiters (300/500 would just be
 * slow to literally exhaust) — with an in-memory store instead of Redis.
 */
function buildApp({
  apiMax,
  sessionMax,
  socialProvidersMax = 100,
}: {
  apiMax: number;
  sessionMax: number;
  socialProvidersMax?: number;
}) {
  const app = express();

  const apiLimiter = rateLimit({
    windowMs: 60_000,
    max: apiMax,
    standardHeaders: true,
    legacyHeaders: false,
  });
  const sensitiveAuthLimiter = rateLimit({
    windowMs: 60_000,
    max: 10, // real production value — small enough to test as-is
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: 'Too many attempts. Please try again later.' },
  });
  const sessionCheckLimiter = rateLimit({
    windowMs: 60_000,
    max: sessionMax,
    standardHeaders: true,
    legacyHeaders: false,
  });
  // Own instance, distinct from sessionCheckLimiter — account.route.ts used
  // to share sessionCheckLimiter between /me and /social-providers (a bug,
  // fixed once independent review caught it: the two routes were drawing
  // from a single combined budget instead of each having their own).
  const socialProvidersLimiter = rateLimit({
    windowMs: 60_000,
    max: socialProvidersMax,
    standardHeaders: true,
    legacyHeaders: false,
  });

  app.use('/api', apiLimiter);

  app.post('/api/auth/sign-in', sensitiveAuthLimiter, (_req, res) =>
    res.status(200).json({ ok: true }),
  );
  app.put('/api/auth/verify-otp', sensitiveAuthLimiter, (_req, res) =>
    res.status(200).json({ ok: true }),
  );
  app.put('/api/auth/verify-link', sensitiveAuthLimiter, (_req, res) =>
    res.status(200).json({ ok: true }),
  );
  app.get('/api/auth/me', sessionCheckLimiter, (_req, res) => res.status(200).json({ ok: true }));
  app.get('/api/auth/social-providers', socialProvidersLimiter, (_req, res) =>
    res.status(200).json({ ok: true }),
  );
  // No auth-specific limiter here — only the broad apiLimiter applies
  app.put('/api/auth/change-password', (_req, res) => res.status(200).json({ ok: true }));

  return app;
}

describe('rate limiter config shape (mirrors app.ts + account.route.ts)', () => {
  it('allows sign-in up to the sensitive-auth limit (10), then 429s', async () => {
    const app = buildApp({ apiMax: 100, sessionMax: 100 });

    for (let i = 0; i < 10; i++) {
      const res = await request(app).post('/api/auth/sign-in');
      expect(res.status).toBe(200);
    }
    const eleventh = await request(app).post('/api/auth/sign-in');
    expect(eleventh.status).toBe(429);
    expect(eleventh.body.message).toMatch(/too many attempts/i);
  });

  it('shares one sensitive-auth budget across all sensitive routes (sign-in + OTP together)', async () => {
    // account.route.ts declares sensitiveAuthLimiter ONCE and reuses that same
    // instance as middleware on sign-up/sign-in/verify-otp/verify-link/resend-otp/
    // forget-password/reset-password — so attempts across different sensitive
    // endpoints share one counter. This is the correct anti-brute-force design
    // (an attacker can't reset their budget by switching endpoints), not a bug —
    // this test locks it in.
    const app = buildApp({ apiMax: 100, sessionMax: 100 });

    for (let i = 0; i < 6; i++) {
      await request(app).post('/api/auth/sign-in');
    }
    for (let i = 0; i < 4; i++) {
      await request(app).put('/api/auth/verify-otp');
    }
    // Budget of 10 now exhausted across both routes combined
    const signInBlocked = await request(app).post('/api/auth/sign-in');
    const otpBlocked = await request(app).put('/api/auth/verify-otp');
    const verifyLinkBlocked = await request(app).put('/api/auth/verify-link');

    expect(signInBlocked.status).toBe(429);
    expect(otpBlocked.status).toBe(429);
    expect(verifyLinkBlocked.status).toBe(429);
  });

  it('rate-limits /verify-link under the sensitive-auth limiter (regression test for #110)', async () => {
    // /verify-link consumes real credential-adjacent tokens (email verification
    // links) — it must sit under sensitiveAuthLimiter like the other auth routes,
    // not rely solely on the broad apiLimiter.
    const app = buildApp({ apiMax: 100, sessionMax: 100 });

    for (let i = 0; i < 10; i++) {
      const res = await request(app).put('/api/auth/verify-link');
      expect(res.status).toBe(200);
    }
    const eleventh = await request(app).put('/api/auth/verify-link');
    expect(eleventh.status).toBe(429);
    expect(eleventh.body.message).toMatch(/too many attempts/i);
  });

  it('does not rate-limit /me under the sensitive-auth limiter', async () => {
    const app = buildApp({ apiMax: 100, sessionMax: 3 });

    for (let i = 0; i < 10; i++) {
      await request(app).post('/api/auth/sign-in'); // exhaust sensitive limiter
    }
    const meRes = await request(app).get('/api/auth/me');

    expect(meRes.status).toBe(200); // /me uses sessionCheckLimiter, a separate counter
  });

  it('rate-limits /me under its own session-check limiter once exhausted', async () => {
    const app = buildApp({ apiMax: 100, sessionMax: 2 });

    await request(app).get('/api/auth/me');
    await request(app).get('/api/auth/me');
    const thirdRes = await request(app).get('/api/auth/me');

    expect(thirdRes.status).toBe(429);
  });

  it('exhausting /me does not affect /social-providers, and vice versa', async () => {
    const app = buildApp({ apiMax: 100, sessionMax: 2, socialProvidersMax: 2 });

    // Exhaust /me's budget (2)
    await request(app).get('/api/auth/me');
    await request(app).get('/api/auth/me');
    const meBlocked = await request(app).get('/api/auth/me');
    expect(meBlocked.status).toBe(429);

    // /social-providers has its own separate budget, untouched by the above
    const providersOk1 = await request(app).get('/api/auth/social-providers');
    const providersOk2 = await request(app).get('/api/auth/social-providers');
    expect(providersOk1.status).toBe(200);
    expect(providersOk2.status).toBe(200);

    // Now exhaust /social-providers too, and confirm /me was never touched by it
    const providersBlocked = await request(app).get('/api/auth/social-providers');
    expect(providersBlocked.status).toBe(429);
  });

  it('routes with no auth-specific limiter still fall under the broad apiLimiter', async () => {
    // change-password has no per-route limiter in account.route.ts —
    // apiLimiter (mounted on all of /api in app.ts) is the only thing protecting it.
    const app = buildApp({ apiMax: 2, sessionMax: 100 });

    await request(app).put('/api/auth/change-password');
    await request(app).get('/api/auth/me');
    const thirdRes = await request(app).put('/api/auth/change-password');

    expect(thirdRes.status).toBe(429);
  });

  it('double-counts sensitive routes against the broad apiLimiter too', async () => {
    // A sign-in request consumes both its own sensitive-auth counter AND the
    // broad apiLimiter counter, since apiLimiter is mounted on all of /api.
    const app = buildApp({ apiMax: 2, sessionMax: 100 });

    const r1 = await request(app).post('/api/auth/sign-in');
    const r2 = await request(app).post('/api/auth/sign-in');
    const r3 = await request(app).post('/api/auth/sign-in');

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    // sensitiveAuthLimiter alone would still allow this (max 10), but the
    // broad apiLimiter (max 2 here) has already been exhausted.
    expect(r3.status).toBe(429);
  });

  it('sets standard rate-limit response headers', async () => {
    const app = buildApp({ apiMax: 100, sessionMax: 100 });

    const res = await request(app).post('/api/auth/sign-in');

    expect(res.headers['ratelimit-limit']).toBeDefined();
    expect(res.headers['ratelimit-remaining']).toBeDefined();
  });
});

/**
 * #298: intelligence.route.ts's 6 POST endpoints (/scrape, /analyze,
 * /predict, /mitigations, /rcsa, /resilience-scan) had no rate limiter at
 * all, unlike onboardingLimiter (20/15min) and reportGenerateLimiter
 * (5/15min) for a comparable "fans out to Tavily+LLM calls" cost profile.
 * The fix, intelligenceLimiter in rate_limiters.ts, is a single shared
 * budget (max 10/15min, real production value — small enough to test
 * directly) across all 6 routes, keyed by accountId same as
 * onboardingLimiter/reportGenerateLimiter, with an in-memory store standing
 * in for the real Redis-backed one (same convention as the suite above).
 */
function buildIntelligenceApp({ max = 10 }: { max?: number } = {}) {
  const app = express();
  app.use(express.json());

  // Stand-in for auth() — populates req.user from a header instead of a real
  // JWT, so the accountId-keyed limiter has something to key on.
  app.use((req, _res, next) => {
    const accountId = req.header('x-account-id');
    if (accountId) (req as unknown as { user: { accountId: string } }).user = { accountId };
    next();
  });

  const intelligenceLimiter = rateLimit({
    windowMs: 60_000,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) =>
      (req as unknown as { user?: { accountId: string } }).user?.accountId ?? req.ip ?? 'anon',
    message: {
      success: false,
      message: 'Too many threat intelligence requests. Please try again later.',
    },
  });

  for (const path of ['scrape', 'analyze', 'predict', 'mitigations', 'rcsa', 'resilience-scan']) {
    app.post(`/api/intelligence/${path}`, intelligenceLimiter, (_req, res) =>
      res.status(200).json({ ok: true }),
    );
  }

  return app;
}

describe('intelligenceLimiter config shape (mirrors intelligence.route.ts)', () => {
  it('allows up to the limit (10) on /scrape, then 429s', async () => {
    const app = buildIntelligenceApp();

    for (let i = 0; i < 10; i++) {
      const res = await request(app).post('/api/intelligence/scrape').set('x-account-id', 'org-1');
      expect(res.status).toBe(200);
    }
    const eleventh = await request(app)
      .post('/api/intelligence/scrape')
      .set('x-account-id', 'org-1');
    expect(eleventh.status).toBe(429);
    expect(eleventh.body.message).toMatch(/too many threat intelligence requests/i);
  });

  it('shares one budget across all 6 intelligence routes for the same org', async () => {
    // Each of the 6 routes mounts its OWN middleware call but the SAME
    // intelligenceLimiter instance (intelligence.route.ts declares it once
    // and reuses it) -- so calls to different routes for the same caller
    // draw down one shared counter, same convention as sensitiveAuthLimiter
    // sharing across sign-in/OTP/etc above.
    const app = buildIntelligenceApp({ max: 6 });

    const routes = ['scrape', 'analyze', 'predict', 'mitigations', 'rcsa', 'resilience-scan'];
    for (const path of routes) {
      const res = await request(app).post(`/api/intelligence/${path}`).set('x-account-id', 'org-1');
      expect(res.status).toBe(200);
    }
    // Budget of 6 now exhausted across all 6 routes combined.
    const blocked = await request(app)
      .post('/api/intelligence/scrape')
      .set('x-account-id', 'org-1');
    expect(blocked.status).toBe(429);
  });

  it('keys by accountId, not IP — unrelated orgs behind the same NAT do not collide', async () => {
    const app = buildIntelligenceApp({ max: 2 });

    await request(app).post('/api/intelligence/scrape').set('x-account-id', 'org-1');
    await request(app).post('/api/intelligence/scrape').set('x-account-id', 'org-1');
    const orgOneBlocked = await request(app)
      .post('/api/intelligence/scrape')
      .set('x-account-id', 'org-1');
    expect(orgOneBlocked.status).toBe(429);

    // A different org, same simulated source IP (supertest reuses one
    // in-process connection), has its own untouched budget.
    const orgTwoOk = await request(app)
      .post('/api/intelligence/scrape')
      .set('x-account-id', 'org-2');
    expect(orgTwoOk.status).toBe(200);
  });
});
