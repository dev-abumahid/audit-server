import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import RequestValidator from '../../app/middlewares/request_validator.js';
import { inspection_validations } from '../../app/modules/inspection/inspection.validation.js';

/**
 * Issue #279: `create_inspection_into_db` read `body.inspectorProfileId`,
 * but the `create_inspection` Zod schema never declared that field. Zod's
 * default unknown-key stripping (`request_validator.ts`'s
 * `schema.parseAsync`) meant `req.body.inspectorProfileId` was always
 * `undefined` by the time the service saw it, no matter what the client
 * sent — a unit test calling the service function directly with a
 * hand-built `req.body` wouldn't have caught this, since it bypasses the
 * validator entirely. This exercises the actual middleware chain (real
 * express.json + the real RequestValidator + the real schema) the same way
 * json-body-limit.test.ts exercises app.ts's body-parser config, to confirm
 * the field now survives validation end to end.
 */
function buildApp() {
  const app = express();
  app.use(express.json());
  app.post(
    '/inspection',
    RequestValidator(inspection_validations.create_inspection),
    (req, res) => {
      res.status(200).json({ body: req.body });
    },
  );
  return app;
}

describe('POST /inspection — inspectorProfileId survives request validation (issue #279)', () => {
  const templateId = '11111111-1111-4111-8111-111111111111';
  const siteId = '22222222-2222-4222-8222-222222222222';
  const inspectorProfileId = '33333333-3333-4333-8333-333333333333';

  it('passes inspectorProfileId through to req.body when supplied', async () => {
    const app = buildApp();

    const res = await request(app)
      .post('/inspection')
      .set('Content-Type', 'application/json')
      .send({ templateId, siteId, inspectorProfileId, questionAnswers: [] });

    expect(res.status).toBe(200);
    expect(res.body.body.inspectorProfileId).toBe(inspectorProfileId);
  });

  it('leaves inspectorProfileId undefined when omitted, without erroring', async () => {
    const app = buildApp();

    const res = await request(app)
      .post('/inspection')
      .set('Content-Type', 'application/json')
      .send({ templateId, siteId, questionAnswers: [] });

    expect(res.status).toBe(200);
    expect(res.body.body.inspectorProfileId).toBeUndefined();
  });

  it('still rejects the request (400-shaped error, handled by next(err)) when inspectorProfileId is not a valid uuid', async () => {
    const app = buildApp();
    // Express only recognizes a 4-arg function as error-handling middleware
    // — dropping `next` here would make express treat this as regular
    // middleware and never invoke it for the error passed via next(err).
    app.use(
      (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        res.status(400).json({ error: (err as Error).message });
      },
    );

    const res = await request(app)
      .post('/inspection')
      .set('Content-Type', 'application/json')
      .send({ templateId, siteId, inspectorProfileId: 'not-a-uuid', questionAnswers: [] });

    expect(res.status).toBe(400);
  });
});
