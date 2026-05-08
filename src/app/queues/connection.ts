import { Redis } from 'ioredis';
import { configs } from '../configs/index.js';

export const redisConnection = createRedisConnection();

function createRedisConnection() {
  const isHosted = configs.redis_config.hosted_redis_connection === 'true';

  let redis: Redis;

  try {
    if (isHosted) {
      if (!configs.redis_config.hosted_redis_db_url) {
        throw new Error('Missing hosted Redis URL');
      }

      console.log('🔗 Connecting to hosted Redis');

      redis = new Redis(configs.redis_config.hosted_redis_db_url, {
        tls: {},
        maxRetriesPerRequest: null,
      });
    } else {
      console.log('🔗 Connecting to local Redis (docker service)');

      redis = new Redis({
        host: configs.redis_config.host || 'server_redis',
        port: Number(configs.redis_config.port || 6379),
        maxRetriesPerRequest: null,
      });
    }

    // ✅ IMPORTANT: error handling
    redis.on('connect', () => {
      console.log('✅ Redis connected');
    });

    redis.on('error', (err) => {
      console.error('❌ Redis error:', err);
    });

    redis.on('close', () => {
      console.warn('⚠️ Redis connection closed');
    });

    return redis;
  } catch (err) {
    console.error('❌ Failed to create Redis connection:', err);
    throw err;
  }
}
