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
    },
  },
);
