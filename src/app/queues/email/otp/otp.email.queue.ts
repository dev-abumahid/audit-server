import { Queue } from 'bullmq';
import { redisConnection } from '../../connection.js';

export type TOtpEmailQueue = {
  email: string;
  otp: string;
  verificationLink: string;
};

export const otpEmailQueue = new Queue<TOtpEmailQueue, void, string>('otp-email-queue', {
  connection: redisConnection as any,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
  },
});
