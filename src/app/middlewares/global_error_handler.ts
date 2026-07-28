import { ErrorRequestHandler } from 'express';
import multer from 'multer';
import { ZodError } from 'zod';
import { configs } from '../configs/index.js';
import handleZodError from '../errors/zodError.js';
import { logger } from '../lib/logger.js';
import { TErrorSources } from '../types/error.js';
import { AppError } from '../utils/app_error.js';

const globalErrorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
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
    message = 'File exceeds the 10 MB size limit.';
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
