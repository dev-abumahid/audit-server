import type { Worker } from 'bullmq';
import { logger } from './logger.js';

// Docker's default `stop_grace_period` (and compose's recreate-on-`up -d`)
// sends SIGTERM and SIGKILLs ~10s later if the process hasn't exited. This
// timeout must stay comfortably under that so we always exit on our own
// terms — in the drained-cleanly case, or the force-exit case below —
// rather than getting SIGKILLed mid-shutdown with a job half-closed.
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 8500;

// Deliberately structural (not `Pick<http.Server, 'close'>`) so a plain test
// double — `{ close: (cb) => cb() }` — satisfies it without having to shape
// itself like a real http.Server, which returns `this` for chaining and
// would otherwise leak into every mock's type.
type MinimalServer = { close: (callback: (err?: Error) => void) => unknown };
type MinimalWorker = Pick<Worker, 'close'>;
type MinimalPrisma = { $disconnect: () => Promise<unknown> };

export interface GracefulShutdownDeps {
  server: MinimalServer;
  workers: MinimalWorker[];
  prisma: MinimalPrisma;
  timeoutMs?: number;
  /** Injectable for tests; defaults to `process.exit`. */
  exit?: (code: number) => void;
}

/**
 * Builds a signal handler that drains the HTTP server, closes every BullMQ
 * worker, and disconnects Prisma, in that order, before exiting.
 *
 * Order matters: stop accepting new HTTP work first, then let in-flight
 * BullMQ jobs (e.g. an OTP email mid-send) finish via worker.close() before
 * the DB connection they depend on goes away, and only then disconnect
 * Prisma. A safety timeout force-exits if any step hangs, so a stuck
 * in-flight request or job can't block shutdown past the timeout — and
 * can't run the container past Docker's own SIGKILL grace period either.
 *
 * Returns a function safe to wire to both SIGTERM and SIGINT; the second
 * signal (whichever arrives) is a no-op if shutdown is already running.
 */
export function createGracefulShutdown({
  server,
  workers,
  prisma,
  timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
  exit = process.exit.bind(process),
}: GracefulShutdownDeps) {
  let shuttingDown = false;

  return async function gracefulShutdown(signal: string): Promise<void> {
    if (shuttingDown) {
      logger.warn({ signal }, 'Shutdown already in progress, ignoring duplicate signal');
      return;
    }
    shuttingDown = true;
    logger.info({ signal }, 'Received shutdown signal, starting graceful shutdown');

    const forceExitTimer = setTimeout(() => {
      logger.error({ timeoutMs }, 'Graceful shutdown timed out, forcing exit');
      exit(1);
    }, timeoutMs);
    forceExitTimer.unref();

    try {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      logger.info('HTTP server closed, no longer accepting new connections');

      await Promise.all(
        workers.map((worker) =>
          worker.close().catch((err) => logger.error({ err }, 'Error closing a BullMQ worker')),
        ),
      );
      logger.info('BullMQ workers closed');

      await prisma.$disconnect();
      logger.info('Prisma disconnected');

      clearTimeout(forceExitTimer);
      exit(0);
    } catch (err) {
      logger.error({ err }, 'Error during graceful shutdown');
      clearTimeout(forceExitTimer);
      exit(1);
    }
  };
}
