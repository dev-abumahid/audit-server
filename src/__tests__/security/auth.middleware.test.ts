import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';

// vi.mock is hoisted — factory must not reference variables declared below it
vi.mock('../../app/lib/prisma.js', () => ({
  prisma: {
    account: { findUnique: vi.fn() },
  },
}));

// Import after mock is registered
import auth from '../../app/middlewares/auth.js';
import { prisma } from '../../app/lib/prisma.js';

const mockFindUnique = vi.mocked(prisma.account.findUnique);

const TEST_SECRET = process.env.ACCESS_TOKEN!; // set in setup.ts

function makeToken(payload: object, secret = TEST_SECRET) {
  return jwt.sign(payload, secret, { expiresIn: '1h' });
}

function makeRes(): Response {
  return {} as Response;
}

function makeNext(): NextFunction {
  return vi.fn() as unknown as NextFunction;
}

describe('auth middleware (ticket #8)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls next(AppError 401) when no token is provided', async () => {
    const req = { headers: {}, cookies: {} } as unknown as Request;
    const next = makeNext();

    await auth('ORGANIZATION')(req, makeRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
  });

  it('calls next(AppError 401) when token is invalid / tampered', async () => {
    const req = {
      headers: { authorization: 'Bearer invalid.token.here' },
      cookies: {},
    } as unknown as Request;
    const next = makeNext();

    await auth('ORGANIZATION')(req, makeRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
  });

  it('calls next(AppError 401) when account is not yet verified', async () => {
    const token = makeToken({ accountId: 'acc-1', role: 'ORGANIZATION', email: 'a@test.com' });
    const req = {
      headers: { authorization: `Bearer ${token}` },
      cookies: {},
    } as unknown as Request;
    const next = makeNext();

    mockFindUnique.mockResolvedValue({ isAccountVerified: false } as unknown as never);

    await auth('ORGANIZATION')(req, makeRes(), next);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 401,
        message: expect.stringMatching(/verify your email/i),
      }),
    );
  });

  it('calls next(AppError 401) when role does not match', async () => {
    const token = makeToken({ accountId: 'acc-1', role: 'USER', email: 'u@test.com' });
    const req = {
      headers: { authorization: `Bearer ${token}` },
      cookies: {},
    } as unknown as Request;
    const next = makeNext();

    // Account is verified — but role is wrong
    mockFindUnique.mockResolvedValue({ isAccountVerified: true } as unknown as never);

    await auth('ORGANIZATION')(req, makeRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
  });

  it('sets req.user and calls next() for a valid, verified token with correct role', async () => {
    const payload = { accountId: 'acc-1', role: 'ORGANIZATION', email: 'org@test.com' };
    const token = makeToken(payload);
    const req = {
      headers: { authorization: `Bearer ${token}` },
      cookies: {},
    } as unknown as Request;
    const next = makeNext();

    mockFindUnique.mockResolvedValue({ isAccountVerified: true } as unknown as never);

    await auth('ORGANIZATION')(req, makeRes(), next);

    expect(next).toHaveBeenCalledWith(); // next() with no args = success
    expect((req as any).user).toMatchObject({ accountId: 'acc-1', role: 'ORGANIZATION' });
  });

  it('strips the "Bearer " prefix before verifying (ticket #28)', async () => {
    const payload = { accountId: 'acc-3', role: 'ORGANIZATION', email: 'org3@test.com' };
    const token = makeToken(payload);
    const req = {
      headers: { authorization: `Bearer ${token}` },
      cookies: {},
    } as unknown as Request;
    const next = makeNext();

    mockFindUnique.mockResolvedValue({ isAccountVerified: true } as unknown as never);

    await auth('ORGANIZATION')(req, makeRes(), next);

    // Would fail with a JsonWebTokenError (401) if the raw "Bearer <token>" string
    // had been passed to jwt.verify instead of the extracted token.
    expect(next).toHaveBeenCalledWith();
    expect((req as any).user).toMatchObject({ accountId: 'acc-3' });
  });

  it('accepts a token from the access_token cookie when header is absent', async () => {
    const payload = { accountId: 'acc-2', role: 'ORGANIZATION', email: 'org2@test.com' };
    const token = makeToken(payload);
    const req = {
      headers: {},
      cookies: { access_token: token },
    } as unknown as Request;
    const next = makeNext();

    mockFindUnique.mockResolvedValue({ isAccountVerified: true } as unknown as never);

    await auth('ORGANIZATION')(req, makeRes(), next);

    expect(next).toHaveBeenCalledWith();
    expect((req as any).user).toMatchObject({ accountId: 'acc-2' });
  });

  it('falls back to the cookie when the Authorization header is present but malformed', async () => {
    const payload = { accountId: 'acc-4', role: 'ORGANIZATION', email: 'org4@test.com' };
    const token = makeToken(payload);
    const req = {
      // A stale/non-standard header (no "Bearer " prefix) must not shadow a valid cookie
      headers: { authorization: 'garbage-not-a-bearer-header' },
      cookies: { access_token: token },
    } as unknown as Request;
    const next = makeNext();

    mockFindUnique.mockResolvedValue({ isAccountVerified: true } as unknown as never);

    await auth('ORGANIZATION')(req, makeRes(), next);

    expect(next).toHaveBeenCalledWith();
    expect((req as any).user).toMatchObject({ accountId: 'acc-4' });
  });

  it('calls next(AppError 401) when the header is malformed and no cookie exists', async () => {
    const req = {
      headers: { authorization: 'garbage-not-a-bearer-header' },
      cookies: {},
    } as unknown as Request;
    const next = makeNext();

    await auth('ORGANIZATION')(req, makeRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
  });

  it('checks the DB exactly once per request (no N+1)', async () => {
    const token = makeToken({ accountId: 'acc-1', role: 'ORGANIZATION', email: 'o@test.com' });
    const req = {
      headers: { authorization: `Bearer ${token}` },
      cookies: {},
    } as unknown as Request;

    mockFindUnique.mockResolvedValue({ isAccountVerified: true } as unknown as never);

    await auth('ORGANIZATION')(req, makeRes(), makeNext());

    expect(mockFindUnique).toHaveBeenCalledTimes(1);
  });
});
