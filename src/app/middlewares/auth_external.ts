import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { configs } from '../configs/index.js';
import { AppError } from '../utils/app_error.js';
import { ExternalJwtPayloadType, jwtHelpers } from '../utils/JWT.js';
import { resolveExternalCallerContext } from '../utils/org_scope.js';

// Slice 5 (#55): gates the small set of routes an external (non-Account)
// Light User calls directly — mirrors auth.ts's shape (Bearer header or
// cookie, tampered/expired token -> 401) but is deliberately a separate
// middleware rather than a new role passed to auth(): auth() looks up
// prisma.account by verifiedUser.accountId and checks isAccountVerified, an
// external member has no Account row at all, and the two payload shapes
// (JwtPayloadType vs ExternalJwtPayloadType) aren't safely interchangeable
// without weakening the `type` discriminator check that keeps an internal
// token from being replayed here (see JWT.ts's generateExternalAccessToken).
const authExternal = () => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authHeader = req.headers.authorization;
      const token = authHeader?.startsWith('Bearer ')
        ? authHeader.slice(7)
        : req.cookies.external_access_token;

      if (!token) {
        throw new AppError('You are not authorize!!', 401);
      }
      const verified = jwtHelpers.verifyToken(
        token,
        configs.jwt.access_token as string,
      ) as ExternalJwtPayloadType;
      if (verified.type !== 'EXTERNAL_ORG_MEMBER' || !verified.externalOrgMemberId) {
        throw new AppError('You are not authorize!!', 401);
      }
      // Re-checks liveness (isActive/expiresAt) against the DB on every
      // request rather than trusting the 12h token — an admin removing an
      // external member's access mid-session must take effect immediately,
      // not after the token happens to expire.
      req.externalMember = await resolveExternalCallerContext(verified.externalOrgMemberId);
      next();
    } catch (err) {
      if (err instanceof jwt.JsonWebTokenError || err instanceof jwt.TokenExpiredError) {
        next(new AppError('You are not authorize!!', 401));
      } else {
        next(err);
      }
    }
  };
};

export default authExternal;
