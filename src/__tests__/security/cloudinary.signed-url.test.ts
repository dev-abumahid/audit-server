import { beforeEach, describe, expect, it, vi } from 'vitest';

// The report download endpoint must hand the client a short-lived signed URL,
// never the permanent public object URL (#222). These tests pin the two pieces
// that make that safe: the S3 key is derived correctly from the stored URL, and
// a finite expiry is passed through to the presigner.

vi.mock('../../app/configs/index.js', () => ({
  configs: {
    aws: {
      bucket: 'aexa-reports',
      region: 'eu-west-1',
      access_key_id: 'x',
      secret_access_key: 'y',
    },
  },
}));

const getSignedUrlMock = vi.fn();
vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: (...args: unknown[]) => getSignedUrlMock(...args),
}));

// Capture the GetObjectCommand input so we can assert the derived key.
const getObjectInputs: Array<Record<string, unknown>> = [];
vi.mock('@aws-sdk/client-s3', () => ({
  S3: class {},
  GetObjectCommand: class {
    input: Record<string, unknown>;
    constructor(input: Record<string, unknown>) {
      this.input = input;
      getObjectInputs.push(input);
    }
  },
}));
vi.mock('@aws-sdk/lib-storage', () => ({ Upload: class {} }));

import { getSignedDownloadUrl } from '../../app/utils/cloudinary.js';

describe('getSignedDownloadUrl (#222)', () => {
  beforeEach(() => {
    getObjectInputs.length = 0;
    getSignedUrlMock.mockReset();
    getSignedUrlMock.mockResolvedValue('https://signed.example/report?X-Amz-Signature=sig');
  });

  it('derives the key from a virtual-hosted-style URL and passes the TTL through', async () => {
    const url = await getSignedDownloadUrl(
      'https://aexa-reports.s3.eu-west-1.amazonaws.com/1700000000-report.pdf',
      300,
    );

    expect(getObjectInputs[0]).toEqual({ Bucket: 'aexa-reports', Key: '1700000000-report.pdf' });
    expect(getSignedUrlMock).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      expiresIn: 300,
    });
    expect(url).toContain('X-Amz-Signature');
  });

  it('strips a leading bucket segment from a path-style URL', async () => {
    await getSignedDownloadUrl(
      'https://s3.eu-west-1.amazonaws.com/aexa-reports/1700000000-report.pdf',
      120,
    );

    expect(getObjectInputs[0]).toMatchObject({ Key: '1700000000-report.pdf' });
  });
});
