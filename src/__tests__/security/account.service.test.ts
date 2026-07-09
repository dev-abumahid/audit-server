import bcrypt from 'bcrypt';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
const mockTransaction = prisma.$transaction as unknown as ReturnType<typeof vi.fn>;
const mockOtpQueueAdd = vi.mocked(otpEmailQueue.add);
const mockResetQueueAdd = vi.mocked(resetEmailQueue.add);

describe('account service', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('create_account_into_db (register)', () => {
    it('throws 400 if an account with that email already exists', async () => {
      db.findFirst.mockResolvedValue({ id: 'existing' });

      await expect(
        account_services.create_account_into_db(
          makeReq({ body: { email: 'a@test.com', password: 'pw', organizationName: 'Acme' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('creates the account with isAccountVerified: false and sends an OTP email', async () => {
      db.findFirst.mockResolvedValue(null);
      const createdAccount = { id: 'acc-1' };
      mockTransaction.mockImplementation(async (fn) =>
        fn({
          account: { create: vi.fn().mockResolvedValue(createdAccount) },
          organizationProfile: { create: vi.fn().mockResolvedValue({ id: 'prof-1' }) },
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
      });
      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ isAccountVerified: false }) }),
      );

      expect(mockOtpQueueAdd).toHaveBeenCalledWith(
        'otp-email-queue',
        expect.objectContaining({ email: 'new@test.com' }),
      );
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

  describe('password reset uses a distinct signing secret from email verification (ticket #27)', () => {
    it('forget_password_generate_reset_token_from_db signs with reset_secret, not verified_token', async () => {
      db.findUnique.mockResolvedValue({ id: 'acc-1', email: 'a@test.com' });
      mockResetQueueAdd.mockResolvedValue(undefined as never);

      await account_services.forget_password_generate_reset_token_from_db(
        makeReq({ body: { email: 'a@test.com' } }),
      );

      const [, payload] = mockResetQueueAdd.mock.calls[0];
      const resetLink = (payload as { resetLink: string }).resetLink;
      const token = resetLink.split('?=')[1];

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
});
