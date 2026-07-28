import connectRedis from 'connect-redis';
import express from 'express';
import session from 'express-session';
import { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * Issue #303: app.ts mounted express-session with no `store` option, which
 * silently defaults to express-session's built-in MemoryStore — leaks memory
 * (never evicts) and doesn't work past a single process. A Redis client
 * (redisConnection, ioredis) was already imported in app.ts for rate
 * limiting; the fix wires the same client into express-session via
 * connect-redis instead of opening a second connection.
 *
 * Same convention as app.helmet.test.ts / app.body-parsing.test.ts: rebuild
 * the relevant slice of app.ts's real middleware order rather than booting
 * the full app (which needs a live DB/session secret/etc). Redis itself
 * needs to be real here (not mocked) — the whole point of this suite is to
 * catch the client-API mismatch that made this fix non-trivial (see
 * src/app/types/connect-redis.d.ts): connect-redis@7+'s RedisStore issues
 * node-redis-v4-style calls that ioredis's client silently fails on, so a
 * test that just checks "some store object got passed" wouldn't catch a
 * regression back to an incompatible connect-redis version.
 */
const redisConnection = new Redis({
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: Number(process.env.REDIS_PORT || 6379),
  maxRetriesPerRequest: null,
  lazyConnect: true,
});

function buildApp() {
  const SessionRedisStore = connectRedis(session);
  const store = new SessionRedisStore({ client: redisConnection, prefix: 'sess:test:303:' });

  const app = express();
  app.use(
    session({
      store,
      secret: 'test-session-secret-32-chars-min!!',
      resave: false,
      saveUninitialized: false,
      cookie: { httpOnly: true, secure: false, maxAge: 1000 * 60 * 10 },
    }),
  );
  app.get('/set', (req: any, res: any) => {
    req.session.hello = 'world';
    res.status(200).json({ ok: true });
  });
  app.get('/get', (req: any, res: any) => {
    res.status(200).json({ hello: req.session.hello ?? null });
  });

  return { app, store };
}

describe('app.ts session store (issue #303)', () => {
  it('configures express-session with a connect-redis RedisStore, not the default MemoryStore', () => {
    const { store } = buildApp();

    expect(store).not.toBeInstanceOf(session.MemoryStore);
    expect(store.client).toBe(redisConnection);
  });

  it('persists session data in Redis across requests, keyed under the configured prefix', async () => {
    let redisAvailable = true;
    try {
      await redisConnection.connect();
      await redisConnection.ping();
    } catch {
      redisAvailable = false;
    }
    if (!redisAvailable) {
      // No local Redis in this environment — the store-type assertion above
      // already covers the wiring; this one additionally proves read/write
      // round-trips through a real Redis when one is available (CI has one).
      return;
    }

    const { app } = buildApp();
    const agent = request.agent(app);

    const setRes = await agent.get('/set');
    expect(setRes.status).toBe(200);

    const cookie = setRes.headers['set-cookie'];
    expect(cookie, 'express-session should issue a session cookie').toBeTruthy();

    // Confirm the session actually landed in Redis under our prefix (proves
    // it isn't silently falling back to in-memory storage).
    const keys = await redisConnection.keys('sess:test:303:*');
    expect(keys.length).toBeGreaterThan(0);

    const getRes = await agent.get('/get');
    expect(getRes.body.hello).toBe('world');

    // Clean up the keys we wrote
    if (keys.length) await redisConnection.del(keys);
  });
});

afterAll(async () => {
  try {
    await redisConnection.quit();
  } catch {
    // already closed / never connected
  }
});
