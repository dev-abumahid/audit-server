import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';

vi.mock('../../app/lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { logger } from '../../app/lib/logger.js';
import globalErrorHandler from '../../app/middlewares/global_error_handler.js';
import { AppError } from '../../app/utils/app_error.js';
import { markFileHandled } from '../../app/utils/upload_cleanup.js';

// Helper that captures the response correctly
function runHandler(err: Error, req: Partial<Request> = {}) {
  let capturedStatus: number = 0;
  let capturedBody: Record<string, unknown> = {};
  const res = {
    status(code: number) {
      capturedStatus = code;
      return this;
    },
    json(body: Record<string, unknown>) {
      capturedBody = body;
      return this;
    },
  } as unknown as Response;

  globalErrorHandler(err, req as Request, res, vi.fn() as unknown as NextFunction);
  return { statusCode: capturedStatus, body: capturedBody };
}

describe('global error handler (ticket #9)', () => {
  describe('raw err object is never exposed', () => {
    it('does not include err field for AppError', () => {
      const { body } = runHandler(new AppError('Not found', 404));
      expect(body).not.toHaveProperty('err');
    });

    it('does not include err field for generic Error', () => {
      const { body } = runHandler(new Error('Something broke'));
      expect(body).not.toHaveProperty('err');
    });

    it('does not include err field for ZodError', () => {
      const zodErr = new ZodError([{ code: 'custom', path: ['email'], message: 'Invalid email' }]);
      const { body } = runHandler(zodErr);
      expect(body).not.toHaveProperty('err');
    });

    it('never leaks stack trace outside development', () => {
      // NODE_ENV=test (set in setup.ts), so stack should be null
      const { body } = runHandler(new AppError('Oops', 500));
      expect(body.stack).toBeNull();
    });
  });

  describe('response shape', () => {
    it('returns success: false on all errors', () => {
      const { body } = runHandler(new AppError('Bad', 400));
      expect(body.success).toBe(false);
    });

    it('uses AppError statusCode', () => {
      const { statusCode } = runHandler(new AppError('Forbidden', 403));
      expect(statusCode).toBe(403);
    });

    it('returns 500 for unhandled Error', () => {
      const { statusCode } = runHandler(new Error('Unknown'));
      expect(statusCode).toBe(500);
    });

    // Issue #291 — an unrecognized Error (raw Prisma/driver error, etc.) used
    // to have its .message forwarded verbatim to the client on this branch,
    // regardless of environment. That message can carry file paths,
    // model/column/constraint names, or DB hostnames, so it must now be
    // replaced with the same fixed, safe message the handler already uses
    // everywhere else -- matching wrapAiServiceError's convention
    // (ai.service.ts) of logging full detail internally and only ever
    // exposing a generic message for errors the app didn't craft itself.
    it('does not leak a raw Prisma-style error message to the client (issue #291)', () => {
      const dbFailure = new Error(
        'Invalid `prisma.risk.create()` invocation: Unique constraint failed on fields: (`org_account_id`,`ref`) at postgres://user:hunter2@internal-db.prod:5432/aexa',
      );

      const { statusCode, body } = runHandler(dbFailure);

      expect(statusCode).toBe(500);
      expect(body.message).toBe('Something went wrong!');
      expect(JSON.stringify(body)).not.toContain('postgres://');
      expect(JSON.stringify(body)).not.toContain('hunter2');
    });

    it('still logs the real error server-side for a generic Error (issue #291)', () => {
      const dbFailure = new Error('ECONNREFUSED 10.0.0.5:5432');

      runHandler(dbFailure);

      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: dbFailure }),
        dbFailure.message,
      );
    });

    it('does not mask an AppError message with the generic fallback (issue #291 regression guard)', () => {
      const { statusCode, body } = runHandler(new AppError('Site not found', 404));

      expect(statusCode).toBe(404);
      expect(body.message).toBe('Site not found');
    });

    it('does not mask a ZodError-derived message with the generic fallback (issue #291 regression guard)', () => {
      const zodErr = new ZodError([{ code: 'custom', path: ['email'], message: 'Invalid email' }]);

      const { statusCode, body } = runHandler(zodErr);

      expect(statusCode).toBe(400);
      expect(body.message).toBe('Validation Error');
    });

    it('includes a human-readable message', () => {
      const { body } = runHandler(new AppError('Resource not found', 404));
      expect(body.message).toBe('Resource not found');
    });

    it('includes errorSources array', () => {
      const { body } = runHandler(new AppError('Bad request', 400));
      expect(Array.isArray(body.errorSources)).toBe(true);
    });
  });

  describe('multer file size error', () => {
    // uploader.ts's top-level multer `limits.fileSize` is set to the
    // largest per-mimetype bucket (video's 50 MB, see uploader.ts) so a
    // legitimate video upload isn't truncated mid-stream -- a smaller
    // per-type budget (e.g. images/PDF at 10 MB) is instead enforced by
    // enforceUploadSizeLimit, which throws its own AppError, not a
    // multer.MulterError, so it never reaches this branch.
    it('returns 400 with a clear message for LIMIT_FILE_SIZE', () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const multer = require('multer');
      const err = new multer.MulterError('LIMIT_FILE_SIZE');

      const { statusCode, body } = runHandler(err);
      expect(statusCode).toBe(400);
      expect(body.message).toMatch(/50 MB/i);
      expect(body).not.toHaveProperty('err');
    });
  });

  // aexa-server#305 — uploader.ts writes multipart uploads to local disk
  // before any downstream middleware/service runs. Previously the only
  // cleanup was inside uploadCloud (cloudinary.ts), reached only after a
  // *successful* hand-off, so any request that threw after multer but before
  // uploadCloud (a role-check throw in audit.service.ts/compliance.service.ts,
  // a JSON-parse failure in template.route.ts/profile.route.ts, a failed
  // validation, ...) leaked the local temp file forever.
  describe('temp file cleanup on error (aexa-server#305)', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'error-handler-cleanup-test-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    // fire-and-forget cleanup inside the handler is async (fs.promises.unlink);
    // give its microtask/I-O callback a turn before asserting on disk state.
    async function flush() {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    function writeTempFile(name: string) {
      const filePath = path.join(tmpDir, name);
      fs.writeFileSync(filePath, 'fake upload bytes');
      return { path: filePath };
    }

    it('deletes req.file.path when a role-check-style AppError reaches the handler', async () => {
      const file = writeTempFile('role-check-throw.pdf');

      // Simulates audit.service.ts/compliance.service.ts throwing from
      // assertCanWriteOrgResource after multer already wrote the file to disk.
      runHandler(new AppError('Forbidden', 403), { file } as Partial<Request>);
      await flush();

      expect(fs.existsSync(file.path)).toBe(false);
    });

    it('deletes req.file.path for a generic/unrecognized error too', async () => {
      const file = writeTempFile('json-parse-throw.pdf');

      // Simulates template.route.ts/profile.route.ts's JSON.parse catch
      // forwarding an AppError('Invalid JSON in request body', 400).
      runHandler(new AppError('Invalid JSON in request body', 400), {
        file,
      } as Partial<Request>);
      await flush();

      expect(fs.existsSync(file.path)).toBe(false);
    });

    it('deletes every file in req.files (array/fields multer modes)', async () => {
      const first = writeTempFile('multi-1.pdf');
      const second = writeTempFile('multi-2.pdf');

      runHandler(new AppError('Bad request', 400), {
        files: [first, second],
      } as unknown as Partial<Request>);
      await flush();

      expect(fs.existsSync(first.path)).toBe(false);
      expect(fs.existsSync(second.path)).toBe(false);
    });

    it('does not touch a file already marked handled (uploadCloud in flight/complete)', async () => {
      const file = writeTempFile('already-handled.pdf');
      markFileHandled(file);

      runHandler(new AppError('Unrelated downstream failure', 500), {
        file,
      } as Partial<Request>);
      await flush();

      expect(fs.existsSync(file.path)).toBe(true);
    });

    it('does not crash when no file was ever attached to the request', async () => {
      expect(() => runHandler(new AppError('Not found', 404), {})).not.toThrow();
      await flush();
    });
  });
});
