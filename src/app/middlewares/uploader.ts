import fs from 'fs';
import multer from 'multer';
import path from 'path';
import { logger } from '../lib/logger.js';
import { AppError } from '../utils/app_error.js';

const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'application/pdf',
]);

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

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
  filename: function (_req, file, cb) {
    cb(null, file.originalname);
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
          `File type '${file.mimetype}' is not allowed. Accepted: JPEG, PNG, WebP, GIF, PDF.`,
          400,
        ),
      );
    }
  },
});

export default uploader;
