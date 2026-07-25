import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../app/lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { routeTimeout } from '../../app/middlewares/route_timeout.js';

type FakeRes = {
  headersSent: boolean;
  statusCode?: number;
  body?: unknown;
  listeners: Record<string, () => void>;
  status: (code: number) => FakeRes;
  json: (payload: unknown) => FakeRes;
  on: (event: string, cb: () => void) => void;
  emit: (event: string) => void;
};

const makeRes = (): FakeRes => {
  const res: FakeRes = {
    headersSent: false,
    listeners: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      this.headersSent = true;
      return this;
    },
    on(event, cb) {
      this.listeners[event] = cb;
    },
    emit(event) {
      this.listeners[event]?.();
    },
  };
  return res;
};

describe('routeTimeout middleware (#220)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('responds 504 once the timeout elapses with nothing sent', () => {
    const req = { method: 'POST', originalUrl: '/api/report/generate' } as never;
    const res = makeRes();
    const next = vi.fn();

    routeTimeout(1000)(req, res as never, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBeUndefined();

    vi.advanceTimersByTime(1000);

    expect(res.statusCode).toBe(504);
    expect((res.body as { success: boolean }).success).toBe(false);
  });

  it('does not fire once the response has finished within budget', () => {
    const req = { method: 'POST', originalUrl: '/api/report/generate' } as never;
    const res = makeRes();

    routeTimeout(1000)(req, res as never, vi.fn());
    // Handler completes normally and the response finishes.
    res.headersSent = true;
    res.emit('finish');

    vi.advanceTimersByTime(5000);

    // No 504 written over a completed response.
    expect(res.statusCode).toBeUndefined();
  });
});
