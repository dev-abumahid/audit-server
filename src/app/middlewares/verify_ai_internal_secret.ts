import { NextFunction, Request, Response } from 'express';
import { configs } from '../configs/index.js';
import { AppError } from '../utils/app_error.js';
import { constantTimeStringEqual } from '../utils/secureCompare.js';

// Verifies inbound calls FROM aexa-ai (the reverse direction of
// AI_INTERNAL_SECRET_HEADER in ai.service.ts, which is aexa-server calling
// OUT to aexa-ai). Same shared secret, same header name, checked the other
// way — these are service-to-service webhook routes with no end-user
// session, so the regular JWT `auth()` middleware doesn't apply here.
const verify_ai_internal_secret = (req: Request, _res: Response, next: NextFunction) => {
  const provided = req.headers['x-internal-secret'];
  // Constant-time comparison via the repo's own secureCompare helper (the same
  // one account.service.ts uses for OTPs, issue #109) — a plain `!==` on a
  // secret is a timing side-channel that leaks how many leading characters an
  // attacker guessed correctly. `typeof` guards the array-valued-header case
  // (a repeated X-Internal-Secret header arrives as string[]).
  if (
    typeof provided !== 'string' ||
    !constantTimeStringEqual(provided, configs.ai_internal_secret)
  ) {
    throw new AppError('You are not authorize!!', 401);
  }
  next();
};

export default verify_ai_internal_secret;
