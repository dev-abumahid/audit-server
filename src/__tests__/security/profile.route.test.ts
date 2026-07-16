import { describe, expect, it, vi } from 'vitest';

// profile.route.ts calls auth(...) once at import time to build its middleware chain.
// Spy on it to verify which roles the route is actually wired to accept (ticket #48:
// this route used to be gated behind auth('USER') alone, a role no account can ever
// have, making the route permanently unreachable).
const authSpy = vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next());
vi.mock('../../app/middlewares/auth.js', () => ({ default: authSpy }));

describe('profile route auth wiring (ticket #48)', () => {
  it('gates PATCH / behind ADMIN and ORGANIZATION, not the unreachable USER role', async () => {
    await import('../../app/modules/profile/profile.route.js');

    expect(authSpy).toHaveBeenCalledWith('ADMIN', 'ORGANIZATION');
    expect(authSpy).not.toHaveBeenCalledWith('USER');
  });
});
