import { EventEmitter } from 'events';
import { Server } from 'http';
import { logger } from './logger';
import { registerShutdownHandlers, CloseableConnection, WorkerLike } from './shutdown';

// ── Silence logger in tests ──────────────────────────────────────────────────
beforeEach(() => {
  jest.spyOn(logger, 'info').mockImplementation(() => logger);
  jest.spyOn(logger, 'warn').mockImplementation(() => logger);
});

afterEach(() => {
  jest.restoreAllMocks();
  process.removeAllListeners('SIGTERM');
  process.removeAllListeners('SIGINT');
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

// ── process.exit mock ────────────────────────────────────────────────────────
let exitSpy: jest.SpyInstance;

beforeEach(() => {
  exitSpy = jest
    .spyOn(process, 'exit')
    .mockImplementation((_code?: string | number | null | undefined) => undefined as never);
});

// ── Tests ────────────────────────────────────────────────────────────────────

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
    const messages = infoSpy.mock.calls.map((c: any[]) => c[c.length - 1]);
    expect(messages).toContain('http_drained');
  });

  it('logs bullmq_worker_closed after worker closes', async () => {
    const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => logger);
    const worker = makeFakeWorker('webhook-processor');
    registerShutdownHandlers(makeFakeServer(), [worker], []);
    process.emit('SIGTERM');
    await new Promise((r) => setTimeout(r, 50));
    const messages = infoSpy.mock.calls.map((c: any[]) => c[c.length - 1]);
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

    const warnMessages = warnSpy.mock.calls.map((c: any[]) => c[c.length - 1]);
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

    const warnMessages = warnSpy.mock.calls.map((c: any[]) => c[c.length - 1]);
    expect(warnMessages).toContain('bullmq_worker_timeout');
    expect(exitSpy).toHaveBeenCalledWith(0);
  }, 2_000);

  it('logs a warning and continues if a connection close fails', async () => {
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    const conn = makeFakeConnection('Postgres', { rejects: true });
    registerShutdownHandlers(makeFakeServer(), [], [conn]);

    process.emit('SIGTERM');
    await new Promise((r) => setTimeout(r, 50));

    const warnMessages = warnSpy.mock.calls.map((c: any[]) => c[c.length - 1]);
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
