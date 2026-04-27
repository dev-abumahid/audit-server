import { Queue } from 'bullmq';
import { redisConnection } from '../../connection.js';

export type TOtpEmailQueue = {
  email: string;
  otp: string;
  verificationLink: string;
};

export const otpEmailQueue = new Queue<TOtpEmailQueue>('otp-email-queue', {
  connection: redisConnection,
});
