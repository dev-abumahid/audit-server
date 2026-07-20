import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import globalErrorHandler from '../../app/middlewares/global_error_handler.js';

// profile.route.ts parses the multipart `data` field as JSON before handing
// off to validation/the controller (follow-up to #120: the same unguarded
// JSON.parse pattern fixed in template.route.ts also exists here, and had
// no try/catch — malformed `data` crashed with an unhandled SyntaxError
// instead of a clean 400). Auth and the controller are mocked out so these
// tests exercise only the parsing middleware and its interaction with the
// shared global error handler.
//
// authMiddlewareSpy (not authFactorySpy) is what the test checks was
// invoked: auth('ADMIN', 'ORGANIZATION') itself only runs once per route,
// at module-import time, to build the middleware chain — asserting on that
// factory call doesn't prove auth ran on the request that was just sent.
// The returned middleware function, by contrast, only runs when a real
// request actually reaches this route's chain, so asserting it fired
// during a specific test's request is what actually catches auth being
// removed from the route.
const authMiddlewareSpy = vi.fn((_req: unknown, _res: unknown, next: () => void) => next());
const authFactorySpy = vi.fn(() => authMiddlewareSpy);
vi.mock('../../app/middlewares/auth.js', () => ({ default: authFactorySpy }));

vi.mock('../../app/modules/profile/profile.controller.js', () => ({
  profile_controller: {
    update_profile: (
      _req: unknown,
      res: { status: (c: number) => { json: (b: unknown) => void } },
    ) => res.status(200).json({ success: true }),
  },
}));

// Validation is mocked out too — these tests care about whether malformed
// JSON in `data` is caught before it ever reaches validation, not about
// validation's own behavior on well-formed bodies.
vi.mock('../../app/middlewares/request_validator.js', () => ({
  default: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

async function buildApp() {
  const { default: profileRouter } = await import('../../app/modules/profile/profile.route.js');
  const app = express();
  app.use('/profile', profileRouter);
  app.use(globalErrorHandler);
  return app;
}

describe('profile route JSON.parse error handling (follow-up to #120)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('PATCH / (update_profile)', () => {
    it('returns a clean 400 for malformed JSON in the data field, after auth ran', async () => {
      const app = await buildApp();

      const res = await request(app).patch('/profile').field('data', '{not valid json');

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toMatch(/invalid json/i);
      expect(res.body).not.toHaveProperty('err');
      expect(res.body.stack).toBeFalsy();
      // Proves auth('ADMIN', 'ORGANIZATION') is still wired ahead of the
      // parsing middleware on this route, not just present somewhere in
      // the file.
      expect(authMiddlewareSpy).toHaveBeenCalled();
    });

    it('returns a clean 400 for an unterminated JSON object in the data field', async () => {
      const app = await buildApp();

      const res = await request(app).patch('/profile').field('data', '{"fullName": ');

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toMatch(/invalid json/i);
    });

    it('still succeeds for well-formed JSON in the data field', async () => {
      const app = await buildApp();

      const res = await request(app)
        .patch('/profile')
        .field('data', JSON.stringify({ fullName: 'Jane Doe' }));

      expect(res.status).toBe(200);
      expect(authMiddlewareSpy).toHaveBeenCalled();
    });
  });
});
