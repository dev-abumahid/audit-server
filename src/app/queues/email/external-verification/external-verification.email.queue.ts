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
    // Job payloads carry a plaintext verification code (external-auth.service.ts
    // only ever stores a bcrypt hash of this code in the DB). Without these,
    // BullMQ keeps every completed/failed job in Redis forever (default is
    // "keep all"). Cap retention so recent sends can still be inspected for
    // debugging, but the plaintext code doesn't sit in Redis indefinitely.
    removeOnComplete: { age: 3600, count: 100 },
    removeOnFail: { age: 86400, count: 500 },
  },
});
