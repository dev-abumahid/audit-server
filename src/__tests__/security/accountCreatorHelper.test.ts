import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../app/lib/prisma.js', () => ({
  prisma: {
    account: {
      upsert: vi.fn(),
    },
  },
}));

import { prisma } from '../../app/lib/prisma.js';
import { accountCreatorHelper } from '../../app/passport-js/accountCreatorHelper.js';

describe('accountCreatorHelper (#167)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('never puts the bcrypt password hash on req.user, even when the OAuth email collides with an existing LOCAL account', async () => {
    // The full raw row a real (unselected) Prisma upsert would produce for a
    // collision with an existing LOCAL account -- includes a real bcrypt
    // hash, exactly the scenario the issue describes: an OAuth login for an
    // email that already has a LOCAL password-based account. The upsert mock
    // below applies the same `select` projection semantics Prisma itself
    // would, so this test actually exercises whether accountCreatorHelper
    // passes a `select` that excludes `password`, rather than trusting a
    // hand-picked mock return value.
    const rawAccountRow = {
      id: 'acc-1',
      email: 'collide@test.com',
      password: '$2b$10$realBcryptHashOfAnExistingLocalPassword',
      provider: 'LOCAL',
      role: 'ORGANIZATION',
      isAccountVerified: true,
      isDeleted: false,
      lastOtp: null,
      lastOtpSendingTime: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    (prisma.account.upsert as ReturnType<typeof vi.fn>).mockImplementation(
      ({ select }: { select?: Record<string, boolean> }) => {
        if (!select) return Promise.resolve(rawAccountRow);
        const projected: Record<string, unknown> = {};
        for (const key of Object.keys(select)) {
          if (select[key]) projected[key] = (rawAccountRow as Record<string, unknown>)[key];
        }
        return Promise.resolve(projected);
      },
    );

    const done = vi.fn();
    const profile = {
      displayName: 'Collide User',
      emails: [{ value: 'collide@test.com' }],
      photos: [{ value: 'https://example.com/photo.jpg' }],
    };

    await accountCreatorHelper(profile, done, 'GOOGLE');

    // The helper must have supplied a `select` at all (an unselected upsert
    // would return the raw row, including the hash).
    const upsertCallArgs = (prisma.account.upsert as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(upsertCallArgs.select).toBeDefined();
    expect(upsertCallArgs.select.password).toBeFalsy();
    expect(upsertCallArgs.include).toBeUndefined();

    // done() is called with (err, user) -- user becomes req.user.
    expect(done).toHaveBeenCalledTimes(1);
    const [err, user] = done.mock.calls[0];
    expect(err).toBeNull();
    expect(user).not.toHaveProperty('password');
    expect(user).not.toHaveProperty('lastOtp');
    expect(user).not.toHaveProperty('lastOtpSendingTime');
    // Sanity: id/email/role survive the projection -- customAccessTokenAndResponse.ts
    // reads req.user.id/email/role, so those must not silently disappear.
    expect(user).toMatchObject({ id: 'acc-1', email: 'collide@test.com', role: 'ORGANIZATION' });
  });

  it('rejects when the OAuth profile has no email, without touching prisma', async () => {
    const done = vi.fn();
    const profile = { displayName: 'No Email User', emails: [] };

    await accountCreatorHelper(profile, done, 'GITHUB');

    expect(prisma.account.upsert).not.toHaveBeenCalled();
    expect(done).toHaveBeenCalledTimes(1);
    const [err, user] = done.mock.calls[0];
    expect(err).toBeInstanceOf(Error);
    expect(user).toBeUndefined();
  });

  it('#286: rejects via done(err) when the matched account is soft-deleted, instead of authenticating it', async () => {
    // The upsert's `update: {}` branch matches a pre-existing Account by
    // email. If that account was soft-deleted, it must not be handed to
    // done() as a valid req.user -- mirrors login_user_into_db's isDeleted
    // guard (account.service.ts).
    (prisma.account.upsert as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'acc-2',
      email: 'deleted@test.com',
      role: 'ORGANIZATION',
      provider: 'GOOGLE',
      isAccountVerified: true,
      isDeleted: true,
    });

    const done = vi.fn();
    const profile = {
      displayName: 'Deleted User',
      emails: [{ value: 'deleted@test.com' }],
      photos: [{ value: 'https://example.com/photo.jpg' }],
    };

    await accountCreatorHelper(profile, done, 'GOOGLE');

    expect(done).toHaveBeenCalledTimes(1);
    const [err, user] = done.mock.calls[0];
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/deleted/i);
    expect(user).toBeUndefined();
  });

  it('does not reject an active (non-deleted) matched account', async () => {
    (prisma.account.upsert as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'acc-3',
      email: 'active@test.com',
      role: 'ORGANIZATION',
      provider: 'GOOGLE',
      isAccountVerified: true,
      isDeleted: false,
    });

    const done = vi.fn();
    const profile = {
      displayName: 'Active User',
      emails: [{ value: 'active@test.com' }],
      photos: [{ value: 'https://example.com/photo.jpg' }],
    };

    await accountCreatorHelper(profile, done, 'GOOGLE');

    expect(done).toHaveBeenCalledTimes(1);
    const [err, user] = done.mock.calls[0];
    expect(err).toBeNull();
    expect(user).toMatchObject({ id: 'acc-3', email: 'active@test.com' });
  });
});
