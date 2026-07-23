import { describe, expect, it, vi } from 'vitest';

// account.route.ts calls auth(...) at import time to build each route's middleware
// chain, and every existing authenticated route here uses the identical role tuple
// ('USER', 'ADMIN', 'ORGANIZATION') -- so a plain `toHaveBeenCalledWith` spy on
// auth() can't tell whether /logout specifically got gated, only that *some* route
// in this file did. Instead, tag each middleware instance auth() returns with the
// roles it was built for, then look up the actual registered route (via Express's
// own router.stack) for POST /logout and check whether an auth-tagged middleware
// is present in its chain (issue #19: the spec's suggested route wires
// auth('USER', 'ADMIN', 'ORGANIZATION') in front of the logout handler).
const authSpy = vi.fn((...roles: string[]) => {
  const middleware = (_req: unknown, _res: unknown, next: () => void) => next();
  (middleware as { __roles?: string[] }).__roles = roles;
  return middleware;
});
vi.mock('../../app/middlewares/auth.js', () => ({ default: authSpy }));

describe('account route /logout auth wiring (issue #19)', () => {
  it('gates POST /logout behind auth(USER, ADMIN, ORGANIZATION)', async () => {
    const { default: accountRouter } = await import('../../app/modules/account/account.route.js');

    type ExpressLayer = {
      route?: {
        path: string;
        methods: Record<string, boolean>;
        stack: { handle: (...args: unknown[]) => unknown }[];
      };
    };

    const logoutLayer = (accountRouter.stack as ExpressLayer[]).find(
      (layer) => layer.route?.path === '/logout' && layer.route.methods.post,
    );
    expect(logoutLayer, 'POST /logout route was not registered on accountRouter').toBeTruthy();

    const middlewares = logoutLayer!.route!.stack.map((s) => s.handle);
    const authMiddleware = middlewares.find(
      (fn): fn is typeof fn & { __roles: string[] } => '__roles' in fn,
    );

    expect(
      authMiddleware,
      'POST /logout has no auth(...) middleware in its chain -- it is publicly reachable',
    ).toBeTruthy();
    expect(authMiddleware!.__roles).toEqual(['USER', 'ADMIN', 'ORGANIZATION']);
  });
});
