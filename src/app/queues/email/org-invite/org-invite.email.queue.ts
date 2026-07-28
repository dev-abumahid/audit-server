import { Queue } from 'bullmq';
import { redisConnection } from '../../connection.js';

export type TOrgInviteEmailQueue = {
  email: string;
  organizationName: string;
  inviteLink: string;
};

export const orgInviteEmailQueue = new Queue<TOrgInviteEmailQueue, void, string>(
  'org-invite-email-queue',
  {
    connection: redisConnection as any,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      // Job payloads carry a plaintext org-invite link. Without these,
      // BullMQ keeps every completed/failed job in Redis forever (default is
      // "keep all"). Cap retention so recent sends can still be inspected
      // for debugging, but the plaintext link doesn't sit in Redis
      // indefinitely.
      removeOnComplete: { age: 3600, count: 100 },
      removeOnFail: { age: 86400, count: 500 },
    },
  },
);
