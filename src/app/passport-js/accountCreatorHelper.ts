import { PROVIDER } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
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
      include: {
        profile: true,
      },
    });

    return done(null, user);
  } catch (err) {
    return done(err as any);
  }
};
