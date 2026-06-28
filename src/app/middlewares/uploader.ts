import multer from 'multer';
import path from 'path';
import { AppError } from '../utils/app_error.js';

const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'application/pdf',
]);

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

const storage = multer.diskStorage({
  destination: function (_req, _file, cb) {
    cb(null, path.join(process.cwd(), 'uploads'));
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
