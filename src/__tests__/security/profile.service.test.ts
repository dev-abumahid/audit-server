import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';

vi.mock('../../app/lib/prisma.js', () => ({
  prisma: {
    profile: { upsert: vi.fn() },
  },
}));
vi.mock('../../app/utils/cloudinary.js', () => ({
  default: vi.fn(),
}));

import { profile_service } from '../../app/modules/profile/profile.service.js';
import { prisma } from '../../app/lib/prisma.js';
import uploadCloud from '../../app/utils/cloudinary.js';

const mockUpsert = vi.mocked(prisma.profile.upsert);
const mockUploadCloud = vi.mocked(uploadCloud);

function makeReq(body: object, accountId = 'acc-1', file?: object): Request {
  return {
    user: { accountId },
    body,
    file,
  } as unknown as Request;
}

describe('profile.service update_profile_into_db (ticket #48)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('upserts rather than updates, so a self-signed-up account with no Profile row yet still works', async () => {
    mockUpsert.mockResolvedValue({ id: 'p-1', accountId: 'acc-1', fullName: 'Jane Doe' } as never);

    await profile_service.update_profile_into_db(makeReq({ fullName: 'Jane Doe' }));

    expect(mockUpsert).toHaveBeenCalledWith({
      where: { accountId: 'acc-1' },
      update: { fullName: 'Jane Doe' },
      create: { accountId: 'acc-1', fullName: 'Jane Doe', profilePhoto: undefined },
    });
  });

  it('defaults fullName to an empty string on first-time creation when not provided', async () => {
    mockUpsert.mockResolvedValue({ id: 'p-1', accountId: 'acc-1', fullName: '' } as never);

    await profile_service.update_profile_into_db(makeReq({}));

    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ fullName: '' }),
      }),
    );
  });

  it('uploads the file to cloud storage and merges the resulting URL into both the update and create branches', async () => {
    mockUploadCloud.mockResolvedValue({ secure_url: 'https://cdn.example.com/photo.jpg' } as never);
    mockUpsert.mockResolvedValue({
      id: 'p-1',
      accountId: 'acc-1',
      profilePhoto: 'https://cdn.example.com/photo.jpg',
    } as never);

    const file = { originalname: 'photo.jpg' };
    await profile_service.update_profile_into_db(makeReq({ fullName: 'Jane Doe' }, 'acc-1', file));

    expect(mockUploadCloud).toHaveBeenCalledWith(file);
    expect(mockUpsert).toHaveBeenCalledWith({
      where: { accountId: 'acc-1' },
      update: { fullName: 'Jane Doe', profilePhoto: 'https://cdn.example.com/photo.jpg' },
      create: {
        accountId: 'acc-1',
        fullName: 'Jane Doe',
        profilePhoto: 'https://cdn.example.com/photo.jpg',
      },
    });
  });
});
