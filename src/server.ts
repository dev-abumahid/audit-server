import app from './app.js';
import { configs } from './app/configs/index.js';
import { logger } from './app/lib/logger.js';
import { prisma } from './app/lib/prisma.js';
import './app/queues/workers.js';

async function main() {
  try {
    app.listen(configs.port, '0.0.0.0', async () => {
      await prisma.$connect();
      logger.info(`Server is running on port ${configs.port}`);
    });
  } catch (error) {
    logger.error(error, 'Error starting server:');
  }
}

main().catch((error) => {
  logger.error(error, 'Error in main function:');
  process.exit(1);
});
