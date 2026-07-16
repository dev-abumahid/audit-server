import { Request } from 'express';
import uploadCloud from '../../utils/cloudinary.js';
import { prisma } from '../../lib/prisma.js';
import { JwtPayloadType } from '../../utils/JWT.js';

const update_profile_into_db = async (req: Request) => {
  const user = req?.user as JwtPayloadType;
  const payload = req?.body;
  const file = req?.file;
  // check file and upload to cloud
  if (file) {
    const cloudRes = await uploadCloud(file);
    payload.profilePhoto = cloudRes?.secure_url;
  }
  // Self-signed-up accounts (the org anchor) never get a Profile row created
  // at signup time — only invited members do (organization.service.ts's
  // accept-invite path). Update alone would 404 the anchor account on its
  // first-ever profile edit; upsert makes this route work for every account
  // that can reach it, not just the ones an org-invite flow happened to touch.
  const result = await prisma.profile.upsert({
    where: {
      accountId: user.accountId as string,
    },
    update: payload,
    create: {
      accountId: user.accountId as string,
      fullName: payload.fullName ?? '',
      profilePhoto: payload.profilePhoto,
    },
  });
  return result;
};

export const profile_service = {
  update_profile_into_db,
};
