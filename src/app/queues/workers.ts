import { logger } from '../lib/logger.js';
import './email/otp/otp.email.worker.js';
import './email/org-invite/org-invite.email.worker.js';
import './email/reset-password/reset.email.worker.js';
import './email/external-verification/external-verification.email.worker.js';

logger.info('All workers are running...');
