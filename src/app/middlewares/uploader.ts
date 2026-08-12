import crypto from 'node:crypto';
import fs from 'fs';
import multer from 'multer';
import { NextFunction, Request, Response } from 'express';
import path from 'path';
import { logger } from '../lib/logger.js';
import { AppError } from '../utils/app_error.js';

const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'application/pdf',
  // Video support (aexa-frontend's inspection/finding media uploads have
  // advertised accept="video/*" since before this allowlist existed --
  // #10's original hardening pass never reconciled the two, an oversight
  // rather than a deliberate exclusion; there's no transcoding pipeline or
  // video-aware step anywhere downstream, uploadCloud (cloudinary.ts) is a
  // type-agnostic raw S3 pass-through).
  'video/mp4',
  'video/quicktime', // .mov -- the default export format on iOS
  'video/webm',
]);

// Allowlist of extensions we'll ever write to disk, independent of
// ALLOWED_MIME_TYPES (client-supplied mimetype and client-supplied filename
// extension are both untrusted, so we don't derive one from the other).
// Kept intentionally in sync with ALLOWED_MIME_TYPES's file types.
const ALLOWED_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.gif',
  '.pdf',
  '.mp4',
  '.mov',
  '.webm',
]);

// Video files are legitimately much larger than a photo or a scanned PDF, so
// a single flat cap forces an awkward choice between throttling video or
// leaving images/PDFs needlessly permissive. Per-mimetype caps instead --
// multer's own `limits.fileSize` (below) can only take one flat number, so
// that's set to the *largest* bucket (video) to avoid multer truncating a
// legitimate video mid-stream; enforceUploadSizeLimit (below) then applies
// the tighter per-type cap after multer has finished writing the file.
const IMAGE_AND_DOCUMENT_MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const VIDEO_MAX_BYTES = 50 * 1024 * 1024; // 50 MB
const MAX_FILE_SIZE_BYTES = VIDEO_MAX_BYTES;

const maxBytesForMimeType = (mimetype: string): number =>
  mimetype.startsWith('video/') ? VIDEO_MAX_BYTES : IMAGE_AND_DOCUMENT_MAX_BYTES;

// The Docker image creates this directory as a build step (see .gitignore's
// comment on /uploads/), but nothing did the equivalent for local dev or any
// other environment — multer's diskStorage doesn't create a missing
// destination itself, it just fails the write with ENOENT. Creating it
// once here, at module load, means every consumer of this shared middleware
// (inspection, note, action) works regardless of how the process was
// started.
//
// Wrapped in try/catch rather than left to throw: this runs at import time,
// before the Express app exists, so an unhandled throw here (e.g. a
// read-only root filesystem in some container/serverless deployment) would
// take the entire process down over a directory only the upload endpoints
// need — a much bigger blast radius than the ENOENT this is fixing. Log and
// continue; if the directory truly can't be created, uploads fail with a
// clear disk error at request time instead, same as before this fix.
const UPLOADS_DIR = path.join(process.cwd(), 'uploads');
try {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
} catch (err) {
  logger.error({ err, UPLOADS_DIR }, 'Failed to create uploads directory at startup');
}

const storage = multer.diskStorage({
  destination: function (_req, _file, cb) {
    cb(null, UPLOADS_DIR);
  },
  // Never trust file.originalname as (or as input to) the disk filename —
  // it's fully client-controlled and can contain path traversal sequences
  // (`../../etc/passwd`) or collide with/overwrite another upload. Generate
  // the disk filename server-side; the client-supplied name is still
  // available on req.file.originalname for anything that needs it for
  // display (e.g. ai.service.ts's PineconeDocument.fileName), untouched by
  // this change since multer always populates it independent of `filename`.
  filename: function (_req, file, cb) {
    // path.extname on the raw originalname, not a trusted value yet — only
    // used to check membership in the allowlist below, never written
    // directly to disk.
    const rawExt = path.extname(file.originalname).toLowerCase();
    const ext = ALLOWED_EXTENSIONS.has(rawExt) ? rawExt : '';
    cb(null, `${crypto.randomUUID()}${ext}`);
  },
});

const uploader = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE_BYTES },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME_TYPES.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(
        new AppError(
          `File type '${file.mimetype}' is not allowed. Accepted: JPEG, PNG, WebP, GIF, PDF, MP4, MOV, WebM.`,
          400,
        ),
      );
    }
  },
});

// multer's own `limits.fileSize` only accepts one flat number, so it's set
// above to VIDEO_MAX_BYTES (the largest bucket) to avoid truncating a
// legitimate video mid-stream. This runs after uploader.single(...) in the
// route chain and applies the tighter per-mimetype cap now that the file's
// real size and type are both known -- an image/PDF that snuck in under the
// 50 MB ceiling but over its own 10 MB budget is rejected here instead.
// Cleanup is deliberately NOT done here: global_error_handler.ts already
// calls cleanupUnhandledRequestFiles(req) unconditionally for any error that
// reaches it, same as every other post-multer rejection in this codebase
// (see upload_cleanup.ts).
export function enforceUploadSizeLimit(req: Request, _res: Response, next: NextFunction): void {
  const file = req.file;
  if (!file) {
    next();
    return;
  }
  const limit = maxBytesForMimeType(file.mimetype);
  if (file.size > limit) {
    next(new AppError(`File exceeds the ${Math.floor(limit / (1024 * 1024))} MB size limit.`, 400));
    return;
  }
  next();
}

export { MAX_FILE_SIZE_BYTES };
export default uploader;
