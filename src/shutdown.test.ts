/**
 * @file shutdown.test.ts
 *
 * Tests for `registerShutdownHandlers` including the webhook delivery drain
 * phase introduced to prevent avoidable DLQ entries during blue/green switches.
 *
 * Security assumptions validated here:
 *  - `flushToDLQ()` is called (not skipped) when the grace timeout expires,
 *    ensuring no in-flight delivery is silently dropped.
 *  - `stopAccepting()` is always called before any waiting begins, so no new
 *    deliveries can start after SIGTERM.
 *  - The drain phase runs AFTER the HTTP server is closed, so no new delivery
 *    requests can arrive from the network during draining.
 *  - `flushToDLQ()` is responsible for redacting `webhookSecret` before
 *    persistence (enforced by WebhookDLQStorage — tested separately).
 *  - Idempotency: a second SIGTERM while draining does not trigger a second
 *    shutdown sequence.
 */

import { EventEmitter } from 'events';
import { Server } from 'http';
import { logger } from './logger';
import {
  registerShutdownHandlers,
  CloseableConnection,
  DrainableWebhookService,
  WorkerLike,
} from './shutdown';

// ── Silence logger in tests ──────────────────────────────────────────────────
beforeEach(() => {
  jest.spyOn(logger, 'info').mockImplementation(() => logger);
  jest.spyOn(logger, 'warn').mockImplementation(() => logger);
});

afterEach(() => {
  jest.restoreAllMocks();
  process.removeAllListeners('SIGTERM');
  process.removeAllListeners('SIGINT');
  // Reset env var so tests are isolated
  delete process.env['WEBHOOK_DRAIN_TIMEOUT_MS'];
});

// ── Minimal fakes ────────────────────────────────────────────────────────────

function makeFakeServer(opts: { delayMs?: number; error?: Error } = {}): Server {
  const emitter = new EventEmitter() as unknown as Server;
  (emitter as unknown as { close: (cb: (err?: Error) => void) => void }).close = (
    cb: (err?: Error) => void,
  ) => {
    setTimeout(() => cb(opts.error), opts.delayMs ?? 0);
  };
  return emitter;
}

function makeFakeWorker(
  name: string,
  opts: { delayMs?: number } = {},
): WorkerLike & { close: jest.Mock } {
  return {
    name,
    close: jest.fn((_force?: boolean) =>
      new Promise<void>((resolve) => setTimeout(resolve, opts.delayMs ?? 0)),
    ),
  };
}

function makeFakeConnection(
  name: string,
  opts: { rejects?: boolean } = {},
): CloseableConnection & { close: jest.Mock } {
  return {
    name,
    close: jest.fn(() =>
      opts.rejects
        ? Promise.reject(new Error(`${name} close failed`))
        : Promise.resolve(),
    ),
  };
}

function makeFakeDrainableHandler(name: string, drainMs = 0) {
  return {
    name,
    stopAccepting: jest.fn(),
    drain: jest.fn(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, drainMs);
        }),
    ),
    checkpoint: jest.fn(() => Promise.resolve()),
  };
}

/**
 * Creates a fake DrainableWebhookService.
 *
 * @param inFlight   Initial in-flight count.
 * @param drainMs    How long drain() takes to resolve (simulates delivery time).
 * @param flushRejects  Whether flushToDLQ() should reject (error path).
 */
function makeFakeWebhookService(
  inFlight: number,
  drainMs = 0,
  flushRejects = false,
): DrainableWebhookService & {
  stopAccepting: jest.Mock;
  drain: jest.Mock;
  flushToDLQ: jest.Mock;
} {
  let _inFlight = inFlight;
  return {
    get inFlightCount() {
      return _inFlight;
    },
    stopAccepting: jest.fn(() => {
      // Simulate gate closing — no new deliveries after this
    }),
    drain: jest.fn(
      () =>
        new Promise<void>((resolve) =>
          setTimeout(() => {
            _inFlight = 0; // all deliveries finished
            resolve();
          }, drainMs),
        ),
    ),
    flushToDLQ: jest.fn(() => {
      if (flushRejects) return Promise.reject(new Error('DLQ write failed'));
      _inFlight = 0;
      return Promise.resolve();
    }),
  };
}

// ── process.exit mock ────────────────────────────────────────────────────────
let exitSpy: jest.SpyInstance;

beforeEach(() => {
  exitSpy = jest
    .spyOn(process, 'exit')
    .mockImplementation((_code?: string | number | null | undefined) => undefined as never);
});

// ─────────────────────────────────────────────────────────────────────────────
// Existing shutdown behaviour (regression suite)
// ─────────────────────────────────────────────────────────────────────────────

describe('registerShutdownHandlers', () => {
  it('registers SIGTERM and SIGINT listeners', () => {
    registerShutdownHandlers(makeFakeServer(), [], []);
    expect(process.listenerCount('SIGTERM')).toBe(1);
    expect(process.listenerCount('SIGINT')).toBe(1);
  });

  it('calls process.exit(0) after SIGTERM', async () => {
    registerShutdownHandlers(makeFakeServer(), [], []);
    process.emit('SIGTERM');
    await new Promise((r) => setTimeout(r, 50));
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('calls process.exit(0) after SIGINT', async () => {
    registerShutdownHandlers(makeFakeServer(), [], []);
    process.emit('SIGINT');
    await new Promise((r) => setTimeout(r, 50));
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('is idempotent — second signal does not call exit twice', async () => {
    registerShutdownHandlers(makeFakeServer(), [], []);
    process.emit('SIGTERM');
    process.emit('SIGTERM');
    await new Promise((r) => setTimeout(r, 50));
    expect(exitSpy).toHaveBeenCalledTimes(1);
  });

  it('closes all connections after server and workers', async () => {
    const conn = makeFakeConnection('Redis');
    registerShutdownHandlers(makeFakeServer(), [], [conn]);
    process.emit('SIGTERM');
    await new Promise((r) => setTimeout(r, 50));
    expect(conn.close).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('logs http_drained after server closes', async () => {
    const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => logger);
    registerShutdownHandlers(makeFakeServer(), [], []);
    process.emit('SIGTERM');
    await new Promise((r) => setTimeout(r, 50));
    const messages = infoSpy.mock.calls.map((c: unknown[]) => c[c.length - 1]);
    expect(messages).toContain('http_drained');
  });

  it('logs bullmq_worker_closed after worker closes', async () => {
    const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => logger);
    const worker = makeFakeWorker('webhook-processor');
    registerShutdownHandlers(makeFakeServer(), [worker], []);
    process.emit('SIGTERM');
    await new Promise((r) => setTimeout(r, 50));
    const messages = infoSpy.mock.calls.map((c: unknown[]) => c[c.length - 1]);
    expect(messages).toContain('bullmq_worker_closed');
  });

  it('calls worker.close(false) — never force-closes to prevent job duplication', async () => {
    const worker = makeFakeWorker('webhook-processor');
    registerShutdownHandlers(makeFakeServer(), [worker], []);
    process.emit('SIGTERM');
    await new Promise((r) => setTimeout(r, 50));
    expect(worker.close).toHaveBeenCalledWith(false);
  });

  /**
   * Verifies the worker is not abandoned mid-job.
   * The worker takes 200 ms; we assert exit has NOT been called at 80 ms,
   * then assert it HAS been called by 400 ms.
   */
  it('waits for a long-running job before exiting', async () => {
    const worker = makeFakeWorker('slow-worker', { delayMs: 200 });
    registerShutdownHandlers(makeFakeServer(), [worker], [], { workerTimeoutMs: 2_000 });

    process.emit('SIGTERM');

    // Mid-flight: worker still processing
    await new Promise((r) => setTimeout(r, 80));
    expect(exitSpy).not.toHaveBeenCalled();

    // Worker done: exit must have been called
    await new Promise((r) => setTimeout(r, 320));
    expect(exitSpy).toHaveBeenCalledWith(0);
  }, 2_000);

  it('logs a warning and continues if HTTP server times out', async () => {
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    // Server takes 200 ms but timeout is 50 ms
    registerShutdownHandlers(makeFakeServer({ delayMs: 200 }), [], [], { httpTimeoutMs: 50 });

    process.emit('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));

    const warnMessages = warnSpy.mock.calls.map((c: unknown[]) => c[c.length - 1]);
    expect(warnMessages).toContain('http_drain_timeout');
    expect(exitSpy).toHaveBeenCalledWith(0);
  }, 2_000);

  it('logs a warning and continues if a worker times out', async () => {
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    // Worker takes 200 ms but timeout is 50 ms
    const worker = makeFakeWorker('slow-worker', { delayMs: 200 });
    registerShutdownHandlers(makeFakeServer(), [worker], [], { workerTimeoutMs: 50 });

    process.emit('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));

    const warnMessages = warnSpy.mock.calls.map((c: unknown[]) => c[c.length - 1]);
    expect(warnMessages).toContain('bullmq_worker_timeout');
    expect(exitSpy).toHaveBeenCalledWith(0);
  }, 2_000);

  it('logs a warning and continues if a connection close fails', async () => {
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    const conn = makeFakeConnection('Postgres', { rejects: true });
    registerShutdownHandlers(makeFakeServer(), [], [conn]);

    process.emit('SIGTERM');
    await new Promise((r) => setTimeout(r, 50));

    const warnMessages = warnSpy.mock.calls.map((c: unknown[]) => c[c.length - 1]);
    expect(warnMessages).toContain('connection_close_error');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('handles multiple workers and connections concurrently', async () => {
    const w1 = makeFakeWorker('worker-1');
    const w2 = makeFakeWorker('worker-2');
    const redis = makeFakeConnection('Redis');
    const pg = makeFakeConnection('Postgres');

    registerShutdownHandlers(makeFakeServer(), [w1, w2], [redis, pg]);

    process.emit('SIGTERM');
    await new Promise((r) => setTimeout(r, 50));

    expect(w1.close).toHaveBeenCalledWith(false);
    expect(w2.close).toHaveBeenCalledWith(false);
    expect(redis.close).toHaveBeenCalledTimes(1);
    expect(pg.close).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Generic drainable shutdown handlers
// ─────────────────────────────────────────────────────────────────────────────

describe('generic drainable shutdown handlers', () => {
  it('stops accepting new work and waits for in-flight work before exiting', async () => {
    const handler = makeFakeDrainableHandler('transaction-poller', 100);

    registerShutdownHandlers(makeFakeServer(), [], [], {
      shutdownDrainHandlers: [handler],
      shutdownDrainTimeoutMs: 2_000,
    });

    process.emit('SIGTERM');

    await new Promise((r) => setTimeout(r, 40));
    expect(handler.stopAccepting).toHaveBeenCalledTimes(1);
    expect(exitSpy).not.toHaveBeenCalled();

    await new Promise((r) => setTimeout(r, 200));
    expect(handler.drain).toHaveBeenCalledTimes(1);
    expect(handler.checkpoint).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);
  }, 3_000);

  it('checkpoint remaining state when the drain grace period expires', async () => {
    const handler = makeFakeDrainableHandler('queue-worker', 200);

    registerShutdownHandlers(makeFakeServer(), [], [], {
      shutdownDrainHandlers: [handler],
      shutdownDrainTimeoutMs: 50,
    });

    process.emit('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));

    expect(handler.stopAccepting).toHaveBeenCalledTimes(1);
    expect(handler.drain).toHaveBeenCalledTimes(1);
    expect(handler.checkpoint).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
  }, 3_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// Webhook delivery drain phase
// ─────────────────────────────────────────────────────────────────────────────

describe('webhook delivery drain phase', () => {
  // ── No-op when no service is provided ──────────────────────────────────────

  it('skips drain phase when no webhookService is provided', async () => {
    const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => logger);
    registerShutdownHandlers(makeFakeServer(), [], []);
    process.emit('SIGTERM');
    await new Promise((r) => setTimeout(r, 50));

    const messages = infoSpy.mock.calls.map((c: unknown[]) => c[c.length - 1]);
    expect(messages).not.toContain('webhook_drain_started');
    expect(messages).not.toContain('webhook_deliveries_drained');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  // ── Zero in-flight: fast path ───────────────────────────────────────────────

  it('completes immediately when inFlightCount is 0', async () => {
    const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => logger);
    const svc = makeFakeWebhookService(0);

    registerShutdownHandlers(makeFakeServer(), [], [], {
      webhookService: svc,
      webhookDrainTimeoutMs: 5_000,
    });

    process.emit('SIGTERM');
    await new Promise((r) => setTimeout(r, 50));

    // Gate must still be closed even with zero in-flight
    expect(svc.stopAccepting).toHaveBeenCalledTimes(1);
    // drain() should NOT be called when there is nothing to wait for
    expect(svc.drain).not.toHaveBeenCalled();
    expect(svc.flushToDLQ).not.toHaveBeenCalled();

    const messages = infoSpy.mock.calls.map((c: unknown[]) => c[c.length - 1]);
    expect(messages).toContain('webhook_deliveries_drained');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  // ── Happy path: deliveries finish within grace ──────────────────────────────

  it('waits for in-flight deliveries and logs drained when they finish within grace', async () => {
    const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => logger);
    // 3 in-flight, drain completes in 100 ms, grace is 2 s
    const svc = makeFakeWebhookService(3, 100);

    registerShutdownHandlers(makeFakeServer(), [], [], {
      webhookService: svc,
      webhookDrainTimeoutMs: 2_000,
    });

    process.emit('SIGTERM');

    // Mid-drain: exit must NOT have been called yet
    await new Promise((r) => setTimeout(r, 40));
    expect(exitSpy).not.toHaveBeenCalled();

    // After drain completes
    await new Promise((r) => setTimeout(r, 200));

    expect(svc.stopAccepting).toHaveBeenCalledTimes(1);
    expect(svc.drain).toHaveBeenCalledTimes(1);
    expect(svc.flushToDLQ).not.toHaveBeenCalled();

    const messages = infoSpy.mock.calls.map((c: unknown[]) => c[c.length - 1]);
    expect(messages).toContain('webhook_drain_started');
    expect(messages).toContain('webhook_deliveries_drained');
    expect(exitSpy).toHaveBeenCalledWith(0);
  }, 3_000);

  // ── Timeout path: remainder goes to DLQ ────────────────────────────────────

  it('force-flushes remaining deliveries to DLQ when grace timeout expires', async () => {
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => logger);

    // 5 in-flight, drain takes 500 ms, but grace is only 80 ms
    const svc = makeFakeWebhookService(5, 500);

    registerShutdownHandlers(makeFakeServer(), [], [], {
      webhookService: svc,
      webhookDrainTimeoutMs: 80,
    });

    process.emit('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));

    // Gate must be closed
    expect(svc.stopAccepting).toHaveBeenCalledTimes(1);
    // drain() was called but lost the race
    expect(svc.drain).toHaveBeenCalledTimes(1);
    // Remainder must be flushed to DLQ — no silent drops
    expect(svc.flushToDLQ).toHaveBeenCalledTimes(1);

    const warnMessages = warnSpy.mock.calls.map((c: unknown[]) => c[c.length - 1]);
    expect(warnMessages).toContain('webhook_drain_timeout');

    const infoMessages = infoSpy.mock.calls.map((c: unknown[]) => c[c.length - 1]);
    expect(infoMessages).toContain('webhook_drain_flushed_to_dlq');

    expect(exitSpy).toHaveBeenCalledWith(0);
  }, 3_000);

  // ── stopAccepting is always called first ────────────────────────────────────

  it('calls stopAccepting before drain() — gate closes before waiting', async () => {
    const callOrder: string[] = [];
    const svc: DrainableWebhookService = {
      get inFlightCount() {
        return 1;
      },
      stopAccepting: jest.fn(() => {
        callOrder.push('stopAccepting');
      }),
      drain: jest.fn(() => {
        callOrder.push('drain');
        return Promise.resolve();
      }),
      flushToDLQ: jest.fn(() => Promise.resolve()),
    };

    registerShutdownHandlers(makeFakeServer(), [], [], {
      webhookService: svc,
      webhookDrainTimeoutMs: 2_000,
    });

    process.emit('SIGTERM');
    await new Promise((r) => setTimeout(r, 50));

    expect(callOrder[0]).toBe('stopAccepting');
    expect(callOrder[1]).toBe('drain');
  });

  // ── Drain runs after HTTP close, before BullMQ workers ─────────────────────

  it('drains webhooks after HTTP server closes and before BullMQ workers close', async () => {
    const callOrder: string[] = [];

    const server = makeFakeServer();
    const origClose = (server as unknown as { close: (cb: (err?: Error) => void) => void }).close;
    (server as unknown as { close: (cb: (err?: Error) => void) => void }).close = (cb) => {
      callOrder.push('http_close');
      origClose(cb);
    };

    const svc: DrainableWebhookService = {
      get inFlightCount() {
        return 1;
      },
      stopAccepting: jest.fn(() => {
        callOrder.push('stopAccepting');
      }),
      drain: jest.fn(() => {
        callOrder.push('drain');
        return Promise.resolve();
      }),
      flushToDLQ: jest.fn(() => Promise.resolve()),
    };

    const worker = makeFakeWorker('w1');
    const origWorkerClose = worker.close;
    worker.close = jest.fn((...args: unknown[]) => {
      callOrder.push('worker_close');
      return (origWorkerClose as (...a: unknown[]) => Promise<void>)(...args);
    });

    registerShutdownHandlers(server, [worker], [], {
      webhookService: svc,
      webhookDrainTimeoutMs: 2_000,
    });

    process.emit('SIGTERM');
    await new Promise((r) => setTimeout(r, 100));

    expect(callOrder).toEqual(['http_close', 'stopAccepting', 'drain', 'worker_close']);
  });

  // ── Idempotency during drain ────────────────────────────────────────────────

  it('second SIGTERM during drain does not start a second drain', async () => {
    // drain takes 200 ms
    const svc = makeFakeWebhookService(2, 200);

    registerShutdownHandlers(makeFakeServer(), [], [], {
      webhookService: svc,
      webhookDrainTimeoutMs: 2_000,
    });

    process.emit('SIGTERM');
    await new Promise((r) => setTimeout(r, 50)); // mid-drain
    process.emit('SIGTERM'); // second signal — must be ignored

    await new Promise((r) => setTimeout(r, 300));

    expect(svc.stopAccepting).toHaveBeenCalledTimes(1);
    expect(svc.drain).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledTimes(1);
  }, 3_000);

  // ── WEBHOOK_DRAIN_TIMEOUT_MS env var ────────────────────────────────────────

  it('reads webhookDrainTimeoutMs from WEBHOOK_DRAIN_TIMEOUT_MS env var', async () => {
    process.env['WEBHOOK_DRAIN_TIMEOUT_MS'] = '80';
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => logger);

    // drain takes 500 ms — env var timeout of 80 ms should trigger DLQ flush
    const svc = makeFakeWebhookService(2, 500);

    // Do NOT pass webhookDrainTimeoutMs in options — must be read from env
    registerShutdownHandlers(makeFakeServer(), [], [], { webhookService: svc });

    process.emit('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));

    const warnMessages = warnSpy.mock.calls.map((c: unknown[]) => c[c.length - 1]);
    expect(warnMessages).toContain('webhook_drain_timeout');
    expect(svc.flushToDLQ).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
  }, 3_000);

  // ── flushToDLQ error is swallowed — shutdown must still complete ────────────

  it('continues to exit even if flushToDLQ rejects', async () => {
    jest.spyOn(logger, 'warn').mockImplementation(() => logger);

    // drain takes 500 ms, grace is 50 ms, flushToDLQ rejects
    const svc = makeFakeWebhookService(3, 500, /* flushRejects */ true);

    registerShutdownHandlers(makeFakeServer(), [], [], {
      webhookService: svc,
      webhookDrainTimeoutMs: 50,
    });

    process.emit('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));

    // flushToDLQ was attempted
    expect(svc.flushToDLQ).toHaveBeenCalledTimes(1);
    // Shutdown must still complete — a DLQ write failure must not hang the process
    expect(exitSpy).toHaveBeenCalledWith(0);
  }, 3_000);

  // ── Drain with workers and connections — full integration ───────────────────

  it('drains webhooks then closes workers and connections in the correct order', async () => {
    const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => logger);

    const svc = makeFakeWebhookService(2, 50);
    const worker = makeFakeWorker('webhook-processor');
    const conn = makeFakeConnection('Redis');

    registerShutdownHandlers(makeFakeServer(), [worker], [conn], {
      webhookService: svc,
      webhookDrainTimeoutMs: 2_000,
    });

    process.emit('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));

    expect(svc.stopAccepting).toHaveBeenCalledTimes(1);
    expect(svc.drain).toHaveBeenCalledTimes(1);
    expect(svc.flushToDLQ).not.toHaveBeenCalled();
    expect(worker.close).toHaveBeenCalledWith(false);
    expect(conn.close).toHaveBeenCalledTimes(1);

    const messages = infoSpy.mock.calls.map((c: unknown[]) => c[c.length - 1]);
    expect(messages).toContain('webhook_deliveries_drained');
    expect(messages).toContain('bullmq_worker_closed');
    expect(messages).toContain('connection_closed');
    expect(messages).toContain('shutdown_complete');

    expect(exitSpy).toHaveBeenCalledWith(0);
  }, 3_000);
});
