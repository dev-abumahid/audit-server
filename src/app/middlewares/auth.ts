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
      const authHeader = req.headers.authorization;

      // A non-Bearer-prefixed header is never a usable token (standard clients always
      // send "Bearer <token>"); fall back to the cookie in every other case, not just
      // when the header is fully absent — otherwise a stale/malformed header silently
      // shadows a perfectly valid session cookie.
      const token = authHeader?.startsWith('Bearer ')
        ? authHeader.slice(7)
        : req.cookies.access_token;

      if (!token) {
        throw new AppError('You are not authorize!!', 401);
      }
      const verifiedUser = jwtHelpers.verifyToken(token, configs.jwt.access_token as string);
      if (!roles.length || !roles.includes(verifiedUser.role)) {
        throw new AppError('You are not authorize!!', 401);
      }
      const account = await prisma.account.findUnique({
        where: { id: verifiedUser.accountId },
        select: { isAccountVerified: true, security_stamp: true },
      });
      if (!account?.isAccountVerified) {
        throw new AppError('Please verify your email before continuing.', 401);
      }
      // Password-security-hardening audit: a token minted before the
      // account's current security_stamp is a token issued under a
      // password that's since been changed/reset -- reject it rather than
      // trusting it until its own natural expiry. Also rejects every token
      // issued before this field existed (verifiedUser.securityStamp
      // undefined never matches a real stamp) -- a one-time mass
      // re-authentication on deploy, the correct behavior for a token
      // format this check didn't previously apply to.
      if (account.security_stamp !== verifiedUser.securityStamp) {
        throw new AppError('Your session has expired. Please sign in again.', 401);
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
