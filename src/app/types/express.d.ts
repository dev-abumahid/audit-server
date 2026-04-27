import { JwtPayloadType } from '../utils/JWT';

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayloadType;
    }
  }
}

export {};
