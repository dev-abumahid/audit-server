import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../app/lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { logger } from '../../app/lib/logger.js';
import {
  cleanupUnhandledRequestFiles,
  cleanupUploadedFile,
  collectRequestFiles,
  isFileHandled,
  markFileHandled,
} from '../../app/utils/upload_cleanup.js';

// upload_cleanup.ts is the shared mechanism behind aexa-server#305: uploader.ts
// writes multipart uploads to local disk before any downstream
// middleware/service runs, and the only cleanup that existed was inside
// uploadCloud (cloudinary.ts), reached only after a *successful* hand-off.
// These are real-filesystem tests (matching uploader.middleware.test.ts's
// convention) rather than mocked fs, since the whole point of this module is
// that the file actually stops existing on disk.
describe('upload_cleanup', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-cleanup-test-'));
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeTempFile(name: string): { path: string } {
    const filePath = path.join(tmpDir, name);
    fs.writeFileSync(filePath, 'fake upload bytes');
    return { path: filePath };
  }

  describe('markFileHandled / isFileHandled', () => {
    it('is false for a fresh file object', () => {
      const file = writeTempFile('a.pdf');
      expect(isFileHandled(file)).toBe(false);
    });

    it('is true once marked', () => {
      const file = writeTempFile('b.pdf');
      markFileHandled(file);
      expect(isFileHandled(file)).toBe(true);
    });

    it('does not throw for non-object input', () => {
      expect(() => markFileHandled(undefined)).not.toThrow();
      expect(() => markFileHandled(null)).not.toThrow();
      expect(isFileHandled(undefined)).toBe(false);
      expect(isFileHandled(null)).toBe(false);
    });
  });

  describe('cleanupUploadedFile', () => {
    it('deletes the file at file.path', async () => {
      const file = writeTempFile('c.pdf');
      expect(fs.existsSync(file.path)).toBe(true);

      await cleanupUploadedFile(file);

      expect(fs.existsSync(file.path)).toBe(false);
    });

    it('swallows ENOENT silently when the file is already gone (no crash, no log)', async () => {
      const file = writeTempFile('d.pdf');
      fs.unlinkSync(file.path); // simulate uploadCloud already having removed it

      await expect(cleanupUploadedFile(file)).resolves.toBeUndefined();
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('logs but still swallows a non-ENOENT error', async () => {
      // Force a non-ENOENT error by pointing "file.path" at a directory —
      // unlink rejects with EISDIR/EPERM depending on platform, never ENOENT,
      // since the path does exist.
      const dirAsFile = { path: tmpDir };

      await expect(cleanupUploadedFile(dirAsFile)).resolves.toBeUndefined();
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ filePath: tmpDir }),
        'Failed to clean up uploaded temp file',
      );
    });

    it('does nothing for a file object with no path', async () => {
      await expect(cleanupUploadedFile({})).resolves.toBeUndefined();
      await expect(cleanupUploadedFile(undefined)).resolves.toBeUndefined();
      expect(logger.error).not.toHaveBeenCalled();
    });
  });

  describe('collectRequestFiles', () => {
    it('collects req.file (single mode)', () => {
      const file = writeTempFile('single.pdf');
      expect(collectRequestFiles({ file })).toEqual([file]);
    });

    it('collects req.files as an array (array mode)', () => {
      const files = [writeTempFile('arr1.pdf'), writeTempFile('arr2.pdf')];
      expect(collectRequestFiles({ files })).toEqual(files);
    });

    it('collects req.files as a fieldname map (fields mode)', () => {
      const front = writeTempFile('front.pdf');
      const back = writeTempFile('back.pdf');
      expect(collectRequestFiles({ files: { front: [front], back: [back] } })).toEqual([
        front,
        back,
      ]);
    });

    it('returns an empty list when neither is present', () => {
      expect(collectRequestFiles({})).toEqual([]);
    });
  });

  describe('cleanupUnhandledRequestFiles', () => {
    it('deletes a file that was never handed off', async () => {
      const file = writeTempFile('unhandled.pdf');

      await cleanupUnhandledRequestFiles({ file });

      expect(fs.existsSync(file.path)).toBe(false);
    });

    it('leaves a file alone once it has been marked handled', async () => {
      const file = writeTempFile('handled.pdf');
      markFileHandled(file);

      await cleanupUnhandledRequestFiles({ file });

      expect(fs.existsSync(file.path)).toBe(true);
    });

    it('is a no-op the second time it runs against an already-cleaned-up file (no crash)', async () => {
      const file = writeTempFile('twice.pdf');

      await cleanupUnhandledRequestFiles({ file });
      await expect(cleanupUnhandledRequestFiles({ file })).resolves.toBeUndefined();

      expect(fs.existsSync(file.path)).toBe(false);
      expect(logger.error).not.toHaveBeenCalled();
    });
  });
});
