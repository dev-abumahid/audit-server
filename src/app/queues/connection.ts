import { Redis } from 'ioredis';
import { configs } from '../configs/index.js';
import { logger } from '../lib/logger.js';

export const redisConnection = createRedisConnection();

function createRedisConnection() {
  const isHosted = configs.redis_config.hosted_redis_connection === 'true';

  let redis: Redis;

  try {
    if (isHosted) {
      if (!configs.redis_config.hosted_redis_db_url) {
        throw new Error('Missing hosted Redis URL');
      }
      redis = new Redis(configs.redis_config.hosted_redis_db_url, {
        tls: {},
        maxRetriesPerRequest: null,
      });
    } else {
      redis = new Redis({
        host: configs.redis_config.host || 'server_redis',
        port: Number(configs.redis_config.port || 6379),
        maxRetriesPerRequest: null,
      });
    }

    redis.on('connect', () => {
      logger.info('Redis connected');
    });

    redis.on('error', (err) => {
      logger.error({ err }, 'Redis error');
    });

    redis.on('close', () => {
      logger.warn('Redis connection closed');
    });

    return redis;
  } catch (err) {
    logger.error({ err }, 'Failed to create Redis connection');
    throw err;
  }
}
