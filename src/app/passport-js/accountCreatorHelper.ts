import { PROVIDER } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { SAFE_ACCOUNT_SELECT } from '../modules/account/account.constants.js';
import { AppError } from '../utils/app_error.js';

export const accountCreatorHelper = async (profile: any, done: any, provider: PROVIDER) => {
  try {
    const email = profile.emails?.[0]?.value;
    if (!email) {
      throw new AppError(
        `Hi ${profile.displayName}, Your ${provider.toLocaleLowerCase()} account doesn't have email address. Please provide your email address`,
        400,
      );
    }
    // #167: this upsert's result becomes req.user (see passport-js/strategies/*
    // and customAccessTokenAndResponse.ts, which only reads req.user.id/email/
    // role). An unselected upsert would otherwise carry the full Account row
    // -- including `password` (null for social accounts, but non-null if this
    // OAuth email collides with an existing LOCAL account -- see the
    // `update: {}` branch above) -- into req.user. select: SAFE_ACCOUNT_SELECT
    // keeps req.user free of password/lastOtp/lastOtpSendingTime regardless of
    // which branch of the upsert ran. Dropped the previous `include: {
    // profile: true }`: nothing downstream reads req.user.profile on this
    // path, so there's no shape to preserve.
    const user = await prisma.account.upsert({
      where: { email },
      update: {},
      create: {
        email,
        password: null,
        provider,
        isAccountVerified: true,
        profile: {
          create: {
            fullName: profile.displayName,
            profilePhoto: profile.photos?.[0]?.value,
          },
        },
      },
      select: SAFE_ACCOUNT_SELECT,
    });

    // #286: the upsert's `update: {}` branch matches a pre-existing Account
    // by email and hands it straight to done() -- unlike login_user_into_db
    // (account.service.ts) and org-invite acceptance (organization.service.ts),
    // which both hard-reject isDeleted accounts before authenticating them.
    // Mirror that guard here so a deleted account can't regain a session via
    // social login.
    if (user.isDeleted) {
      throw new AppError('Account is deleted', 401);
    }

    return done(null, user);
  } catch (err) {
    return done(err as any);
  }
};
