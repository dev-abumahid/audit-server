import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';

vi.mock('../../app/lib/prisma.js', () => ({
  prisma: {
    externalOrgMember: { findUnique: vi.fn() },
  },
}));

import authExternal from '../../app/middlewares/auth_external.js';
import { prisma } from '../../app/lib/prisma.js';

const externalOrgMemberDb = vi.mocked(prisma.externalOrgMember.findUnique);

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

const ACTIVE_MEMBER = {
  id: 'ext-1',
  organizationId: 'org-1',
  email: 'external@test.com',
  fullName: null,
  role: 'LIGHT_USER',
  isActive: true,
  expiresAt: null,
};

describe('authExternal middleware (issue #55 slice 5)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls next(AppError 401) when no token is provided', async () => {
    const req = { headers: {}, cookies: {} } as unknown as Request;
    const next = makeNext();

    await authExternal()(req, makeRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
  });

  it('calls next(AppError 401) when the token is tampered', async () => {
    const req = {
      headers: { authorization: 'Bearer invalid.token.here' },
      cookies: {},
    } as unknown as Request;
    const next = makeNext();

    await authExternal()(req, makeRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
  });

  it('rejects a valid internal (account) JWT — the type discriminator must not accept it', async () => {
    // Same secret, but shaped like a normal internal login token (no `type`
    // field), the exact scenario JWT.ts's generateExternalAccessToken docstring
    // warns about — an internal token replayed against an external route.
    const token = makeToken({ accountId: 'acc-1', role: 'ORGANIZATION', email: 'o@test.com' });
    const req = {
      headers: { authorization: `Bearer ${token}` },
      cookies: {},
    } as unknown as Request;
    const next = makeNext();

    await authExternal()(req, makeRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
    expect(externalOrgMemberDb).not.toHaveBeenCalled();
  });

  it('calls next(AppError 401) when the external member no longer exists', async () => {
    const token = makeToken({ externalOrgMemberId: 'ext-1', type: 'EXTERNAL_ORG_MEMBER' });
    const req = {
      headers: { authorization: `Bearer ${token}` },
      cookies: {},
    } as unknown as Request;
    const next = makeNext();

    externalOrgMemberDb.mockResolvedValue(null);

    await authExternal()(req, makeRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
  });

  it('calls next(AppError 401) when the external member has been deactivated', async () => {
    const token = makeToken({ externalOrgMemberId: 'ext-1', type: 'EXTERNAL_ORG_MEMBER' });
    const req = {
      headers: { authorization: `Bearer ${token}` },
      cookies: {},
    } as unknown as Request;
    const next = makeNext();

    externalOrgMemberDb.mockResolvedValue({ ...ACTIVE_MEMBER, isActive: false } as never);

    await authExternal()(req, makeRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
  });

  it('calls next(AppError 401) when the external member has expired (time-boxed access)', async () => {
    const token = makeToken({ externalOrgMemberId: 'ext-1', type: 'EXTERNAL_ORG_MEMBER' });
    const req = {
      headers: { authorization: `Bearer ${token}` },
      cookies: {},
    } as unknown as Request;
    const next = makeNext();

    externalOrgMemberDb.mockResolvedValue({
      ...ACTIVE_MEMBER,
      expiresAt: new Date(Date.now() - 1000),
    } as never);

    await authExternal()(req, makeRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
  });

  it('sets req.externalMember and calls next() for a live external member', async () => {
    const token = makeToken({ externalOrgMemberId: 'ext-1', type: 'EXTERNAL_ORG_MEMBER' });
    const req = {
      headers: { authorization: `Bearer ${token}` },
      cookies: {},
    } as unknown as Request;
    const next = makeNext();

    externalOrgMemberDb.mockResolvedValue({
      ...ACTIVE_MEMBER,
      organization: { id: 'org-1', anchorAccountId: 'anchor-1' },
    } as never);

    await authExternal()(req, makeRes(), next);

    expect(next).toHaveBeenCalledWith();
    expect(req.externalMember).toEqual({
      externalOrgMemberId: 'ext-1',
      organizationId: 'anchor-1',
      orgId: 'org-1',
      role: 'LIGHT_USER',
    });
  });

  it('accepts a token from the external_access_token cookie when the header is absent', async () => {
    const token = makeToken({ externalOrgMemberId: 'ext-1', type: 'EXTERNAL_ORG_MEMBER' });
    const req = {
      headers: {},
      cookies: { external_access_token: token },
    } as unknown as Request;
    const next = makeNext();

    externalOrgMemberDb.mockResolvedValue({
      ...ACTIVE_MEMBER,
      organization: { id: 'org-1', anchorAccountId: 'anchor-1' },
    } as never);

    await authExternal()(req, makeRes(), next);

    expect(next).toHaveBeenCalledWith();
    expect(req.externalMember?.externalOrgMemberId).toBe('ext-1');
  });
});
