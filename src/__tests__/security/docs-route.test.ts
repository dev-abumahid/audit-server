import express from 'express';
import request from 'supertest';
import swaggerJSDoc from 'swagger-jsdoc';
import swaggerUi from 'swagger-ui-express';
import { describe, expect, it } from 'vitest';
import { isDocsRouteEnabled } from '../../app/utils/docs_visibility.js';

/**
 * Real app.ts can't be imported directly in a lightweight test -- it does
 * heavy eager work at module load (Redis-backed rate limiters, a hard
 * process.exit-via-throw if SESSION_SECRET/AI_INTERNAL_SECRET are unset).
 * Same approach as rate-limiter.test.ts: reconstruct the shape under test
 * (the /docs conditional mount, issue #38) in a standalone app instead --
 * but wired against the real isDocsRouteEnabled import, not a duplicated
 * `env !== 'production'` check, so a regression to the actual predicate
 * app.ts uses is caught here too, not just a copy of it.
 */
function buildApp(env: string | undefined) {
  const app = express();

  if (isDocsRouteEnabled(env)) {
    const swaggerSpec = swaggerJSDoc({
      definition: { openapi: '3.0.0', info: { title: 'test', version: '1.0' } },
      apis: [],
    });
    app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
  }

  return app;
}

describe('isDocsRouteEnabled', () => {
  it('is false for production', () => {
    expect(isDocsRouteEnabled('production')).toBe(false);
  });

  it('is true for development, unset, and any other non-production value', () => {
    expect(isDocsRouteEnabled('development')).toBe(true);
    expect(isDocsRouteEnabled(undefined)).toBe(true);
    expect(isDocsRouteEnabled('staging')).toBe(true);
  });
});

describe('/docs route mounting (issue #38)', () => {
  it('is not mounted at all when NODE_ENV=production', async () => {
    const app = buildApp('production');

    const res = await request(app).get('/docs/');

    expect(res.status).toBe(404);
  });

  it('is mounted in development', async () => {
    const app = buildApp('development');

    const res = await request(app).get('/docs/');

    expect(res.status).toBe(200);
  });

  it('is mounted when NODE_ENV is unset (local/dev default)', async () => {
    const app = buildApp(undefined);

    const res = await request(app).get('/docs/');

    expect(res.status).toBe(200);
  });

  it('is mounted in any other non-production environment (e.g. staging)', async () => {
    const app = buildApp('staging');

    const res = await request(app).get('/docs/');

    expect(res.status).toBe(200);
  });
});
