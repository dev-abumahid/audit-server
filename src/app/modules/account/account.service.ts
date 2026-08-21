import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { Request } from 'express';
import jwt from 'jsonwebtoken';
import { configs } from '../../configs/index.js';
import { prisma } from '../../lib/prisma.js';
import { otpEmailQueue } from '../../queues/email/otp/otp.email.queue.js';
import { resetEmailQueue } from '../../queues/email/reset-password/reset.email.queue.js';
import { AppError } from '../../utils/app_error.js';
import { jwtHelpers, JwtPayloadType } from '../../utils/JWT.js';
import { otpGenerator } from '../../utils/otpGenerator.js';
import { constantTimeStringEqual } from '../../utils/secureCompare.js';
import {
  assertEmailAvailable,
  assertOrganizationNameAvailable,
} from '../organization/organization.create.service.js';
import { SAFE_ACCOUNT_SELECT } from './account.constants.js';

const create_account_into_db = async (req: Request) => {
  const payload = req?.body;

  // Two independent pre-checks before we create anything (#212). These were
  // previously a SINGLE check that queried Account.email but threw the
  // misleadingly-worded "Organization already exists" — it never actually
  // checked the org name at all. Split into the two accurate checks, reusing
  // the shared helpers so signup, POST /organization and onboarding-commit all
  // enforce the same rules with the same messages.
  //   1. email uniqueness (a real uniqueness/security boundary — Account.email
  //      is @unique)
  await assertEmailAvailable(payload.email);
  //   2. organization-name uniqueness (application-level, case-insensitive; see
  //      the helper for the accepted TOCTOU tradeoff and why there's no DB
  //      constraint)
  await assertOrganizationNameAvailable(payload.organizationName);

  // hash password
  const hashPassword = bcrypt.hashSync(payload.password, 10);

  // create account, profile, and the org/org-membership that backs it (#55
  // slice 2) — mirrors exactly what src/scripts/backfill-org-membership.ts
  // does for pre-existing accounts, so new signups never need that backfill
  // to run for them.
  const result = await prisma.$transaction(async (tx: any) => {
    const account = await tx.account.create({
      data: {
        email: payload.email,
        password: hashPassword,
        role: 'ORGANIZATION',
        isAccountVerified: false,
      },
      // #165 / #167: never let the bcrypt hash (or other sensitive columns)
      // leave this function — result.account flows straight through to the
      // HTTP response via account.controller.ts's create_account. Only
      // id/email are actually read downstream (OTP + verification-token
      // logic in this function); the frontend's sign-up flow doesn't read
      // any account field off the response either (src/pages/auth/
      // SignUpModal.tsx in aexa-frontend only inspects error.data.message).
      // Uses the shared SAFE_ACCOUNT_SELECT (also used by
      // get_user_account_from_db below and accountCreatorHelper.ts) instead
      // of a hand-written list, so this select can't drift from the other
      // "fields safe to expose" lists across the codebase.
      select: SAFE_ACCOUNT_SELECT,
    });

    const profile = await tx.organizationProfile.create({
      data: {
        organizationName: payload.organizationName,
        accountId: account.id,
      },
    });

    const organization = await tx.organization.create({
      data: {
        name: payload.organizationName,
        anchorAccountId: account.id,
      },
    });

    await tx.orgMember.create({
      data: {
        organizationId: organization.id,
        accountId: account.id,
        role: 'ADMIN',
        status: 'ACTIVE',
      },
    });

    return {
      account,
      profile,
    };
  });

  // sending otp and verification link
  const newOtp = otpGenerator();
  const verificationToken = jwtHelpers.generateToken(
    {
      email: payload.email as string,
      accountId: result.account.id as string,
    },
    configs.jwt.verified_token as string,
    '5m',
  );
  const verificationLink = `${configs.jwt.front_end_url}/verify/token?token=${verificationToken}`;
  // save otp into db
  await prisma.account.update({
    where: {
      email: payload.email,
    },
    data: {
      lastOtp: newOtp,
      lastOtpSendingTime: new Date(),
    },
  });

  await otpEmailQueue.add('otp-email-queue', {
    otp: newOtp,
    email: payload.email,
    verificationLink,
  });
  return result;
};

const verify_account_using_otp_into_db = async (req: Request) => {
  const payload: { email: string; otp: string } = req?.body;
  // check account
  const account = await prisma.account.findUnique({
    where: {
      email: payload.email,
    },
  });
  // check if account exists
  if (!account) {
    throw new AppError('Account not found', 404);
  }
  // match with last otp — constant-time compare (#109) so response timing
  // can't be used to recover the OTP digit-by-digit. account.lastOtp is
  // nullable (never-requested accounts): guard that case explicitly rather
  // than defaulting it to '', since payload.otp is only Zod-validated as a
  // string (empty string allowed) and '' ?? '' === '' would otherwise let
  // an empty OTP "match" an account that never had one issued.
  const isOtpMatch =
    account.lastOtp !== null && constantTimeStringEqual(payload.otp, account.lastOtp);
  if (!isOtpMatch) {
    throw new AppError('Invalid OTP, Please try again!!', 401);
  }
  // check otp timing
  const OTP_EXPIRY_TIME = 5 * 60 * 1000; // 5 minutes in ms
  const isOtpExpired = account.lastOtpSendingTime
    ? new Date().getTime() - new Date(account.lastOtpSendingTime).getTime() > OTP_EXPIRY_TIME
    : true;

  if (isOtpExpired) {
    throw new AppError('OTP Expired, Please try again!!', 401);
  }
  // change account status
  await prisma.account.update({
    where: {
      id: account.id,
    },
    data: {
      isAccountVerified: true,
    },
  });

  return '';
};

const verify_account_using_link_into_db = async (req: Request) => {
  const token = req?.body?.token as string;
  let decodeToken: any;
  try {
    decodeToken = jwtHelpers.verifyToken(token, configs.jwt.verified_token as string);
  } catch (error) {
    // Tampered, malformed, or expired tokens must return a clean 4xx, not an
    // uncaught TypeError from decodeToken being undefined below (see #285).
    // TokenExpiredError is a subclass of JsonWebTokenError, so it must be
    // checked first to keep its distinct message; the JsonWebTokenError
    // branch then covers every other jsonwebtoken error class (malformed,
    // invalid signature, invalid algorithm, jwt must be provided,
    // NotBeforeError, etc.) — matching the pattern in
    // src/app/middlewares/auth.ts.
    if (error instanceof jwt.TokenExpiredError) {
      throw new AppError('Token expired, please reset again', 403);
    } else if (error instanceof jwt.JsonWebTokenError) {
      throw new AppError('Invalid Token', 403);
    } else {
      throw error;
    }
  }
  // check account
  const account = await prisma.account.findUnique({
    where: {
      email: decodeToken.email,
    },
  });
  // check if account exists
  if (!account) {
    throw new AppError('Account not found', 404);
  }

  // change account status
  await prisma.account.update({
    where: {
      id: account.id,
    },
    data: {
      isAccountVerified: true,
    },
  });
  return '';
};

const login_user_into_db = async (req: Request) => {
  const payload = req?.body;
  const account = await prisma.account.findUnique({
    where: {
      email: payload.email,
    },
    include: {
      organizationProfile: true,
      profile: true,
    },
  });

  // check if account exists
  if (!account) {
    throw new AppError('Account not found', 404);
  }

  // check provide
  if (account.provider === 'LOCAL') {
    // checking password
    const isPasswordMatch = bcrypt.compareSync(payload.password, account.password as string);

    if (!isPasswordMatch) {
      throw new AppError('Invalid password', 401);
    }
  }

  // check if account is deleted
  if (account.isDeleted) {
    throw new AppError('Account is deleted', 401);
  }
  // check if account is verified
  if (!account.isAccountVerified) {
    throw new AppError('Account is not verified', 401);
  }
  // generate access
  const accessToken = jwtHelpers.generateAccessToken({
    email: account.email,
    role: account.role,
    accountId: account.id,
    securityStamp: account.security_stamp,
  });

  // return payload
  const returnPayload = {
    email: account.email,
    id: account.id,
    role: account.role,
    provider: account.provider,
    userProfile: {
      fullName: account.profile?.fullName,
      profilePhoto: account.profile?.profilePhoto,
    },
    organizationProfile: {
      organizationName: account.organizationProfile?.organizationName,
      organizationLogo: account.organizationProfile?.organizationLogo,
    },
  };

  return { accessToken, returnPayload };
};

const get_user_account_from_db = async (req: Request) => {
  const user = req?.user as JwtPayloadType;

  // #167: SAFE_ACCOUNT_SELECT plus the two relations this endpoint has
  // always returned. Spreading it in (rather than hand-listing the same
  // scalar fields again) additionally picks up `provider`/`createdAt`/
  // `updatedAt` here, which weren't previously selected — all non-sensitive
  // metadata, safe to add, and consistent with what create_account_into_db
  // and accountCreatorHelper.ts now return for the same model.
  const result = await prisma.account.findUnique({
    where: {
      id: user?.accountId,
    },
    select: {
      ...SAFE_ACCOUNT_SELECT,
      profile: true,
      organizationProfile: true,
    },
  });
  return result;
};

const change_password_into_db = async (req: Request) => {
  const user = req?.user as JwtPayloadType;
  // payload
  const payload: { oldPassword: string; newPassword: string } = req?.body;
  // check old and new password is not same
  const isSamePassword = payload.oldPassword === payload.newPassword;
  if (isSamePassword) {
    throw new AppError('Old and new password are same, Please provide different password', 404);
  }
  // check user validity
  const isUserExist = await prisma.account.findFirst({
    where: {
      email: user?.email,
    },
  });
  // if account not exists
  if (!isUserExist) {
    throw new AppError('Account not found!!', 404);
  }
  // Social-login accounts (Google/Facebook/etc, see accountCreatorHelper.ts)
  // have no password at all -- bcrypt.compareSync throws a TypeError on a
  // null hash, which otherwise surfaced as an opaque 500 instead of a clear
  // "there's no password to change" message.
  if (!isUserExist.password) {
    throw new AppError(
      'This account signed up via social login and has no password to change.',
      400,
    );
  }
  // check old password
  const isPasswordMatch = bcrypt.compareSync(payload.oldPassword, isUserExist.password);
  if (!isPasswordMatch) {
    throw new AppError('Incorrect password', 401);
  }
  // change password logic
  const newHashPassword = bcrypt.hashSync(payload.newPassword, 10);
  await prisma.account.update({
    where: {
      id: isUserExist.id,
    },
    data: {
      password: newHashPassword,
      // Password-security-hardening audit: invalidates every access token
      // issued before this change (including on other devices/tabs) --
      // auth() checks this on every request, so a stolen session stops
      // working the moment the legitimate owner changes their password,
      // instead of surviving until the token's own natural expiry.
      security_stamp: crypto.randomUUID(),
    },
  });

  // in future email notification for more security
  return '';
};

const resend_otp_and_verification_link_from_db = async (req: Request) => {
  const email = req?.body?.email as string;
  const account = await prisma.account.findUnique({
    where: {
      email,
    },
  });
  // check if account exists
  if (!account) {
    throw new AppError('Account not found', 404);
  }
  // if already verified
  if (account.isAccountVerified) {
    throw new AppError('Account already verified', 403);
  }
  // make new otp and verification link
  const newOtp = otpGenerator();
  const verificationToken = jwtHelpers.generateToken(
    {
      email,
      accountId: account.id,
    },
    configs.jwt.verified_token as string,
    '5m',
  );
  const verificationLink = `${configs.jwt.front_end_url}/verify/token?token=${verificationToken}`;
  // save otp into db
  await prisma.account.update({
    where: {
      email,
    },
    data: {
      lastOtp: newOtp,
      lastOtpSendingTime: new Date(),
    },
  });

  await otpEmailQueue.add('otp-email-queue', {
    otp: newOtp,
    email,
    verificationLink,
  });
};

const forget_password_generate_reset_token_from_db = async (req: Request) => {
  const email = req?.body?.email as string;
  const account = await prisma.account.findUnique({
    where: {
      email,
    },
  });
  // No account, a deleted account, or a social-login-only account (no local
  // password to reset -- see the comment above the password===null check
  // this replaced) all silently no-op instead of throwing a distinguishing
  // error. This endpoint is unauthenticated and public, so a 404/400 here
  // would be a straightforward account-existence/provider-type enumeration
  // oracle (found by the password-implementation audit) -- and the
  // frontend's ForgotPasswordModal.tsx already shows the same "check your
  // email" success state regardless of what this endpoint returns, so
  // there's no UX to preserve by keeping the distinguishing errors. A
  // social-login-only account letting this silently no-op (rather than
  // gaining a new local password) is itself the fix for that case; there's
  // just no separate email/response telling the caller which case applied.
  if (!account || account.isDeleted || account.password === null) {
    return '';
  }
  // Password-security-hardening audit: bump reset_token_stamp on every
  // request (not just successful resets), and embed the new value into the
  // token below. This makes reset tokens genuinely single-use (redemption
  // also bumps it, see reset_password_using_token_into_db) and means
  // requesting a new link invalidates any still-valid older one, instead of
  // both staying live until their own 5-minute expiry.
  const resetTokenStamp = crypto.randomUUID();
  await prisma.account.update({
    where: { id: account.id },
    data: { reset_token_stamp: resetTokenStamp },
  });
  // generate forget token
  const verificationToken = jwtHelpers.generateToken(
    {
      email: email,
      accountId: account.id,
      resetTokenStamp,
    },
    configs.jwt.reset_secret as string,
    '5m',
  );
  // Distinct from the email-verification link's /verify/token route (used
  // by sign-up and resend-OTP, elsewhere in this file) — this is a
  // different flow with a different token/secret. Was previously
  // `/verify/token?=${token}` (no key name before `=`), which happened to
  // be parseable via URLSearchParams().get("") but was never actually
  // exercised by any frontend consumer (#73) to catch that it was wrong.
  const verificationLink = `${configs.jwt.front_end_url}/reset-password?token=${verificationToken}`;

  await resetEmailQueue.add('reset-email-queue', {
    email,
    resetLink: verificationLink,
  });
};

const reset_password_using_token_into_db = async (req: Request) => {
  const token = req?.body?.token as string;
  const newPass = req?.body?.newPass as string;
  let decodeToken: any;
  try {
    decodeToken = jwtHelpers.verifyToken(token, configs.jwt.reset_secret as string);
  } catch (error) {
    // Same rationale as verify_account_using_link_into_db above (#285):
    // check TokenExpiredError first (it subclasses JsonWebTokenError) so its
    // message stays distinct, then let JsonWebTokenError catch every other
    // jsonwebtoken error class so decodeToken.email below is never reached
    // with decodeToken undefined.
    if (error instanceof jwt.TokenExpiredError) {
      throw new AppError('Link expired, please reset again', 403);
    } else if (error instanceof jwt.JsonWebTokenError) {
      throw new AppError('Invalid Token', 403);
    } else {
      throw error;
    }
  }
  // check account
  const account = await prisma.account.findUnique({
    where: {
      email: decodeToken.email,
    },
  });
  // check if account exists. Also reject a deleted account (password-
  // security-hardening audit, mirroring accountCreatorHelper.ts's own
  // isDeleted guard) -- covers the window where the account was deleted
  // AFTER a still-valid reset token was issued.
  if (!account || account.isDeleted) {
    throw new AppError('Account not found', 404);
  }

  // Password-security-hardening audit: reject a token whose embedded stamp
  // doesn't match the account's CURRENT reset_token_stamp -- either the
  // token was already redeemed once (redemption bumps the stamp below), or
  // a newer reset request has since superseded it. Same rejection path as
  // an expired/tampered token, not a different error, so this doesn't leak
  // which specific reason applies.
  if (decodeToken.resetTokenStamp !== account.reset_token_stamp) {
    throw new AppError('Link expired, please reset again', 403);
  }

  // change account password
  const newHash = bcrypt.hashSync(newPass, 10);
  await prisma.account.update({
    where: {
      id: account.id,
    },
    data: {
      password: newHash,
      // A successful reset is itself a password change -- invalidate
      // existing login sessions the same way change_password_into_db does.
      // Also bump reset_token_stamp so this same token can't be replayed.
      security_stamp: crypto.randomUUID(),
      reset_token_stamp: crypto.randomUUID(),
    },
  });
  // In future user alert for changing password
  return '';
};

/**
 * Which social providers are actually usable right now — config-gated the
 * same way the /social/:provider routes themselves are (account.route.ts).
 * Not DB-backed: exists so the frontend can render only buttons that will
 * actually work, instead of guessing which of the 4 passport strategies
 * have real OAuth credentials configured in this environment.
 */
const get_social_providers = () => ({
  google: configs.google_login_config.is_google_login,
  facebook: configs.facebook_login_config.is_facebook_login,
  twitter: configs.twitter.is_twitter_login,
  github: configs.github.is_github_login,
});

export const account_services = {
  create_account_into_db,
  login_user_into_db,
  get_user_account_from_db,
  change_password_into_db,
  verify_account_using_otp_into_db,
  resend_otp_and_verification_link_from_db,
  verify_account_using_link_into_db,
  forget_password_generate_reset_token_from_db,
  reset_password_using_token_into_db,
  get_social_providers,
};
