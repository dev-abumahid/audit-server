import { beforeEach, describe, expect, it, vi } from 'vitest';

const queueInstances: Array<{ name: string; opts: any }> = [];
const workerListeners = new Map<string, Map<string, (...args: any[]) => void>>();

vi.mock('bullmq', () => {
  class Queue {
    name: string;
    opts: any;
    constructor(name: string, opts: any) {
      this.name = name;
      this.opts = opts;
      queueInstances.push({ name, opts });
    }
  }

  class Worker {
    name: string;
    constructor(name: string, _processor: any, _opts: any) {
      this.name = name;
      workerListeners.set(name, new Map());
    }
    on(event: string, handler: (...args: any[]) => void) {
      workerListeners.get(this.name)!.set(event, handler);
    }
  }

  return { Queue, Worker };
});

vi.mock('../../app/queues/connection.js', () => ({
  redisConnection: {},
}));

vi.mock('../../app/lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../app/queues/email/otp/otp.email.processor.js', () => ({
  emailProcessor: vi.fn(),
}));
vi.mock('../../app/queues/email/reset-password/reset.email.processor.js', () => ({
  resetEmailProcessor: vi.fn(),
}));
vi.mock('../../app/queues/email/org-invite/org-invite.email.processor.js', () => ({
  orgInviteEmailProcessor: vi.fn(),
}));

describe('email queue reliability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queueInstances.length = 0;
    workerListeners.clear();
  });

  const cases = [
    {
      queueName: 'otp-email-queue',
      queueModule: '../../app/queues/email/otp/otp.email.queue.js',
      workerModule: '../../app/queues/email/otp/otp.email.worker.js',
    },
    {
      queueName: 'reset-email-queue',
      queueModule: '../../app/queues/email/reset-password/reset.email.queue.js',
      workerModule: '../../app/queues/email/reset-password/reset.email.worker.js',
    },
    {
      queueName: 'org-invite-email-queue',
      queueModule: '../../app/queues/email/org-invite/org-invite.email.queue.js',
      workerModule: '../../app/queues/email/org-invite/org-invite.email.worker.js',
    },
  ];

  for (const { queueName, queueModule, workerModule } of cases) {
    it(`${queueName}: retries with backoff instead of failing permanently on first attempt`, async () => {
      await import(queueModule);
      const instance = queueInstances.find((q) => q.name === queueName);

      expect(instance?.opts.defaultJobOptions.attempts).toBeGreaterThan(1);
      expect(instance?.opts.defaultJobOptions.backoff).toMatchObject({ type: 'exponential' });
    });

    it(`${queueName}: logs a 'failed' event instead of silently dropping it`, async () => {
      const { logger } = await import('../../app/lib/logger.js');
      await import(workerModule);

      const failedHandler = workerListeners.get(queueName)?.get('failed');
      expect(failedHandler).toBeDefined();

      const fakeJob = { id: 'job-1', data: { email: 'user@test.com' }, attemptsMade: 3 };
      failedHandler!(fakeJob, new Error('SMTP down'));

      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ jobId: 'job-1', email: 'user@test.com', attemptsMade: 3 }),
        expect.any(String),
      );
    });
  }
});
