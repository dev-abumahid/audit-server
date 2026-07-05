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
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test_db';
