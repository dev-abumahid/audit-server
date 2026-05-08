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
  console.error('UNCAUGHT EXCEPTION:', err);
});

process.on('unhandledRejection', (err) => {
  console.error('UNHANDLED REJECTION:', err);
});
