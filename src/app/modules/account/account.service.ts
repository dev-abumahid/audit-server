import bcrypt from 'bcrypt';
import { Request } from 'express';
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
  } catch (error: any) {
    if (error?.message == 'invalid signature') {
      throw new AppError('Invalid Token', 403);
    } else if (error?.message == 'jwt expired') {
      throw new AppError('Token expired, please reset again', 403);
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
  // check old password
  const isPasswordMatch = bcrypt.compareSync(payload.oldPassword, isUserExist.password as string);
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
  // check if account exists
  if (!account) {
    throw new AppError('Account not found', 404);
  }
  // generate forget token
  const verificationToken = jwtHelpers.generateToken(
    {
      email: email,
      accountId: account.id,
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
  } catch (error: any) {
    if (error?.message == 'invalid signature') {
      throw new AppError('Invalid Token', 403);
    } else if (error?.message == 'jwt expired') {
      throw new AppError('Link expired, please reset again', 403);
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

  // change account password
  const newHash = bcrypt.hashSync(newPass, 10);
  await prisma.account.update({
    where: {
      id: account.id,
    },
    data: {
      password: newHash,
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
