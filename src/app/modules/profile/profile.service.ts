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
  const result = await prisma.profile.update({
    where: {
      accountId: user.accountId as string,
    },
    data: payload,
  });
  return result;
};

export const profile_service = {
  update_profile_into_db,
};
