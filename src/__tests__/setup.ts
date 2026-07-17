/**
 * Global test setup — runs before every test file.
 *
 * Sets the minimum environment variables required for the app to boot,
 * then mocks infrastructure (Redis, rate limiter) so tests run without
 * any external services.
 */

// Required env vars — must be set before any module import reads configs
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-32-chars-min!!';
process.env.ACCESS_TOKEN = 'test-access-token-secret';
process.env.ACCESS_EXPIRES = '15m';
process.env.REFRESH_TOKEN = 'test-refresh-token-secret';
process.env.VERIFIED_TOKEN = 'test-verified-token-secret';
process.env.RESET_SECRET = 'test-reset-secret-distinct-from-verified';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test_db';
// Must be an absolute URL — account.service.ts builds reset/verification
// links as `${front_end_url}/...`, and a test asserting on the resulting
// link's shape parses it with `new URL(...)`, which throws on a relative
// value (e.g. the bare `undefined` this is left as when unset). Not set in
// CI's environment, only picked up locally from a gitignored .env — found
// when this exact gap turned green locally and red in CI.
process.env.FRONT_END_URL = 'http://localhost:5173';
