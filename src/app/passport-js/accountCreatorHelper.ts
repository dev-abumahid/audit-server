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

    return done(null, user);
  } catch (err) {
    return done(err as any);
  }
};
