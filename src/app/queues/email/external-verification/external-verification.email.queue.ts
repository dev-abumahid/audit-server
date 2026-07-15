import { Queue } from 'bullmq';
import { redisConnection } from '../../connection.js';

export type TExternalVerificationEmailQueue = {
  email: string;
  code: string;
  organizationName: string;
};

export const externalVerificationEmailQueue = new Queue<
  TExternalVerificationEmailQueue,
  void,
  string
>('external-verification-email-queue', {
  connection: redisConnection as any,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
  },
});
