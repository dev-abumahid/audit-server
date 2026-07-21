import app from './app.js';
import { configs } from './app/configs/index.js';
import { logger } from './app/lib/logger.js';
import { prisma } from './app/lib/prisma.js';
import './app/queues/workers.js';

async function main() {
  try {
    // 1. FIRST connect DB
    await prisma.$connect();
    logger.info('Database connected');

    // 2. THEN start server
    app.listen(configs.port, '0.0.0.0', () => {
      logger.info(`Server is running on port ${configs.port}`);
    });
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
