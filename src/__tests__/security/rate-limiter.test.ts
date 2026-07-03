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
 *                      /forget-password, /reset-password        — sensitiveAuthLimiter, 10/15min
 *                      GET /me                                  — sessionCheckLimiter, 500/15min
 *                      PUT /verify-link, /change-password        — no auth-specific limiter
 *
 * Every account route still sits under apiLimiter too (mounted broadly on
 * /api in app.ts), so sensitive routes are double-counted: the tight
 * per-route limiter (10) will always bind before the broad one (300) does.
 * This suite reconstructs that real shape — using the actual max=10 for the
 * sensitive limiter (small enough to test directly) and scaled-down but
 * proportionate maxes for the broad/session limiters (300/500 would just be
 * slow to literally exhaust) — with an in-memory store instead of Redis.
 */
function buildApp({ apiMax, sessionMax }: { apiMax: number; sessionMax: number }) {
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

  app.use('/api', apiLimiter);

  app.post('/api/auth/sign-in', sensitiveAuthLimiter, (_req, res) =>
    res.status(200).json({ ok: true }),
  );
  app.put('/api/auth/verify-otp', sensitiveAuthLimiter, (_req, res) =>
    res.status(200).json({ ok: true }),
  );
  app.get('/api/auth/me', sessionCheckLimiter, (_req, res) => res.status(200).json({ ok: true }));
  // No auth-specific limiter on these two — only the broad apiLimiter applies
  app.put('/api/auth/verify-link', (_req, res) => res.status(200).json({ ok: true }));
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
    // instance as middleware on sign-up/sign-in/verify-otp/resend-otp/forget-password/
    // reset-password — so attempts across different sensitive endpoints share one
    // counter. This is the correct anti-brute-force design (an attacker can't reset
    // their budget by switching endpoints), not a bug — this test locks it in.
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

    expect(signInBlocked.status).toBe(429);
    expect(otpBlocked.status).toBe(429);
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

  it('routes with no auth-specific limiter still fall under the broad apiLimiter', async () => {
    // verify-link and change-password have no per-route limiter in account.route.ts —
    // apiLimiter (mounted on all of /api in app.ts) is the only thing protecting them.
    const app = buildApp({ apiMax: 2, sessionMax: 100 });

    await request(app).put('/api/auth/verify-link');
    await request(app).put('/api/auth/change-password');
    const thirdRes = await request(app).put('/api/auth/verify-link');

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
