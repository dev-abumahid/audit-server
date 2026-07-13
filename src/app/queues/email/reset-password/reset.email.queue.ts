import { Queue } from 'bullmq';
import { redisConnection } from '../../connection.js';

export type TResetEmailQueue = {
  email: string;
  resetLink: string;
};

export const resetEmailQueue = new Queue<TResetEmailQueue, void, string>('reset-email-queue', {
  connection: redisConnection as any,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
  },
});
