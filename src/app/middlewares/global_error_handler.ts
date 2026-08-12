import { ErrorRequestHandler } from 'express';
import multer from 'multer';
import { ZodError } from 'zod';
import { configs } from '../configs/index.js';
import handleZodError from '../errors/zodError.js';
import { logger } from '../lib/logger.js';
import { TErrorSources } from '../types/error.js';
import { AppError } from '../utils/app_error.js';
import { MAX_FILE_SIZE_BYTES } from './uploader.js';
import { cleanupUnhandledRequestFiles } from '../utils/upload_cleanup.js';

const globalErrorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  // uploader.ts writes multipart uploads to local disk before any downstream
  // middleware/service runs. The only cleanup that existed was inside
  // uploadCloud (cloudinary.ts), reached only on a *successful* hand-off — so
  // any request that throws after multer but before uploadCloud is called
  // (a role-check throw in audit.service.ts/compliance.service.ts, a
  // JSON-parse failure in template.route.ts/profile.route.ts, failed
  // validation, etc.) leaked the local file forever. Fire-and-forget here:
  // cleanupUnhandledRequestFiles never rejects (cleanupUploadedFile swallows
  // its own errors), and cleanup must not delay or alter the error response
  // already being sent below. See aexa-server#305.
  void cleanupUnhandledRequestFiles(req);

  let statusCode = 500;
  let message = 'Something went wrong!';
  let errorSources: TErrorSources = [
    {
      path: '',
      message: 'Something went wrong',
    },
  ];

  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
    statusCode = 400;
    // This is multer's own top-level `limits.fileSize`, the largest
    // per-mimetype bucket (see uploader.ts) -- a genuinely oversized file
    // of any type. A smaller file that's still over its own *tighter*
    // per-type budget is instead caught by enforceUploadSizeLimit
    // (uploader.ts), which throws its own AppError with the right number.
    message = `File exceeds the ${Math.floor(MAX_FILE_SIZE_BYTES / (1024 * 1024))} MB size limit.`;
    errorSources = [{ path: 'file', message }];
  } else if (err instanceof ZodError) {
    const simplifiedError = handleZodError(err);
    statusCode = simplifiedError?.statusCode;
    message = simplifiedError?.message;
    errorSources = simplifiedError?.errorSources;
  } else if (err instanceof AppError) {
    statusCode = err?.statusCode;
    message = err.message;
    errorSources = [
      {
        path: '',
        message: err?.message,
      },
    ];
  } else if (err instanceof Error) {
    // aexa-server#291 — an unrecognized Error (raw Prisma/driver error, etc.)
    // must not have its .message forwarded to the client: those messages can
    // carry file paths, model/column/constraint names, or DB hostnames.
    // Log the real error server-side and return the same fixed, safe message
    // as the top-level default, matching wrapAiServiceError's convention
    // (ai.service.ts) of logging full detail internally and only ever
    // exposing a generic client-facing message for errors we didn't craft.
    logger.error({ err }, err.message);
    errorSources = [
      {
        path: '',
        message: 'Something went wrong',
      },
    ];
  }

  res.status(statusCode).json({
    success: false,
    message,
    errorSources,
    stack: configs.env === 'development' ? err?.stack : null,
  });
};

export default globalErrorHandler;
