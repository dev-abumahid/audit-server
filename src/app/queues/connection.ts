import { QueueOptions } from 'bullmq';
import { Redis } from 'ioredis';
import { configs } from '../configs/index.js';

export let redisConnection: QueueOptions['connection'];

if (configs.redis_config.hosted_redis_connection === 'true') {
  console.log('hosted');
  redisConnection = new Redis(configs.redis_config.hosted_redis_db_url as string, {
    tls: {},
    maxRetriesPerRequest: null,
  }) as any;
} else {
  redisConnection = new Redis({
    host: '127.0.0.1',
    port: 6379,
    maxRetriesPerRequest: null,
  }) as any;
}
