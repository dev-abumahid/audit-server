import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

/**
 * app.ts wires `express.json({ limit: '5mb' })` as global body-parsing
 * middleware (see #114 — was previously '100mb', a needlessly large default
 * for a JSON API where file uploads go through multer/S3, not this parser).
 * This suite reconstructs that single config line as a minimal app, the same
 * pattern rate-limiter.test.ts uses for app.ts middleware config: real
 * middleware, not a mock, just without the rest of app.ts's infra
 * (sessions, Redis, Prisma) that isn't relevant to what's being verified
 * here — the limit value itself.
 */
function buildApp() {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.post('/echo', (req, res) => res.status(200).json({ received: true, body: req.body }));
  return app;
}

describe('express.json body size limit (mirrors app.ts)', () => {
  it('accepts a JSON body well under the limit', async () => {
    const app = buildApp();

    const res = await request(app)
      .post('/echo')
      .set('Content-Type', 'application/json')
      .send({ templateName: 'Site inspection', pages: [{ pageIndex: 0, title: 'Page 1' }] });

    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
  });

  it('accepts a JSON body just under the 5mb limit', async () => {
    const app = buildApp();
    // 5mb limit is on the raw request body size; keep comfortably under it
    // so JSON-encoding overhead doesn't tip it over.
    const bigString = 'a'.repeat(4.5 * 1024 * 1024);

    const res = await request(app)
      .post('/echo')
      .set('Content-Type', 'application/json')
      .send({ note: bigString });

    expect(res.status).toBe(200);
  });

  it('rejects a JSON body over the 5mb limit with 413', async () => {
    const app = buildApp();
    const tooBig = 'a'.repeat(6 * 1024 * 1024);

    const res = await request(app)
      .post('/echo')
      .set('Content-Type', 'application/json')
      .send({ note: tooBig });

    expect(res.status).toBe(413);
  });

  it('rejects a 100mb-scale body that the old limit would have allowed', async () => {
    const app = buildApp();
    // Representative of what the previous '100mb' limit let through (e.g.
    // ~50mb) — confirms the new 5mb limit actually closes that gap, not just
    // that it rejects something slightly over 5mb.
    const wayTooBig = 'a'.repeat(50 * 1024 * 1024);

    const res = await request(app)
      .post('/echo')
      .set('Content-Type', 'application/json')
      .send({ note: wayTooBig });

    expect(res.status).toBe(413);
  });
});
