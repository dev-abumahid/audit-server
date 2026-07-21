import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

/**
 * Regression test for #136: app.ts used to mount `express.raw()` globally
 * right after `express.json()`, with nothing in the codebase ever reading
 * `req.body` as a raw Buffer (confirmed via grep across src/ — no Stripe-style
 * signature verification, no octet-stream consumers; the service-to-service
 * "webhook" routes in notification/ and knowledge_base/ take JSON bodies
 * validated by Zod, authenticated via the X-Internal-Secret header, not a
 * raw-body HMAC check).
 *
 * That dead middleware silently swallowed any request sent with
 * `Content-Type: application/octet-stream` (or another type express.raw()
 * matches) by converting its body into a Buffer *before* downstream
 * middleware/routes ever saw it — even though nothing downstream expected a
 * Buffer. This test rebuilds app.ts's real body-parsing middleware order
 * (json -> cookieParser -> urlencoded, no raw) and asserts an
 * octet-stream-typed request body is left alone rather than converted.
 */
function buildApp() {
  const app = express();
  app.use(express.json({ limit: '100mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.post('/echo', (req, res) => {
    res.status(200).json({
      isBuffer: Buffer.isBuffer(req.body),
      body: req.body,
    });
  });
  return app;
}

describe('app.ts body-parsing middleware (no dead express.raw())', () => {
  it('does not convert an application/octet-stream body into a raw Buffer', async () => {
    const response = await request(buildApp())
      .post('/echo')
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('some binary payload'));

    expect(response.status).toBe(200);
    expect(response.body.isBuffer).toBe(false);
  });

  it('still parses JSON bodies normally', async () => {
    const response = await request(buildApp())
      .post('/echo')
      .set('Content-Type', 'application/json')
      .send({ hello: 'world' });

    expect(response.status).toBe(200);
    expect(response.body.isBuffer).toBe(false);
    expect(response.body.body).toEqual({ hello: 'world' });
  });
});
