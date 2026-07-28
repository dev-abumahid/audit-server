import fs from 'fs/promises';
import { logger } from '../lib/logger.js';

// Minimal shape shared with multer's file object (see IFile in cloudinary.ts) —
// only `path` is actually needed for cleanup.
type UploadedFileLike = { path?: unknown } & Record<PropertyKey, unknown>;

// Symbol-keyed rather than a plain string property: avoids any chance of
// collision with multer's own file fields, and won't show up if a caller ever
// logs/serializes the file object. It survives across the file object's
// lifetime because every consumer in this codebase (uploadCloud and its
// callers) is handed the *same* req.file/req.files object by reference, never
// a clone — see aexa-server#305.
const HANDLED = Symbol('uploadHandled');

/**
 * Marks a multer file object as "handed off" — its disk lifecycle is now
 * owned by whoever called this (uploadCloud, right before it starts its own
 * upload+cleanup in cloudinary.ts). This stops the res.on('finish') safety
 * net and the global error handler from racing a file that's mid-upload, or
 * double-deleting one uploadCloud already removed.
 *
 * An explicit flag is used instead of checking fs.existsSync at cleanup time
 * because existence-checking races: uploadCloud can still be awaiting its S3
 * PUT when the response finishes (best-effort attachment uploads that don't
 * block the response — see note.service.ts), so "file still exists on disk"
 * does not reliably mean "nobody's handling this file."
 */
export function markFileHandled(file: unknown): void {
  if (file && typeof file === 'object') {
    (file as UploadedFileLike)[HANDLED] = true;
  }
}

export function isFileHandled(file: unknown): boolean {
  return !!(file && typeof file === 'object' && (file as UploadedFileLike)[HANDLED]);
}

/**
 * Deletes a multer-written temp file from local disk, tolerating "already
 * gone" as success. Cleanup must never itself crash the process or mask
 * whatever error/response is already in flight: ENOENT almost always just
 * means uploadCloud (or an earlier cleanup pass) already removed the file,
 * not a bug, so it's swallowed silently; anything else (EPERM, EBUSY, a
 * read-only/full disk) is logged but still swallowed.
 */
export async function cleanupUploadedFile(file: unknown): Promise<void> {
  const filePath = (file as UploadedFileLike | null | undefined)?.path;
  if (typeof filePath !== 'string' || filePath.length === 0) return;
  try {
    await fs.unlink(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      logger.error({ err, filePath }, 'Failed to clean up uploaded temp file');
    }
  }
}

/**
 * Normalizes every multer file object attached to a request into a flat
 * list, regardless of which upload mode the route uses: .single() populates
 * req.file, .array() populates req.files as File[], .fields() populates it
 * as { [fieldname]: File[] }. No route in this codebase uses array/fields
 * mode today (all use uploader.single('file')) but this keeps cleanup
 * working the day one does, per aexa-server#305.
 */
export function collectRequestFiles(req: { file?: unknown; files?: unknown }): unknown[] {
  const files: unknown[] = [];
  if (req.file) files.push(req.file);
  if (Array.isArray(req.files)) {
    files.push(...req.files);
  } else if (req.files && typeof req.files === 'object') {
    for (const value of Object.values(req.files as Record<string, unknown>)) {
      if (Array.isArray(value)) files.push(...value);
    }
  }
  return files;
}

/**
 * Cleans up every file multer attached to this request that hasn't already
 * been marked handled. Safe to call more than once for the same request
 * (e.g. once from global_error_handler.ts, again from the res.on('finish')
 * safety net) — cleanupUploadedFile's ENOENT-swallowing makes a repeat call
 * against an already-deleted file a silent no-op, not a crash.
 */
export async function cleanupUnhandledRequestFiles(req: {
  file?: unknown;
  files?: unknown;
}): Promise<void> {
  const files = collectRequestFiles(req).filter((file) => !isFileHandled(file));
  await Promise.all(files.map((file) => cleanupUploadedFile(file)));
}
