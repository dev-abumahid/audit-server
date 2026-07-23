import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import verify_ai_internal_secret from '../../app/middlewares/verify_ai_internal_secret.js';

// Set in src/__tests__/setup.ts (runs before any module import, unlike a
// local process.env assignment here which would run after ES module
// imports are hoisted — too late for configs/index.ts to have picked it up).
const TEST_SECRET = 'test-ai-internal-secret';

function makeReq(headers: Record<string, string | undefined>): Request {
  return { headers } as unknown as Request;
}

function makeRes(): Response {
  return {} as Response;
}

function makeNext(): NextFunction {
  return vi.fn() as unknown as NextFunction;
}

describe('verify_ai_internal_secret middleware (#96)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls next() when the header matches the shared secret', () => {
    const next = makeNext();
    verify_ai_internal_secret(makeReq({ 'x-internal-secret': TEST_SECRET }), makeRes(), next);
    expect(next).toHaveBeenCalledWith();
  });

  it('throws 401 when the header is missing', () => {
    const next = makeNext();
    expect(() => verify_ai_internal_secret(makeReq({}), makeRes(), next)).toThrow(
      expect.objectContaining({ statusCode: 401 }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('throws 401 when the header does not match the shared secret', () => {
    const next = makeNext();
    expect(() =>
      verify_ai_internal_secret(makeReq({ 'x-internal-secret': 'wrong' }), makeRes(), next),
    ).toThrow(expect.objectContaining({ statusCode: 401 }));
    expect(next).not.toHaveBeenCalled();
  });

  // A repeated X-Internal-Secret header arrives as string[]. The constant-time
  // compare only accepts a string, so the typeof guard must reject the array
  // with a clean 401 rather than letting a non-string reach the comparator.
  it('throws 401 when the header is array-valued (repeated header), not a string', () => {
    const next = makeNext();
    const req = {
      headers: { 'x-internal-secret': [TEST_SECRET, TEST_SECRET] },
    } as unknown as Request;
    expect(() => verify_ai_internal_secret(req, makeRes(), next)).toThrow(
      expect.objectContaining({ statusCode: 401 }),
    );
    expect(next).not.toHaveBeenCalled();
  });
});
