import { Worker } from 'bullmq';
import { redisConnection } from '../../connection.js';
import { orgInviteEmailProcessor } from './org-invite.email.processor.js';
import { TOrgInviteEmailQueue } from './org-invite.email.queue.js';

export const orgInviteEmailWorker = new Worker<TOrgInviteEmailQueue, void, string>(
  'org-invite-email-queue',
  async (job) => orgInviteEmailProcessor(job),
  {
    connection: redisConnection as any,
  },
);
