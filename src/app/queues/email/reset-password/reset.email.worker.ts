import { Worker } from 'bullmq';
import { redisConnection } from '../../connection.js';
import { resetEmailProcessor } from './reset.email.processor.js';
import { TResetEmailQueue } from './reset.email.queue.js';

export const resetEmailWorker = new Worker<TResetEmailQueue>(
  'reset-email-queue',
  async (job) => resetEmailProcessor(job),
  {
    connection: redisConnection,
  },
);
