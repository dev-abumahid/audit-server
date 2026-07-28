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
  uploadCleanupSafetyNet,
} from '../../app/utils/upload_cleanup.js';

// Minimal fake res matching route-timeout.test.ts's convention: a real
// listener map + emit(), not a mock library, so 'finish'/'close' fire exactly
// like Express would rather than just asserting `.on` was called.
type FakeRes = {
  listeners: Record<string, Array<() => void>>;
  on: (event: string, cb: () => void) => void;
  emit: (event: string) => void;
};

const makeRes = (): FakeRes => {
  const res: FakeRes = {
    listeners: {},
    on(event, cb) {
      (this.listeners[event] ??= []).push(cb);
    },
    emit(event) {
      this.listeners[event]?.forEach((cb) => cb());
    },
  };
  return res;
};

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

  // app.ts's request-scoped safety net (aexa-server#305). #309: a client that
  // disconnects after multer writes the temp file but before the response
  // completes only ever fires 'close', never 'finish' — so the original
  // finish-only listener left that file on disk forever. Covers the same gap
  // route_timeout.ts's res.on('finish') + res.on('close') pair covers, for
  // the same reason.
  describe('uploadCleanupSafetyNet', () => {
    it('cleans up on a normal response completion (finish fires)', async () => {
      const file = writeTempFile('finished.pdf');
      const req = { file };
      const res = makeRes();

      uploadCleanupSafetyNet(req as never, res as never, vi.fn());
      res.emit('finish');
      await vi.waitFor(() => expect(fs.existsSync(file.path)).toBe(false));
    });

    it('cleans up on a client disconnect where only close fires, never finish (#309)', async () => {
      const file = writeTempFile('aborted.pdf');
      const req = { file };
      const res = makeRes();

      uploadCleanupSafetyNet(req as never, res as never, vi.fn());
      // Simulates a client abort mid-upload: the connection tears down and
      // Express/Node fire 'close' without ever firing 'finish'.
      res.emit('close');
      await vi.waitFor(() => expect(fs.existsSync(file.path)).toBe(false));
    });

    it('does not throw or double-report an error if both finish and close fire for the same request', async () => {
      const file = writeTempFile('both.pdf');
      const req = { file };
      const res = makeRes();

      uploadCleanupSafetyNet(req as never, res as never, vi.fn());
      res.emit('finish');
      res.emit('close');

      await vi.waitFor(() => expect(fs.existsSync(file.path)).toBe(false));
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('leaves a file alone once it has been marked handled, regardless of which event fires', async () => {
      const file = writeTempFile('handled-safety-net.pdf');
      markFileHandled(file);
      const req = { file };
      const res = makeRes();

      uploadCleanupSafetyNet(req as never, res as never, vi.fn());
      res.emit('close');
      res.emit('finish');

      // Give any (incorrect) async cleanup a tick to run before asserting.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(fs.existsSync(file.path)).toBe(true);
    });

    it('calls next() synchronously so the request pipeline is not blocked', () => {
      const req = { file: undefined };
      const res = makeRes();
      const next = vi.fn();

      uploadCleanupSafetyNet(req as never, res as never, next);

      expect(next).toHaveBeenCalledOnce();
    });
  });
});
