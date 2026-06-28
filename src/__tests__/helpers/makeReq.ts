import type { Request } from 'express';

export const ORG_A = 'org-a-00000000-0000-0000-0000-000000000001';
export const ORG_B = 'org-b-00000000-0000-0000-0000-000000000002';

/**
 * Returns a minimal Express Request-like object for unit testing service
 * functions. Override any field via the `overrides` argument.
 *
 * Defaults to a verified ORGANIZATION user belonging to ORG_A.
 */
export function makeReq(
  overrides: Partial<Request> & { user?: Record<string, unknown> } = {},
): Request {
  const { user, ...rest } = overrides;
  return {
    user: {
      accountId: ORG_A,
      role: 'ORGANIZATION',
      email: 'orga@test.com',
      ...user,
    },
    params: {},
    body: {},
    query: {},
    headers: {},
    cookies: {},
    ...rest,
  } as unknown as Request;
}
