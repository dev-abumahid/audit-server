import { Worker } from 'bullmq';
import { logger } from '../../../lib/logger.js';
import { redisConnection } from '../../connection.js';
import { externalVerificationEmailProcessor } from './external-verification.email.processor.js';
import { TExternalVerificationEmailQueue } from './external-verification.email.queue.js';

export const externalVerificationEmailWorker = new Worker<
  TExternalVerificationEmailQueue,
  void,
  string
>('external-verification-email-queue', async (job) => externalVerificationEmailProcessor(job), {
  connection: redisConnection as any,
});

externalVerificationEmailWorker.on('failed', (job, error) => {
  logger.error(
    {
      jobId: job?.id,
      email: job?.data?.email,
      attemptsMade: job?.attemptsMade,
      error: error.message,
    },
    'External verification email job failed',
  );
});
