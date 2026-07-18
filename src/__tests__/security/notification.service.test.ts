import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../app/lib/prisma.js', () => ({
  prisma: {
    account: {
      findUnique: vi.fn(),
    },
    notification: {
      create: vi.fn(),
    },
  },
}));

import { prisma } from '../../app/lib/prisma.js';
import { notification_service } from '../../app/modules/notification/notification.service.js';

const accountDb = prisma.account as unknown as Record<string, ReturnType<typeof vi.fn>>;
const notificationDb = prisma.notification as unknown as Record<string, ReturnType<typeof vi.fn>>;

function makeReq(body: Record<string, unknown>) {
  return { body } as never;
}

describe('notification_service.create_notification_from_webhook_into_db', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a notification scoped to the org from orgUserName', async () => {
    accountDb.findUnique.mockResolvedValue({ id: 'org-1' });
    notificationDb.create.mockResolvedValue({});

    await notification_service.create_notification_from_webhook_into_db(
      makeReq({
        orgUserName: 'org-1',
        notificationTitle: 'Success',
        notificationDescription: 'file.pdf is uploaded',
        status: true,
      }),
    );

    expect(accountDb.findUnique).toHaveBeenCalledWith({ where: { id: 'org-1' } });
    expect(notificationDb.create).toHaveBeenCalledWith({
      data: {
        orgAccountId: 'org-1',
        title: 'Success',
        description: 'file.pdf is uploaded',
        status: true,
      },
    });
  });

  it('throws 404 and does NOT create a notification for an unknown org', async () => {
    accountDb.findUnique.mockResolvedValue(null);

    await expect(
      notification_service.create_notification_from_webhook_into_db(
        makeReq({
          orgUserName: 'unknown-org',
          notificationTitle: 'Error',
          notificationDescription: 'failed',
          status: false,
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 404 });

    expect(notificationDb.create).not.toHaveBeenCalled();
  });
});
