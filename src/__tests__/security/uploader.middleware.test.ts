import express from 'express';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import globalErrorHandler from '../../app/middlewares/global_error_handler.js';
import uploader from '../../app/middlewares/uploader.js';

// uploader.ts writes to `${process.cwd()}/uploads` via multer.diskStorage — that
// directory only exists inside the Docker image (created in the Dockerfile), not
// in local dev or CI, so create/clean it up around these tests.
const UPLOAD_DIR = path.join(process.cwd(), 'uploads');

function buildApp() {
  const app = express();
  app.post('/upload', uploader.single('file'), (req, res) => {
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

  it('rejects a file over the 10MB size limit with 400 (multer LIMIT_FILE_SIZE)', async () => {
    const app = buildApp();
    const oversized = Buffer.alloc(10 * 1024 * 1024 + 1, 'a');

    const res = await request(app).post('/upload').attach('file', oversized, {
      filename: 'huge.pdf',
      contentType: 'application/pdf',
    });

    // The uploader middleware itself only enforces MIME type via fileFilter;
    // the size limit is enforced by multer and surfaces through the shared
    // global error handler as 400 (not 413 — see global_error_handler.ts).
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
});
