import { describe, expect, it } from 'vitest';
import { notification_validations } from '../../app/modules/notification/notification.validation.js';

describe('notification_validations.create_notification_from_webhook', () => {
  it('accepts a valid payload', () => {
    const result = notification_validations.create_notification_from_webhook.safeParse({
      orgUserName: 'org-1',
      notificationTitle: 'Success',
      notificationDescription: 'file.pdf is uploaded',
      status: true,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a missing field', () => {
    const result = notification_validations.create_notification_from_webhook.safeParse({
      orgUserName: 'org-1',
      notificationTitle: 'Success',
      status: true,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-boolean status', () => {
    const result = notification_validations.create_notification_from_webhook.safeParse({
      orgUserName: 'org-1',
      notificationTitle: 'Success',
      notificationDescription: 'file.pdf is uploaded',
      status: 'true',
    });
    expect(result.success).toBe(false);
  });
});
