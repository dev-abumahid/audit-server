import { NextFunction, Request, Response } from 'express';
import { configs } from '../configs/index.js';
import { AppError } from '../utils/app_error.js';

// Verifies inbound calls FROM aexa-ai (the reverse direction of
// AI_INTERNAL_SECRET_HEADER in ai.service.ts, which is aexa-server calling
// OUT to aexa-ai). Same shared secret, same header name, checked the other
// way — these are service-to-service webhook routes with no end-user
// session, so the regular JWT `auth()` middleware doesn't apply here.
const verify_ai_internal_secret = (req: Request, _res: Response, next: NextFunction) => {
  const provided = req.headers['x-internal-secret'];
  if (!provided || provided !== configs.ai_internal_secret) {
    throw new AppError('You are not authorize!!', 401);
  }
  next();
};

export default verify_ai_internal_secret;
