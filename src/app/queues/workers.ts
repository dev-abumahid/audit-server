import { logger } from '../lib/logger.js';
import './email/otp/otp.email.worker.js';
import './email/reset-password/reset.email.worker.js';

logger.info('All workers are running...');
