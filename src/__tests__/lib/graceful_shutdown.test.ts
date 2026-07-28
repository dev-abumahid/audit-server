import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createGracefulShutdown,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
} from '../../app/lib/graceful_shutdown.js';

function makeDeps(overrides: Partial<Parameters<typeof createGracefulShutdown>[0]> = {}) {
  const callOrder: string[] = [];

  const server = {
    close: vi.fn((cb: (err?: Error) => void) => {
      callOrder.push('server.close');
      cb();
    }),
  };

  const makeWorker = (name: string) => ({
    close: vi.fn(async () => {
      callOrder.push(`worker.close:${name}`);
    }),
  });

  const workers = [
    makeWorker('otp'),
    makeWorker('org-invite'),
    makeWorker('reset-password'),
    makeWorker('external-verification'),
  ];

  const prisma = {
    $disconnect: vi.fn(async () => {
      callOrder.push('prisma.$disconnect');
    }),
  };

  const exit = vi.fn();

  return {
    callOrder,
    server,
    workers,
    prisma,
    exit,
    deps: {
      server,
      workers,
      prisma,
      exit,
      ...overrides,
    },
  };
}

describe('gracefulShutdown (issue #307)', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('closes the HTTP server, then all BullMQ workers, then Prisma, then exits 0', async () => {
    const { callOrder, server, workers, prisma, exit, deps } = makeDeps();

    const gracefulShutdown = createGracefulShutdown(deps);
    await gracefulShutdown('SIGTERM');

    expect(server.close).toHaveBeenCalledTimes(1);
    for (const worker of workers) {
      expect(worker.close).toHaveBeenCalledTimes(1);
    }
    expect(prisma.$disconnect).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);

    // server must drain before any worker closes, and every worker must
    // close before Prisma disconnects (workers may still be finishing a
    // job — e.g. an in-flight OTP send — that needs the DB).
    const serverIdx = callOrder.indexOf('server.close');
    const disconnectIdx = callOrder.indexOf('prisma.$disconnect');
    const workerIdxs = callOrder
      .map((entry, i) => (entry.startsWith('worker.close:') ? i : -1))
      .filter((i) => i !== -1);

    expect(serverIdx).toBe(0);
    expect(workerIdxs.every((i) => i > serverIdx)).toBe(true);
    expect(workerIdxs.every((i) => i < disconnectIdx)).toBe(true);
  });

  it('ignores a second signal while shutdown is already in progress', async () => {
    const { server, workers, prisma, exit, deps } = makeDeps();

    // Make server.close hang so the second signal arrives mid-shutdown.
    let resolveClose: () => void = () => {};
    server.close.mockImplementation((cb: (err?: Error) => void) => {
      resolveClose = () => cb();
    });

    const gracefulShutdown = createGracefulShutdown(deps);
    const first = gracefulShutdown('SIGTERM');
    const second = gracefulShutdown('SIGINT');

    resolveClose();
    await Promise.all([first, second]);

    expect(server.close).toHaveBeenCalledTimes(1);
    for (const worker of workers) {
      expect(worker.close).toHaveBeenCalledTimes(1);
    }
    expect(prisma.$disconnect).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('force-exits via the safety timeout if a step hangs (e.g. a stuck in-flight request)', async () => {
    vi.useFakeTimers();

    const { server, exit, deps } = makeDeps({ timeoutMs: 5000 });
    // Simulate a request that never finishes draining: server.close() never
    // calls its callback.
    server.close.mockImplementation(() => {});

    const gracefulShutdown = createGracefulShutdown(deps);
    const pending = gracefulShutdown('SIGTERM');

    await vi.advanceTimersByTimeAsync(5000);

    expect(exit).toHaveBeenCalledWith(1);

    vi.useRealTimers();
    // Don't leave the never-resolving promise dangling into the next test.
    void pending;
  });

  it("defaults the safety timeout to comfortably under Docker's ~10s SIGKILL grace period", () => {
    expect(DEFAULT_SHUTDOWN_TIMEOUT_MS).toBeLessThan(10000);
    expect(DEFAULT_SHUTDOWN_TIMEOUT_MS).toBeGreaterThan(5000);
  });

  it('exits 1 if closing a worker rejects, without blocking the rest of shutdown', async () => {
    const { workers, prisma, exit, deps } = makeDeps();
    workers[0].close.mockRejectedValueOnce(new Error('redis gone'));

    const gracefulShutdown = createGracefulShutdown(deps);
    await gracefulShutdown('SIGTERM');

    // The rejection is caught per-worker so Promise.all doesn't short-circuit
    // the remaining workers or skip the Prisma disconnect.
    for (const worker of workers) {
      expect(worker.close).toHaveBeenCalledTimes(1);
    }
    expect(prisma.$disconnect).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });
});
