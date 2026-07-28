import express from 'express';
import helmet from 'helmet';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

/**
 * Issue #275 (additional hardening found in the same audit pass) — app.ts
 * had no security-headers middleware at all. This rebuilds the relevant
 * slice of app.ts's real middleware order (json -> helmet, same as the
 * actual app.use(helmet()) placement right after the body-parsing
 * middleware) and asserts the standard headers helmet sets by default are
 * actually present on a response, the same way app.body-parsing.test.ts
 * verifies the body-parsing middleware order without booting the full app
 * (which needs a live DB/Redis/session secret).
 */
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(helmet());
  app.get('/ping', (req, res) => {
    res.status(200).json({ ok: true });
  });
  return app;
}

describe('app.ts security headers (helmet, issue #275)', () => {
  it('sets X-Content-Type-Options: nosniff on responses', async () => {
    const response = await request(buildApp()).get('/ping');

    expect(response.status).toBe(200);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });

  it('does not advertise the framework via X-Powered-By', async () => {
    const response = await request(buildApp()).get('/ping');

    expect(response.headers['x-powered-by']).toBeUndefined();
  });
});
