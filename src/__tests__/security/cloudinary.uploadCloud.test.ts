import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

// Controls whether the mocked S3 Upload succeeds or rejects, per test.
let uploadShouldFail = false;
const uploadDoneMock = vi.fn(async () => {
  if (uploadShouldFail) throw new Error('simulated S3 failure');
  return { Location: 'https://aexa-reports.s3.eu-west-1.amazonaws.com/1700000000-file.pdf' };
});
vi.mock('@aws-sdk/lib-storage', () => ({
  Upload: class {
    done() {
      return uploadDoneMock();
    }
  },
}));
vi.mock('@aws-sdk/client-s3', () => ({ S3: class {}, GetObjectCommand: class {} }));
vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: vi.fn() }));

import uploadCloud from '../../app/utils/cloudinary.js';
import { isFileHandled } from '../../app/utils/upload_cleanup.js';

// aexa-server#305 — the fix marks a file "handled" the moment uploadCloud
// takes ownership of it (before the upload even starts), and relies on
// uploadCloud continuing to be the sole place that deletes the file exactly
// once on both its own success and failure paths. These tests pin that
// contract with real files on a real tmp directory so a regression (e.g. a
// second unlink call racing an ENOENT, or the flag never getting set) shows
// up as a real filesystem assertion failure, not a mocked one.
describe('uploadCloud (cloudinary.ts) file lifecycle (aexa-server#305)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-cloud-test-'));
    uploadShouldFail = false;
    uploadDoneMock.mockClear();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeTempFile(name: string) {
    const filePath = path.join(tmpDir, name);
    fs.writeFileSync(filePath, 'fake upload bytes');
    return {
      fieldname: 'file',
      originalname: name,
      encoding: '7bit',
      mimetype: 'application/pdf',
      destination: tmpDir,
      filename: name,
      path: filePath,
      size: 18,
    };
  }

  it('marks the file handled before the upload starts (so a safety net cannot race it)', async () => {
    const file = writeTempFile('marked.pdf');

    const uploadPromise = uploadCloud(file);
    // Synchronously, before the mocked upload has even resolved, the flag
    // must already be set.
    expect(isFileHandled(file)).toBe(true);

    await uploadPromise;
  });

  it('deletes the local file exactly once on a successful upload', async () => {
    const file = writeTempFile('success.pdf');

    const result = await uploadCloud(file);

    expect(result.secure_url).toContain('https://');
    expect(fs.existsSync(file.path)).toBe(false);
  });

  it('deletes the local file exactly once when the S3 upload itself fails', async () => {
    uploadShouldFail = true;
    const file = writeTempFile('failure.pdf');

    await expect(uploadCloud(file)).rejects.toThrow('simulated S3 failure');

    expect(fs.existsSync(file.path)).toBe(false);
  });
});
