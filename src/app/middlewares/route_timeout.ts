import { NextFunction, Request, Response } from 'express';
import { logger } from '../lib/logger.js';

/**
 * Bounds a single route's total request/response cycle to `ms` milliseconds.
 *
 * Why this exists (#220): the report generate pipeline runs synchronously in
 * one request (fetch org data -> aexa-ai -> Puppeteer render -> S3 upload) and
 * nothing bounded the Express route itself — only the inner aexa-ai fetch had a
 * 90s abort. A comment claimed a "120s route timeout" that did not exist, so if
 * a reverse proxy in front of the app had a shorter default (60s is common) the
 * client got a 504 at an arbitrary, proxy-dependent moment while the backend
 * kept running. This makes the failure deterministic and owned by the app: at
 * `ms` we respond 504 exactly once (if nothing has responded yet).
 *
 * Note this only bounds when the *client* is told to give up — the underlying
 * generate pipeline still runs to completion and writes its own terminal
 * READY/FAILED state, and the staleness sweep (#221) reaps anything that dies
 * before it can. That's intentional: it makes the client's timeout consistent
 * without needing to cancel Chromium/S3 mid-flight.
 */
export const routeTimeout = (ms: number) => (req: Request, res: Response, next: NextFunction) => {
  const timer = setTimeout(() => {
    if (res.headersSent) return;
    logger.warn(
      { method: req.method, path: req.originalUrl, timeoutMs: ms },
      'Route timed out before responding',
    );
    res.status(504).json({
      success: false,
      message: 'The request took too long to complete. Please try again shortly.',
    });
  }, ms);

  // Clear the timer once the response finishes or the connection closes so a
  // completed request never fires the timeout and leaks the handle.
  res.on('finish', () => clearTimeout(timer));
  res.on('close', () => clearTimeout(timer));

  next();
};
