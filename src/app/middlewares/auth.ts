import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { configs } from '../configs/index.js';
import { prisma } from '../lib/prisma.js';
import { AppError } from '../utils/app_error.js';
import { jwtHelpers, JwtPayloadType } from '../utils/JWT.js';

type Role = 'ADMIN' | 'USER' | 'ORGANIZATION';

const auth = (...roles: Role[]) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const token = req.headers.authorization || req.cookies.access_token;
      if (!token) {
        throw new AppError('You are not authorize!!', 401);
      }
      const verifiedUser = jwtHelpers.verifyToken(token, configs.jwt.access_token as string);
      if (!roles.length || !roles.includes(verifiedUser.role)) {
        throw new AppError('You are not authorize!!', 401);
      }
      const account = await prisma.account.findUnique({
        where: { id: verifiedUser.accountId },
        select: { isAccountVerified: true },
      });
      if (!account?.isAccountVerified) {
        throw new AppError('Please verify your email before continuing.', 401);
      }
      req.user = verifiedUser as JwtPayloadType;
      next();
    } catch (err) {
      // Tampered or expired tokens must return 401, not 500
      if (err instanceof jwt.JsonWebTokenError || err instanceof jwt.TokenExpiredError) {
        next(new AppError('You are not authorize!!', 401));
      } else {
        next(err);
      }
    }
  };
};

export default auth;
