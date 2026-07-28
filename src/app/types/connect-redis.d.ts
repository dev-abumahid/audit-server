// connect-redis@6.x ships no bundled types, and the DefinitelyTyped package
// (@types/connect-redis) is stale and pulls in an unrelated `redis` (node-redis)
// type reference we don't otherwise depend on — this codebase talks to Redis
// exclusively through ioredis (see src/app/queues/connection.ts). This is a
// minimal, accurate declaration for the surface we actually use: the
// session-store factory wired up in src/app.ts (issue #303).
//
// Pinned to connect-redis@6 deliberately, not the current major (10.x):
// v7+ rewrote RedisStore around the node-redis v4 client API (options-object
// `set(key, val, { expiration: {...} })`, `scanIterator`), which is not
// wire-compatible with ioredis's client (confirmed empirically against a
// local Redis: the v7+-style call fails with "ERR syntax error" against
// ioredis, while v6's array/callback-style client calls work correctly).
declare module 'connect-redis' {
  import type { Redis, Cluster } from 'ioredis';
  import type { RequestHandler } from 'express';
  import type { SessionOptions, Store } from 'express-session';

  type RedisClient = Redis | Cluster;

  interface RedisStoreOptions {
    client: RedisClient;
    prefix?: string;
    ttl?: number | string | ((store: RedisStore, sess: unknown, sid: string) => number);
    disableTTL?: boolean;
    disableTouch?: boolean;
    scanCount?: number;
    serializer?: { stringify: (obj: unknown) => string; parse: (str: string) => unknown };
  }

  class RedisStore extends Store {
    constructor(options: RedisStoreOptions);
    client: RedisClient;
  }

  function connectRedis(session: (options?: SessionOptions) => RequestHandler): typeof RedisStore;

  export = connectRedis;
}
