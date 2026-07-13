import { Worker } from 'bullmq';
import { logger } from '../../../lib/logger.js';
import { redisConnection } from '../../connection.js';
import { resetEmailProcessor } from './reset.email.processor.js';
import { TResetEmailQueue } from './reset.email.queue.js';

export const resetEmailWorker = new Worker<TResetEmailQueue, void, string>(
  'reset-email-queue',
  async (job) => resetEmailProcessor(job),
  {
    connection: redisConnection as any,
  },
);

resetEmailWorker.on('failed', (job, error) => {
  logger.error(
    {
      jobId: job?.id,
      email: job?.data?.email,
      attemptsMade: job?.attemptsMade,
      error: error.message,
    },
    'Reset password email job failed',
  );
});
