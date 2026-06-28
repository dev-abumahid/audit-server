import { describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import globalErrorHandler from '../../app/middlewares/global_error_handler.js';
import { AppError } from '../../app/utils/app_error.js';

// Helper that captures the response correctly
function runHandler(err: Error) {
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

  globalErrorHandler(err, {} as Request, res, vi.fn() as unknown as NextFunction);
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
    it('returns 400 with a clear message for LIMIT_FILE_SIZE', () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const multer = require('multer');
      const err = new multer.MulterError('LIMIT_FILE_SIZE');

      const { statusCode, body } = runHandler(err);
      expect(statusCode).toBe(400);
      expect(body.message).toMatch(/10 MB/i);
      expect(body).not.toHaveProperty('err');
    });
  });
});
