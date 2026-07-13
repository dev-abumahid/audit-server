import { Worker } from 'bullmq';
import { logger } from '../../../lib/logger.js';
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

orgInviteEmailWorker.on('failed', (job, error) => {
  logger.error(
    {
      jobId: job?.id,
      email: job?.data?.email,
      attemptsMade: job?.attemptsMade,
      error: error.message,
    },
    'Org invite email job failed',
  );
});
