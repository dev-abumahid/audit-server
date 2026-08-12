import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import globalErrorHandler from '../../app/middlewares/global_error_handler.js';
import uploader, { enforceUploadSizeLimit } from '../../app/middlewares/uploader.js';
import { AppError } from '../../app/utils/app_error.js';
import { cleanupUnhandledRequestFiles, markFileHandled } from '../../app/utils/upload_cleanup.js';

// uploader.ts writes to `${process.cwd()}/uploads` via multer.diskStorage — that
// directory only exists inside the Docker image (created in the Dockerfile), not
// in local dev or CI, so create/clean it up around these tests.
const UPLOAD_DIR = path.join(process.cwd(), 'uploads');

// Mirrors the real route wiring (uploader.single('file') immediately
// followed by enforceUploadSizeLimit — see every *.route.ts consumer) so
// this suite exercises the same middleware chain production actually runs,
// not just the multer instance in isolation.
function buildApp() {
  const app = express();
  app.post('/upload', uploader.single('file'), enforceUploadSizeLimit, (req, res) => {
    res.status(200).json({ success: true, file: req.file });
  });
  app.use(globalErrorHandler);
  return app;
}

describe('uploader middleware (file upload validation)', () => {
  beforeAll(() => {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  });

  afterEach(() => {
    for (const file of fs.readdirSync(UPLOAD_DIR)) {
      fs.rmSync(path.join(UPLOAD_DIR, file));
    }
  });

  afterAll(() => {
    fs.rmSync(UPLOAD_DIR, { recursive: true, force: true });
  });

  it('accepts a PDF under the size limit', async () => {
    const app = buildApp();

    const res = await request(app)
      .post('/upload')
      .attach('file', Buffer.from('%PDF-1.4 fake pdf content'), {
        filename: 'doc.pdf',
        contentType: 'application/pdf',
      });

    expect(res.status).toBe(200);
    // The client-supplied name is preserved on req.file.originalname for
    // display purposes, but must never be used verbatim as the disk
    // filename (that's the path traversal vector this suite guards
    // against) — assert the two are different and that the generated disk
    // filename is what actually exists on disk.
    expect(res.body.file.originalname).toBe('doc.pdf');
    expect(res.body.file.filename).not.toBe('doc.pdf');
    expect(fs.existsSync(path.join(UPLOAD_DIR, 'doc.pdf'))).toBe(false);
    expect(fs.existsSync(path.join(UPLOAD_DIR, res.body.file.filename))).toBe(true);
  });

  it('generates a server-side disk filename instead of trusting file.originalname', async () => {
    const app = buildApp();

    const res = await request(app).post('/upload').attach('file', Buffer.from('fake jpeg bytes'), {
      filename: 'photo.jpg',
      contentType: 'image/jpeg',
    });

    expect(res.status).toBe(200);
    const { filename, originalname } = res.body.file;
    expect(originalname).toBe('photo.jpg');
    // UUID (with the allowlisted extension preserved) rather than the raw
    // client-supplied name.
    expect(filename).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$/);
  });

  it('does not let path-traversal-style originalname reach the disk filename', async () => {
    const app = buildApp();

    // multer/busboy already strips directory separators out of the
    // multipart filename header before file.originalname is set (so
    // originalname itself comes through as `passwd.pdf`, not the full
    // traversal string) — but that's an incidental property of the
    // upstream library, not something this middleware should rely on.
    // What actually matters, and what this test guards, is that the disk
    // filename this middleware generates never derives from
    // file.originalname at all.
    const res = await request(app)
      .post('/upload')
      .attach('file', Buffer.from('%PDF-1.4 fake pdf content'), {
        filename: '../../../../etc/passwd.pdf',
        contentType: 'application/pdf',
      });

    expect(res.status).toBe(200);
    const { filename, originalname } = res.body.file;
    expect(filename).not.toContain('..');
    expect(filename).not.toContain('/');
    expect(filename).not.toContain('etc');
    expect(filename).not.toBe(originalname);
    // Must have landed inside UPLOAD_DIR, not escaped it.
    expect(fs.existsSync(path.join(UPLOAD_DIR, filename))).toBe(true);
    expect(fs.existsSync('/etc/passwd.pdf')).toBe(false);
  });

  it('drops an unrecognized/unexpected extension rather than trusting the client-sent one', async () => {
    const app = buildApp();

    const res = await request(app)
      .post('/upload')
      .attach('file', Buffer.from('%PDF-1.4 fake pdf content'), {
        // mimetype is allowed (application/pdf) but the client-sent
        // extension is not in the disk-filename allowlist.
        filename: 'evil.pdf.exe',
        contentType: 'application/pdf',
      });

    expect(res.status).toBe(200);
    const { filename } = res.body.file;
    expect(filename.endsWith('.exe')).toBe(false);
    expect(filename).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('accepts a JPEG image under the size limit', async () => {
    const app = buildApp();

    const res = await request(app).post('/upload').attach('file', Buffer.from('fake jpeg bytes'), {
      filename: 'photo.jpg',
      contentType: 'image/jpeg',
    });

    expect(res.status).toBe(200);
  });

  it('rejects a disallowed MIME type with 400', async () => {
    const app = buildApp();

    const res = await request(app)
      .post('/upload')
      .attach('file', Buffer.from('#!/bin/sh\necho hi'), {
        filename: 'script.sh',
        contentType: 'application/x-sh',
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/not allowed/i);
    expect(fs.existsSync(path.join(UPLOAD_DIR, 'script.sh'))).toBe(false);
  });

  // Images/PDFs get a 10 MB budget; video gets 50 MB (see uploader.ts). Since
  // multer's own top-level `limits.fileSize` has to be one flat number, it's
  // set to the *largest* bucket (video's 50 MB) — a 10MB+1 PDF slips past
  // multer itself and is instead caught by enforceUploadSizeLimit, the
  // per-mimetype check that runs right after uploader.single(...).
  it('rejects a non-video file over its 10MB per-type limit with 400 (enforceUploadSizeLimit)', async () => {
    const app = buildApp();
    const oversized = Buffer.alloc(10 * 1024 * 1024 + 1, 'a');

    const res = await request(app).post('/upload').attach('file', oversized, {
      filename: 'huge.pdf',
      contentType: 'application/pdf',
    });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/10 MB/i);
  }, 15000);

  it('allows a PDF just under the 10MB limit through', async () => {
    const app = buildApp();
    const justUnderLimit = Buffer.alloc(10 * 1024 * 1024 - 1024, 'a');

    const res = await request(app).post('/upload').attach('file', justUnderLimit, {
      filename: 'large-but-ok.pdf',
      contentType: 'application/pdf',
    });

    expect(res.status).toBe(200);
  }, 15000);

  it('accepts an MP4 video under its 50MB limit', async () => {
    const app = buildApp();
    const video = Buffer.alloc(1 * 1024 * 1024, 'a'); // 1 MB, well under budget

    const res = await request(app).post('/upload').attach('file', video, {
      filename: 'clip.mp4',
      contentType: 'video/mp4',
    });

    expect(res.status).toBe(200);
  });

  it('accepts a .mov (video/quicktime) and a .webm video', async () => {
    const app = buildApp();

    for (const [filename, contentType] of [
      ['clip.mov', 'video/quicktime'],
      ['clip.webm', 'video/webm'],
    ] as const) {
      const res = await request(app)
        .post('/upload')
        .attach('file', Buffer.from('fake video bytes'), { filename, contentType });
      expect(res.status).toBe(200);
    }
  });

  it('allows a video just under its 50MB limit through, well past the 10MB image/PDF budget', async () => {
    const app = buildApp();
    const justUnderVideoLimit = Buffer.alloc(50 * 1024 * 1024 - 1024, 'a');

    const res = await request(app).post('/upload').attach('file', justUnderVideoLimit, {
      filename: 'large-but-ok.mp4',
      contentType: 'video/mp4',
    });

    expect(res.status).toBe(200);
  }, 15000);

  it('rejects a video over its 50MB per-type limit with 400 (enforceUploadSizeLimit)', async () => {
    const app = buildApp();
    const oversizedVideo = Buffer.alloc(50 * 1024 * 1024 + 1, 'a');

    const res = await request(app).post('/upload').attach('file', oversizedVideo, {
      filename: 'huge.mp4',
      contentType: 'video/mp4',
    });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/50 MB/i);
  }, 15000);

  // multer's own top-level limits.fileSize (the video bucket's 50 MB) is
  // still the hard ceiling for every mimetype, video included — confirms
  // enforceUploadSizeLimit isn't the *only* thing standing between a client
  // and an unbounded upload.
  it('rejects a file over the top-level 50MB multer limit regardless of type', async () => {
    const app = buildApp();
    const massivelyOversized = Buffer.alloc(50 * 1024 * 1024 + 1024, 'a');

    const res = await request(app).post('/upload').attach('file', massivelyOversized, {
      filename: 'way-too-big.mp4',
      contentType: 'video/mp4',
    });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/50 MB/i);
  }, 15000);

  // aexa-server#305 — uploader.ts writes multipart uploads to local disk
  // before any downstream middleware/service runs. Previously the only
  // cleanup was inside uploadCloud (cloudinary.ts), reached only after a
  // *successful* hand-off, so any request that threw after multer but before
  // uploadCloud (a role-check throw in audit.service.ts/compliance.service.ts,
  // a JSON-parse failure in template.route.ts/profile.route.ts, a failed
  // validation, ...) leaked the local temp file forever. These build a real
  // Express app around the real uploader middleware and a real
  // global_error_handler/safety-net hook, kept in this file (not a separate
  // one) so they share this suite's single beforeAll/afterEach/afterAll
  // ownership of UPLOAD_DIR rather than racing another test file that also
  // creates/tears down the same real, hardcoded directory.
  describe('temp file cleanup (aexa-server#305)', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    async function flush() {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    it('cleans up the local file when a role-check throw (AppError) happens after multer, before uploadCloud', async () => {
      const app = express();
      app.post(
        '/upload',
        uploader.single('file'),
        (_req: Request, _res: Response, next: NextFunction) => {
          // Simulates assertCanWriteOrgResource throwing inside
          // audit.service.ts's upload_audit_report_into_storage /
          // compliance.service.ts's upload_compliance_attachment_into_aws —
          // uploadCloud is never reached.
          next(new AppError('Forbidden: write role required', 403));
        },
        globalErrorHandler,
      );

      const res = await request(app)
        .post('/upload')
        .attach('file', Buffer.from('%PDF-1.4 fake pdf content'), {
          filename: 'report.pdf',
          contentType: 'application/pdf',
        });

      expect(res.status).toBe(403);
      await flush();

      expect(fs.readdirSync(UPLOAD_DIR)).toHaveLength(0);
    });

    it('cleans up the local file on a JSON-parse failure (template.route.ts/profile.route.ts shape)', async () => {
      const app = express();
      app.post(
        '/upload',
        uploader.single('file'),
        (req: Request, _res: Response, next: NextFunction) => {
          try {
            JSON.parse((req.body?.data as string) ?? '');
            next();
          } catch {
            next(new AppError('Invalid JSON in request body', 400));
          }
        },
        globalErrorHandler,
      );

      const res = await request(app)
        .post('/upload')
        .field('data', '{not valid json')
        .attach('file', Buffer.from('fake jpeg bytes'), {
          filename: 'photo.jpg',
          contentType: 'image/jpeg',
        });

      expect(res.status).toBe(400);
      await flush();

      expect(fs.readdirSync(UPLOAD_DIR)).toHaveLength(0);
    });

    // Found by review of the video-upload/per-type-size-limit PR: the file
    // enforceUploadSizeLimit rejects has already been fully written to disk
    // by multer by the time the size check runs (that's the whole point --
    // the real size isn't known until then). enforceUploadSizeLimit itself
    // deliberately does no cleanup (see its own comment in uploader.ts),
    // relying on this same global_error_handler.ts safety net as every
    // other post-multer rejection above -- this test actually exercises
    // that path instead of just trusting the comment.
    it('cleans up the local file when enforceUploadSizeLimit rejects it for exceeding its per-type budget', async () => {
      const app = buildApp();
      const oversized = Buffer.alloc(10 * 1024 * 1024 + 1, 'a');

      const res = await request(app).post('/upload').attach('file', oversized, {
        filename: 'huge.pdf',
        contentType: 'application/pdf',
      });

      expect(res.status).toBe(400);
      await flush();

      expect(fs.readdirSync(UPLOAD_DIR)).toHaveLength(0);
    }, 15000);

    it('the res.on("finish") safety net cleans up a file left unhandled on a successful (non-error) response', async () => {
      const app = express();
      app.use((req: Request, res: Response, next: NextFunction) => {
        res.on('finish', () => {
          void cleanupUnhandledRequestFiles(req);
        });
        next();
      });
      app.post('/upload', uploader.single('file'), (_req: Request, res: Response) => {
        // Simulates a route that, for whatever reason (a bug, a code path
        // that forgot to call uploadCloud), returns 200 without ever handing
        // the file off — the safety net is the last line of defense here.
        res.status(200).json({ success: true });
      });
      app.use(globalErrorHandler);

      const res = await request(app)
        .post('/upload')
        .attach('file', Buffer.from('%PDF-1.4 fake pdf content'), {
          filename: 'never-handled.pdf',
          contentType: 'application/pdf',
        });

      expect(res.status).toBe(200);
      await flush();

      expect(fs.readdirSync(UPLOAD_DIR)).toHaveLength(0);
    });

    it('the res.on("finish") safety net does NOT delete a file that was marked handled', async () => {
      const app = express();
      app.use((req: Request, res: Response, next: NextFunction) => {
        res.on('finish', () => {
          void cleanupUnhandledRequestFiles(req);
        });
        next();
      });
      app.post('/upload', uploader.single('file'), (req: Request, res: Response) => {
        // Simulates uploadCloud having taken ownership of the file (marked
        // right before it starts its own upload+cleanup — see cloudinary.ts).
        markFileHandled(req.file);
        res.status(200).json({ success: true });
      });
      app.use(globalErrorHandler);

      const res = await request(app)
        .post('/upload')
        .attach('file', Buffer.from('fake jpeg bytes'), {
          filename: 'handled.jpg',
          contentType: 'image/jpeg',
        });

      expect(res.status).toBe(200);
      await flush();

      // Exactly one file should remain: the one marked handled above.
      expect(fs.readdirSync(UPLOAD_DIR)).toHaveLength(1);
    });
  });
});
