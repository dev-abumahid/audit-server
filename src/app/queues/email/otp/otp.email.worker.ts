import { Worker } from 'bullmq';
import { logger } from '../../../lib/logger.js';
import { redisConnection } from '../../connection.js';
import { emailProcessor } from './otp.email.processor.js';
import { TOtpEmailQueue } from './otp.email.queue.js';

export const emailWorker = new Worker<TOtpEmailQueue, void, string>(
  'otp-email-queue',
  async (job) => emailProcessor(job),
  {
    connection: redisConnection as any,
  },
);

emailWorker.on('failed', (job, error) => {
  logger.error(
    {
      jobId: job?.id,
      email: job?.data?.email,
      attemptsMade: job?.attemptsMade,
      error: error.message,
    },
    'OTP email job failed',
  );
});
