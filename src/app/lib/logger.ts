import pino from 'pino';
import { configs } from '../configs/index.js';

export const logger = pino({
  level: configs.env === 'development' ? 'debug' : 'info',
  // transport: configs.env === 'development' ? { target: 'pino-pretty' } : undefined,
});
