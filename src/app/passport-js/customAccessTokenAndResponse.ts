import { Response } from 'express';
import { configs } from '../configs/index.js';
import { jwtHelpers } from '../utils/JWT.js';
import manageResponse from '../utils/manage_response.js';

export const customAccessTokenAndResponse = (req: any, res: Response) => {
  // make access token
  const accessToken = jwtHelpers.generateToken(
    {
      accountId: req?.user?.id as string,
      email: req?.user?.email as string,
      role: req?.user?.role as string,
    },
    configs.jwt.access_token as string,
    configs.jwt.access_expires as string,
  );

  // set token into cookie
  res.cookie('access_token', accessToken, {
    secure: configs.env === 'production',
    httpOnly: true,
  });

  // sent response
  manageResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Login successfully',
    data: {
      accessToken,
    },
  });
};
