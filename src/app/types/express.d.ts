import { JwtPayloadType } from '../utils/JWT';
import { ExternalCallerContext } from '../utils/org_scope';

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayloadType;
      externalMember?: ExternalCallerContext;
    }
  }
}

export {};
