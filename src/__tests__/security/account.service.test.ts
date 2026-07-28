import bcrypt from 'bcrypt';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeReq } from '../helpers/makeReq.js';

vi.mock('../../app/lib/prisma.js', () => ({
  prisma: {
    account: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    organizationProfile: {
      create: vi.fn(),
      findFirst: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

vi.mock('../../app/queues/email/otp/otp.email.queue.js', () => ({
  otpEmailQueue: { add: vi.fn() },
}));

vi.mock('../../app/queues/email/reset-password/reset.email.queue.js', () => ({
  resetEmailQueue: { add: vi.fn() },
}));

import { otpEmailQueue } from '../../app/queues/email/otp/otp.email.queue.js';
import { resetEmailQueue } from '../../app/queues/email/reset-password/reset.email.queue.js';
import { prisma } from '../../app/lib/prisma.js';
import { account_services } from '../../app/modules/account/account.service.js';
import { configs } from '../../app/configs/index.js';
import { jwtHelpers } from '../../app/utils/JWT.js';

const db = prisma.account as unknown as Record<string, ReturnType<typeof vi.fn>>;
const profileDb = prisma.organizationProfile as unknown as Record<string, ReturnType<typeof vi.fn>>;
const mockTransaction = prisma.$transaction as unknown as ReturnType<typeof vi.fn>;
const mockOtpQueueAdd = vi.mocked(otpEmailQueue.add);
const mockResetQueueAdd = vi.mocked(resetEmailQueue.add);

describe('account service', () => {
  beforeEach(() => {
    // clearAllMocks resets call history but NOT mockResolvedValue
    // implementations, so a truthy org-name lookup set by one signup test would
    // otherwise leak into the next. Re-establish "org name available" as the
    // per-test default; individual tests override it when they need a collision.
    vi.clearAllMocks();
    profileDb.findFirst.mockResolvedValue(null);
  });

  describe('create_account_into_db (register)', () => {
    it('throws 400 with an email-specific message if an account with that email already exists (#212 — no longer the misworded "Organization already exists")', async () => {
      db.findFirst.mockResolvedValue({ id: 'existing' });
      profileDb.findFirst.mockResolvedValue(null);

      await expect(
        account_services.create_account_into_db(
          makeReq({ body: { email: 'a@test.com', password: 'pw', organizationName: 'Acme' } }),
        ),
      ).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringMatching(/email already exists/i),
      });

      // The email check is independent of and fires BEFORE the org-name check:
      // a duplicate email short-circuits without ever consulting org names, and
      // no rows are created.
      expect(profileDb.findFirst).not.toHaveBeenCalled();
      expect(mockTransaction).not.toHaveBeenCalled();
    });

    it('throws 400 with an org-name-specific message when the email is free but the organization name is already taken (#212)', async () => {
      // Email available...
      db.findFirst.mockResolvedValue(null);
      // ...but an OrganizationProfile with this name already exists.
      profileDb.findFirst.mockResolvedValue({ id: 'existing-profile' });

      await expect(
        account_services.create_account_into_db(
          makeReq({ body: { email: 'new@test.com', password: 'pw', organizationName: 'Acme' } }),
        ),
      ).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringMatching(/organization with this name already exists/i),
      });

      // Rejected before any account/org rows are created.
      expect(mockTransaction).not.toHaveBeenCalled();
    });

    it('matches an existing org name case-insensitively and trims surrounding whitespace (#212)', async () => {
      db.findFirst.mockResolvedValue(null);
      profileDb.findFirst.mockResolvedValue({ id: 'existing-profile' });

      await account_services
        .create_account_into_db(
          makeReq({
            body: { email: 'new@test.com', password: 'pw', organizationName: '  AcMe  ' },
          }),
        )
        .catch(() => {
          /* expected 400 — asserted via the query shape below */
        });

      // The lookup normalises: trimmed value + case-insensitive mode.
      expect(profileDb.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            organizationName: { equals: 'AcMe', mode: 'insensitive' },
          }),
        }),
      );
    });

    it('creates the account with isAccountVerified: false and sends an OTP email', async () => {
      db.findFirst.mockResolvedValue(null);
      const createdAccount = { id: 'acc-1' };
      mockTransaction.mockImplementation(async (fn) =>
        fn({
          account: { create: vi.fn().mockResolvedValue(createdAccount) },
          organizationProfile: { create: vi.fn().mockResolvedValue({ id: 'prof-1' }) },
          organization: { create: vi.fn().mockResolvedValue({ id: 'org-1' }) },
          orgMember: { create: vi.fn().mockResolvedValue({}) },
        }),
      );
      db.update.mockResolvedValue({});

      await account_services.create_account_into_db(
        makeReq({ body: { email: 'new@test.com', password: 'pw', organizationName: 'Acme' } }),
      );

      // Verify the account creation payload passed into the transaction never sets isAccountVerified true
      const txCallback = mockTransaction.mock.calls[0][0];
      const createSpy = vi.fn().mockResolvedValue(createdAccount);
      await txCallback({
        account: { create: createSpy },
        organizationProfile: { create: vi.fn().mockResolvedValue({}) },
        organization: { create: vi.fn().mockResolvedValue({ id: 'org-1' }) },
        orgMember: { create: vi.fn().mockResolvedValue({}) },
      });
      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ isAccountVerified: false }) }),
      );

      expect(mockOtpQueueAdd).toHaveBeenCalledWith(
        'otp-email-queue',
        expect.objectContaining({ email: 'new@test.com' }),
      );
    });

    it('sends a verification link with a well-formed `token=` query string (#281 — was `?=` with no key name)', async () => {
      db.findFirst.mockResolvedValue(null);
      mockTransaction.mockImplementation(async (fn) =>
        fn({
          account: { create: vi.fn().mockResolvedValue({ id: 'acc-1' }) },
          organizationProfile: { create: vi.fn().mockResolvedValue({ id: 'prof-1' }) },
          organization: { create: vi.fn().mockResolvedValue({ id: 'org-1' }) },
          orgMember: { create: vi.fn().mockResolvedValue({}) },
        }),
      );
      db.update.mockResolvedValue({});

      await account_services.create_account_into_db(
        makeReq({ body: { email: 'new@test.com', password: 'pw', organizationName: 'Acme' } }),
      );

      const verificationLink = (mockOtpQueueAdd.mock.calls[0][1] as { verificationLink: string })
        .verificationLink;
      expect(verificationLink).toMatch(/^.*\/verify\/token\?token=/);
      const token = new URL(verificationLink).searchParams.get('token');
      if (!token) throw new Error('Expected a token query param on the verification link');
      expect(() =>
        jwtHelpers.verifyToken(token, configs.jwt.verified_token as string),
      ).not.toThrow();
    });

    it('never stores the plaintext password', async () => {
      db.findFirst.mockResolvedValue(null);
      let capturedPassword: string | undefined;
      mockTransaction.mockImplementation(async (fn) =>
        fn({
          account: {
            create: vi.fn().mockImplementation(({ data }) => {
              capturedPassword = data.password;
              return Promise.resolve({ id: 'acc-1' });
            }),
          },
          organizationProfile: { create: vi.fn().mockResolvedValue({}) },
          organization: { create: vi.fn().mockResolvedValue({ id: 'org-1' }) },
          orgMember: { create: vi.fn().mockResolvedValue({}) },
        }),
      );
      db.update.mockResolvedValue({});

      await account_services.create_account_into_db(
        makeReq({
          body: { email: 'new@test.com', password: 'super-secret', organizationName: 'Acme' },
        }),
      );

      expect(capturedPassword).not.toBe('super-secret');
      expect(bcrypt.compareSync('super-secret', capturedPassword!)).toBe(true);
    });

    it('never returns the bcrypt password hash in the sign-up response (#165)', async () => {
      db.findFirst.mockResolvedValue(null);
      // The full raw row a real (unselected) Prisma create would produce,
      // including the bcrypt hash. The create mock below applies the same
      // `select` semantics Prisma itself applies — projecting the raw row
      // down to only the requested keys — so this test actually exercises
      // whether account.service.ts passes a `select` that excludes
      // `password`, rather than just trusting a hand-picked mock return
      // value.
      const rawAccountRow = {
        id: 'acc-1',
        email: 'new@test.com',
        password: bcrypt.hashSync('super-secret', 10),
        role: 'ORGANIZATION',
        provider: 'LOCAL',
        isAccountVerified: false,
        isDeleted: false,
        lastOtp: null,
        lastOtpSendingTime: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const createSpy = vi
        .fn()
        .mockImplementation(({ select }: { select?: Record<string, boolean> }) => {
          if (!select) return Promise.resolve(rawAccountRow);
          const projected: Record<string, unknown> = {};
          for (const key of Object.keys(select)) {
            if (select[key]) projected[key] = (rawAccountRow as Record<string, unknown>)[key];
          }
          return Promise.resolve(projected);
        });
      mockTransaction.mockImplementation(async (fn) =>
        fn({
          account: { create: createSpy },
          organizationProfile: { create: vi.fn().mockResolvedValue({ id: 'prof-1' }) },
          organization: { create: vi.fn().mockResolvedValue({ id: 'org-1' }) },
          orgMember: { create: vi.fn().mockResolvedValue({}) },
        }),
      );
      db.update.mockResolvedValue({});

      const result = await account_services.create_account_into_db(
        makeReq({
          body: { email: 'new@test.com', password: 'super-secret', organizationName: 'Acme' },
        }),
      );

      // The service must have supplied a `select` at all (an unselected
      // create would return the raw row, including the hash).
      const createCallArgs = createSpy.mock.calls[0][0];
      expect(createCallArgs.select).toBeDefined();
      expect(createCallArgs.select.password).toBeFalsy();

      // And, exercising the same select-projection logic a real Prisma
      // client applies, the resulting account object has no password key.
      expect(result.account).not.toHaveProperty('password');
      // Sanity: id/email did survive the projection (otherwise the OTP /
      // verification-token logic further down create_account_into_db, and
      // the caller's use of result.account.id/email, would break silently).
      expect(result.account).toMatchObject({ id: 'acc-1', email: 'new@test.com' });
    });

    it('creates an Organization + ADMIN OrgMember alongside the Account (#55 slice 2)', async () => {
      db.findFirst.mockResolvedValue(null);
      const organizationCreate = vi
        .fn()
        .mockResolvedValue({ id: 'org-1', anchorAccountId: 'acc-1' });
      const orgMemberCreate = vi.fn().mockResolvedValue({});
      mockTransaction.mockImplementation(async (fn) =>
        fn({
          account: { create: vi.fn().mockResolvedValue({ id: 'acc-1' }) },
          organizationProfile: { create: vi.fn().mockResolvedValue({}) },
          organization: { create: organizationCreate },
          orgMember: { create: orgMemberCreate },
        }),
      );
      db.update.mockResolvedValue({});

      await account_services.create_account_into_db(
        makeReq({
          body: { email: 'new@test.com', password: 'pw', organizationName: 'Acme Corp' },
        }),
      );

      expect(organizationCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ name: 'Acme Corp', anchorAccountId: 'acc-1' }),
        }),
      );
      expect(orgMemberCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            organizationId: 'org-1',
            accountId: 'acc-1',
            role: 'ADMIN',
            status: 'ACTIVE',
          }),
        }),
      );
    });
  });

  describe('login_user_into_db', () => {
    it('throws 404 when no account exists for the email', async () => {
      db.findUnique.mockResolvedValue(null);

      await expect(
        account_services.login_user_into_db(
          makeReq({ body: { email: 'nobody@test.com', password: 'x' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it('throws 401 on wrong password for a LOCAL account', async () => {
      db.findUnique.mockResolvedValue({
        id: 'acc-1',
        email: 'a@test.com',
        password: bcrypt.hashSync('correct-password', 10),
        provider: 'LOCAL',
        isDeleted: false,
        isAccountVerified: true,
      });

      await expect(
        account_services.login_user_into_db(
          makeReq({ body: { email: 'a@test.com', password: 'wrong' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 401 });
    });

    it('throws 401 when the account is not yet verified', async () => {
      db.findUnique.mockResolvedValue({
        id: 'acc-1',
        email: 'a@test.com',
        password: bcrypt.hashSync('correct-password', 10),
        provider: 'LOCAL',
        isDeleted: false,
        isAccountVerified: false,
      });

      await expect(
        account_services.login_user_into_db(
          makeReq({ body: { email: 'a@test.com', password: 'correct-password' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 401, message: expect.stringMatching(/not verified/i) });
    });

    it('throws 401 when the account is deleted', async () => {
      db.findUnique.mockResolvedValue({
        id: 'acc-1',
        email: 'a@test.com',
        password: bcrypt.hashSync('correct-password', 10),
        provider: 'LOCAL',
        isDeleted: true,
        isAccountVerified: true,
      });

      await expect(
        account_services.login_user_into_db(
          makeReq({ body: { email: 'a@test.com', password: 'correct-password' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 401 });
    });

    it('returns an access token and profile payload for a valid, verified LOCAL login', async () => {
      db.findUnique.mockResolvedValue({
        id: 'acc-1',
        email: 'a@test.com',
        role: 'ORGANIZATION',
        password: bcrypt.hashSync('correct-password', 10),
        provider: 'LOCAL',
        isDeleted: false,
        isAccountVerified: true,
        profile: { fullName: 'Jane', profilePhoto: null },
        organizationProfile: { organizationName: 'Acme', organizationLogo: null },
      });

      const result = await account_services.login_user_into_db(
        makeReq({ body: { email: 'a@test.com', password: 'correct-password' } }),
      );

      expect(result.accessToken).toEqual(expect.any(String));
      expect(result.returnPayload).toMatchObject({ email: 'a@test.com', role: 'ORGANIZATION' });
    });

    it('skips password check for non-LOCAL (social) accounts', async () => {
      db.findUnique.mockResolvedValue({
        id: 'acc-1',
        email: 'a@test.com',
        role: 'ORGANIZATION',
        password: null,
        provider: 'GOOGLE',
        isDeleted: false,
        isAccountVerified: true,
        profile: {},
        organizationProfile: {},
      });

      // No password provided at all — should still succeed since provider !== LOCAL
      const result = await account_services.login_user_into_db(
        makeReq({ body: { email: 'a@test.com' } }),
      );

      expect(result.accessToken).toEqual(expect.any(String));
    });
  });

  describe('verify_account_using_otp_into_db', () => {
    it('throws 404 when the account does not exist', async () => {
      db.findUnique.mockResolvedValue(null);

      await expect(
        account_services.verify_account_using_otp_into_db(
          makeReq({ body: { email: 'nobody@test.com', otp: '123456' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it('throws 401 when the OTP does not match', async () => {
      db.findUnique.mockResolvedValue({
        id: 'acc-1',
        lastOtp: 'CORRECT',
        lastOtpSendingTime: new Date(),
      });

      await expect(
        account_services.verify_account_using_otp_into_db(
          makeReq({ body: { email: 'a@test.com', otp: 'WRONG' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 401, message: expect.stringMatching(/invalid otp/i) });
    });

    it('throws 401 (not a crash) when the submitted OTP is a different length than lastOtp (#109)', async () => {
      db.findUnique.mockResolvedValue({
        id: 'acc-1',
        lastOtp: 'ABCDEF',
        lastOtpSendingTime: new Date(),
      });

      await expect(
        account_services.verify_account_using_otp_into_db(
          makeReq({ body: { email: 'a@test.com', otp: 'A' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 401, message: expect.stringMatching(/invalid otp/i) });

      await expect(
        account_services.verify_account_using_otp_into_db(
          makeReq({ body: { email: 'a@test.com', otp: 'ABCDEFGHIJKLMNOP' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 401, message: expect.stringMatching(/invalid otp/i) });
    });

    it('throws 401 when the account has never had an OTP issued (lastOtp is null), even against an empty submitted OTP (#109)', async () => {
      db.findUnique.mockResolvedValue({
        id: 'acc-1',
        lastOtp: null,
        lastOtpSendingTime: null,
      });

      await expect(
        account_services.verify_account_using_otp_into_db(
          makeReq({ body: { email: 'a@test.com', otp: '' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 401, message: expect.stringMatching(/invalid otp/i) });
    });

    it('throws 401 when the OTP has expired (older than 5 minutes)', async () => {
      const sixMinutesAgo = new Date(Date.now() - 6 * 60 * 1000);
      db.findUnique.mockResolvedValue({
        id: 'acc-1',
        lastOtp: 'CORRECT',
        lastOtpSendingTime: sixMinutesAgo,
      });

      await expect(
        account_services.verify_account_using_otp_into_db(
          makeReq({ body: { email: 'a@test.com', otp: 'CORRECT' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 401, message: expect.stringMatching(/expired/i) });
    });

    it('marks the account verified when the OTP is correct and not expired', async () => {
      db.findUnique.mockResolvedValue({
        id: 'acc-1',
        lastOtp: 'CORRECT',
        lastOtpSendingTime: new Date(),
      });
      db.update.mockResolvedValue({});

      await account_services.verify_account_using_otp_into_db(
        makeReq({ body: { email: 'a@test.com', otp: 'CORRECT' } }),
      );

      expect(db.update).toHaveBeenCalledWith({
        where: { id: 'acc-1' },
        data: { isAccountVerified: true },
      });
    });
  });

  describe('resend_otp_and_verification_link_from_db', () => {
    it('sends a verification link with a well-formed `token=` query string (#281 — was `?=` with no key name)', async () => {
      db.findUnique.mockResolvedValue({ id: 'acc-1', isAccountVerified: false });
      db.update.mockResolvedValue({});

      await account_services.resend_otp_and_verification_link_from_db(
        makeReq({ body: { email: 'a@test.com' } }),
      );

      const verificationLink = (mockOtpQueueAdd.mock.calls[0][1] as { verificationLink: string })
        .verificationLink;
      expect(verificationLink).toMatch(/^.*\/verify\/token\?token=/);
      const token = new URL(verificationLink).searchParams.get('token');
      if (!token) throw new Error('Expected a token query param on the verification link');
      expect(() =>
        jwtHelpers.verifyToken(token, configs.jwt.verified_token as string),
      ).not.toThrow();
    });
  });

  describe('password reset uses a distinct signing secret from email verification (ticket #27)', () => {
    it('forget_password_generate_reset_token_from_db signs with reset_secret, not verified_token', async () => {
      db.findUnique.mockResolvedValue({ id: 'acc-1', email: 'a@test.com' });
      mockResetQueueAdd.mockResolvedValue(undefined as never);

      await account_services.forget_password_generate_reset_token_from_db(
        makeReq({ body: { email: 'a@test.com' } }),
      );

      const [, payload] = mockResetQueueAdd.mock.calls[0];
      const resetLink = (payload as { resetLink: string }).resetLink;
      expect(resetLink).toMatch(/^.*\/reset-password\?token=/);
      const token = new URL(resetLink).searchParams.get('token');
      if (!token) throw new Error('Expected a token query param on the reset link');

      // Must verify successfully against reset_secret...
      expect(() => jwtHelpers.verifyToken(token, configs.jwt.reset_secret as string)).not.toThrow();
      // ...and must NOT verify against verified_token (the email-verification secret).
      expect(() => jwtHelpers.verifyToken(token, configs.jwt.verified_token as string)).toThrow();
    });

    it('reset_password_using_token_into_db rejects a token signed with verified_token (the email-verification secret)', async () => {
      const emailVerificationToken = jwtHelpers.generateToken(
        { email: 'a@test.com', accountId: 'acc-1' },
        configs.jwt.verified_token as string,
        '5m',
      );

      await expect(
        account_services.reset_password_using_token_into_db(
          makeReq({ body: { token: emailVerificationToken, newPass: 'new-password' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(db.update).not.toHaveBeenCalled();
    });

    it('reset_password_using_token_into_db accepts a token signed with reset_secret', async () => {
      const resetToken = jwtHelpers.generateToken(
        { email: 'a@test.com', accountId: 'acc-1' },
        configs.jwt.reset_secret as string,
        '5m',
      );
      db.findUnique.mockResolvedValue({ id: 'acc-1', email: 'a@test.com' });
      db.update.mockResolvedValue({});

      await account_services.reset_password_using_token_into_db(
        makeReq({ body: { token: resetToken, newPass: 'new-password' } }),
      );

      expect(db.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'acc-1' } }));
    });
  });

  describe('malformed/garbage tokens return a clean 4xx instead of crashing (#285)', () => {
    // Previously both functions only string-matched 'invalid signature' and
    // 'jwt expired' on error.message, with no fallback branch. Any other
    // jsonwebtoken error (jwt malformed, jwt must be provided, invalid
    // algorithm, etc.) fell through, leaving decodeToken undefined and
    // crashing with an uncaught TypeError on decodeToken.email instead of a
    // handled 4xx.
    it('verify_account_using_link_into_db rejects a malformed token with a 4xx, not a TypeError', async () => {
      await expect(
        account_services.verify_account_using_link_into_db(
          makeReq({ body: { token: 'not-a-jwt-at-all' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(db.findUnique).not.toHaveBeenCalled();
    });

    it('verify_account_using_link_into_db rejects an empty/garbage token with a 4xx, not a TypeError', async () => {
      await expect(
        account_services.verify_account_using_link_into_db(makeReq({ body: { token: '' } })),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(db.findUnique).not.toHaveBeenCalled();
    });

    it('reset_password_using_token_into_db rejects a malformed token with a 4xx, not a TypeError', async () => {
      await expect(
        account_services.reset_password_using_token_into_db(
          makeReq({ body: { token: 'not-a-jwt-at-all', newPass: 'new-password' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(db.update).not.toHaveBeenCalled();
    });

    it('reset_password_using_token_into_db rejects an empty/garbage token with a 4xx, not a TypeError', async () => {
      await expect(
        account_services.reset_password_using_token_into_db(
          makeReq({ body: { token: 'garbage.garbage.garbage', newPass: 'new-password' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(db.update).not.toHaveBeenCalled();
    });
  });

  describe('get_social_providers', () => {
    const original = {
      google: configs.google_login_config.is_google_login,
      facebook: configs.facebook_login_config.is_facebook_login,
      twitter: configs.twitter.is_twitter_login,
      github: configs.github.is_github_login,
    };

    afterEach(() => {
      configs.google_login_config.is_google_login = original.google;
      configs.facebook_login_config.is_facebook_login = original.facebook;
      configs.twitter.is_twitter_login = original.twitter;
      configs.github.is_github_login = original.github;
    });

    it('reflects each provider config flag independently', () => {
      configs.google_login_config.is_google_login = true;
      configs.facebook_login_config.is_facebook_login = false;
      configs.twitter.is_twitter_login = true;
      configs.github.is_github_login = false;

      expect(account_services.get_social_providers()).toEqual({
        google: true,
        facebook: false,
        twitter: true,
        github: false,
      });
    });

    it('returns all-false when no provider is configured', () => {
      configs.google_login_config.is_google_login = false;
      configs.facebook_login_config.is_facebook_login = false;
      configs.twitter.is_twitter_login = false;
      configs.github.is_github_login = false;

      expect(account_services.get_social_providers()).toEqual({
        google: false,
        facebook: false,
        twitter: false,
        github: false,
      });
    });
  });
});
