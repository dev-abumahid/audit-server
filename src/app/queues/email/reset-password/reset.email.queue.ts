import { Queue } from 'bullmq';
import { redisConnection } from '../../connection.js';

export type TResetEmailQueue = {
  email: string;
  resetLink: string;
};

export const resetEmailQueue = new Queue<TResetEmailQueue>('reset-email-queue', {
  connection: redisConnection,
});
