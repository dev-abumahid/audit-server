import cors from 'cors';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

/**
 * Frontend deploy moved off the VPS-only globalriskcore.com hosting onto a
 * new S3+CloudFront setup, initially serving from qiyrix.com (the forward
 * brand domain) while the globalriskcore.com DNS cutover is blocked on an
 * unidentified third-party AWS account owning that domain's existing
 * CloudFront alias. Rebuilds app.ts's real cors() config (same convention as
 * app.helmet.test.ts / app.session-store.test.ts) rather than booting the
 * full app, which needs a live DB/session secret.
 */
function buildApp() {
  const app = express();
  app.use(
    cors({
      origin: [
        'http://localhost:5173',
        'https://globalriskcore.com',
        'https://qiyrix.com',
        'https://www.qiyrix.com',
      ],
      methods: ['GET', 'POST', 'PATCH', 'DELETE', 'PUT'],
      credentials: true,
    }),
  );
  app.get('/ping', (_req, res) => res.status(200).json({ ok: true }));
  return app;
}

describe('app.ts CORS allowlist', () => {
  it('allows the qiyrix.com origin, with credentials still enabled', async () => {
    const app = buildApp();
    const res = await request(app).get('/ping').set('Origin', 'https://qiyrix.com');

    expect(res.headers['access-control-allow-origin']).toBe('https://qiyrix.com');
    // Session cookies only reach the browser's fetch/XHR when the server
    // echoes this header back -- credentials: true alone isn't enough to
    // prove that end to end, so assert it explicitly rather than just
    // trusting the config object wasn't touched.
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('allows the www.qiyrix.com origin', async () => {
    const app = buildApp();
    const res = await request(app).get('/ping').set('Origin', 'https://www.qiyrix.com');

    expect(res.headers['access-control-allow-origin']).toBe('https://www.qiyrix.com');
  });

  it('still allows the existing globalriskcore.com origin', async () => {
    const app = buildApp();
    const res = await request(app).get('/ping').set('Origin', 'https://globalriskcore.com');

    expect(res.headers['access-control-allow-origin']).toBe('https://globalriskcore.com');
  });

  it('does not allow an arbitrary unlisted origin', async () => {
    const app = buildApp();
    const res = await request(app).get('/ping').set('Origin', 'https://evil.example.com');

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
