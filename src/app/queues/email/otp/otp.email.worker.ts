import { Worker } from 'bullmq';
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
