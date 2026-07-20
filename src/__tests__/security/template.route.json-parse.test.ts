import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import globalErrorHandler from '../../app/middlewares/global_error_handler.js';

// template.route.ts parses the multipart `data` field as JSON before handing
// off to validation/the controller (ticket #120: that JSON.parse had no
// try/catch, so a malformed `data` field crashed with an unhandled exception
// instead of a clean 400). Auth and the controller are mocked out so these
// tests exercise only the parsing middleware and its interaction with the
// shared global error handler.
//
// authMiddlewareSpy (not authFactorySpy) is what each test checks was
// invoked: auth('ORGANIZATION') itself only runs once per route, at
// module-import time, to build the middleware chain — asserting on that
// factory call doesn't prove auth ran on the request that was just sent,
// and doesn't distinguish this route's auth() call from any of the other
// 6 routes in the same file that also call auth('ORGANIZATION'). The
// returned middleware function, by contrast, only runs when a real
// request actually reaches this route's chain, so asserting it fired
// during a specific test's request is what actually catches auth being
// removed from that route.
const authMiddlewareSpy = vi.fn((_req: unknown, _res: unknown, next: () => void) => next());
const authFactorySpy = vi.fn(() => authMiddlewareSpy);
vi.mock('../../app/middlewares/auth.js', () => ({ default: authFactorySpy }));

vi.mock('../../app/modules/template/template.controller.js', () => ({
  template_controller: {
    get_all_template: (
      _req: unknown,
      res: { status: (c: number) => { json: (b: unknown) => void } },
    ) => res.status(200).json({ success: true }),
    create_template: (
      _req: unknown,
      res: { status: (c: number) => { json: (b: unknown) => void } },
    ) => res.status(200).json({ success: true }),
    update_template: (
      _req: unknown,
      res: { status: (c: number) => { json: (b: unknown) => void } },
    ) => res.status(200).json({ success: true }),
    get_single_template: (
      _req: unknown,
      res: { status: (c: number) => { json: (b: unknown) => void } },
    ) => res.status(200).json({ success: true }),
    update_or_create_new_page: vi.fn(),
    delete_template_page_by_id: vi.fn(),
    update_or_delete_new_question: vi.fn(),
    delete_page_question_by_id: vi.fn(),
    add_template_access_member: vi.fn(),
    remove_template_access_member: vi.fn(),
    delete_template: vi.fn(),
  },
}));

// Validation is mocked out too — these tests care about whether malformed
// JSON in `data` is caught before it ever reaches validation, not about
// validation's own behavior on well-formed bodies.
vi.mock('../../app/middlewares/request_validator.js', () => ({
  default: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

async function buildApp() {
  const { default: templateRouter } = await import('../../app/modules/template/template.route.js');
  const app = express();
  app.use('/templates', templateRouter);
  app.use(globalErrorHandler);
  return app;
}

describe('template route JSON.parse error handling (ticket #120)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('POST / (create_template)', () => {
    it('returns a clean 400 for malformed JSON in the data field, after auth ran', async () => {
      const app = await buildApp();

      const res = await request(app).post('/templates').field('data', '{not valid json');

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toMatch(/invalid json/i);
      expect(res.body).not.toHaveProperty('err');
      expect(res.body.stack).toBeFalsy();
      // Proves auth('ORGANIZATION') is still wired ahead of the parsing
      // middleware on this route, not just present somewhere in the file.
      // (authFactorySpy itself isn't asserted here: the route module is
      // only evaluated once per test file thanks to import caching, so
      // the factory call only happens on the very first buildApp() call
      // and would be gone from every later test's cleared mock history.)
      expect(authMiddlewareSpy).toHaveBeenCalled();
    });

    it('still succeeds for well-formed JSON in the data field', async () => {
      const app = await buildApp();

      const res = await request(app)
        .post('/templates')
        .field('data', JSON.stringify({ title: 'Fire drill' }));

      expect(res.status).toBe(200);
      expect(authMiddlewareSpy).toHaveBeenCalled();
    });
  });

  describe('PATCH /:id (update_template)', () => {
    it('returns a clean 400 for malformed JSON in the data field, after auth ran', async () => {
      const app = await buildApp();

      const res = await request(app).patch('/templates/abc123').field('data', '{"unterminated": ');

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toMatch(/invalid json/i);
      expect(res.body).not.toHaveProperty('err');
      expect(res.body.stack).toBeFalsy();
      // Proves auth('ORGANIZATION') is still wired ahead of the parsing
      // middleware on this route, not just present somewhere in the file.
      // (authFactorySpy itself isn't asserted here: the route module is
      // only evaluated once per test file thanks to import caching, so
      // the factory call only happens on the very first buildApp() call
      // and would be gone from every later test's cleared mock history.)
      expect(authMiddlewareSpy).toHaveBeenCalled();
    });

    it('still succeeds for well-formed JSON in the data field', async () => {
      const app = await buildApp();

      const res = await request(app)
        .patch('/templates/abc123')
        .field('data', JSON.stringify({ title: 'Updated' }));

      expect(res.status).toBe(200);
      expect(authMiddlewareSpy).toHaveBeenCalled();
    });
  });
});
