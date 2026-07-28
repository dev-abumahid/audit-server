import app from './app.js';
import { configs } from './app/configs/index.js';
import { createGracefulShutdown } from './app/lib/graceful_shutdown.js';
import { logger } from './app/lib/logger.js';
import { prisma } from './app/lib/prisma.js';
import { externalVerificationEmailWorker } from './app/queues/email/external-verification/external-verification.email.worker.js';
import { orgInviteEmailWorker } from './app/queues/email/org-invite/org-invite.email.worker.js';
import { emailWorker } from './app/queues/email/otp/otp.email.worker.js';
import { resetEmailWorker } from './app/queues/email/reset-password/reset.email.worker.js';
import './app/queues/workers.js';

async function main() {
  try {
    // 1. FIRST connect DB
    await prisma.$connect();
    logger.info('Database connected');

    // 2. THEN start server
    const server = app.listen(configs.port, '0.0.0.0', () => {
      logger.info(`Server is running on port ${configs.port}`);
    });

    // Docker sends SIGTERM on `docker stop` / a `compose up -d` recreate, and
    // PID 1 with no handler for it means the kernel's default action (ignore)
    // applies, so the container just stalls until Docker's grace period
    // expires and SIGKILLs it — resetting in-flight requests (502s) and
    // killing BullMQ jobs mid-flight (e.g. a half-sent OTP email) without
    // ever calling worker.close(), so they retry and can send duplicates
    // (#307). SIGINT gets the same treatment for local `ctrl-c` parity.
    const gracefulShutdown = createGracefulShutdown({
      server,
      workers: [
        emailWorker,
        orgInviteEmailWorker,
        resetEmailWorker,
        externalVerificationEmailWorker,
      ],
      prisma,
    });

    process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => void gracefulShutdown('SIGINT'));
  } catch (error) {
    logger.error(error, 'Startup failed');
    process.exit(1);
  }
}

main();
process.on('uncaughtException', (err) => {
  logger.error(err, 'UNCAUGHT EXCEPTION');
  // Process state may be corrupt after an uncaught exception; exit so the
  // process manager can restart cleanly rather than keep serving requests.
  process.exit(1);
});

process.on('unhandledRejection', (err) => {
  logger.error(err, 'UNHANDLED REJECTION');
});
