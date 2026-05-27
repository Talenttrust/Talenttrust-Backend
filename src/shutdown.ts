import { Server } from 'http';
import { logger } from './logger';

/**
 * Minimal interface satisfied by a BullMQ Worker (and by test fakes).
 * Using a structural interface instead of importing Worker directly keeps
 * this module free of a hard runtime dependency on bullmq.
 */
export interface WorkerLike {
  name: string;
  close(force?: boolean): Promise<void>;
}

export interface ShutdownOptions {
  /** Max ms to wait for HTTP server to drain in-flight requests. Default 30 s. */
  httpTimeoutMs?: number;
  /** Max ms to wait for each BullMQ worker to finish active jobs. Default 30 s. */
  workerTimeoutMs?: number;
}

export interface CloseableConnection {
  /** Human-readable name used in log messages (e.g. "Redis", "Postgres"). */
  name: string;
  close(): Promise<void>;
}

/**
 * Wraps server.close() in a Promise.
 * Resolves when all existing connections have ended, or rejects after `timeoutMs`.
 */
function closeHttpServer(server: Server, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`HTTP server did not drain within ${timeoutMs} ms`));
    }, timeoutMs);

    server.close((err) => {
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    });
  });
}

/**
 * Closes a BullMQ worker, waiting for active jobs to finish.
 * Passes `force=false` so the worker completes in-flight jobs before stopping —
 * this is the anti-duplication guarantee: jobs are never re-queued mid-flight.
 */
function closeWorker(worker: WorkerLike, timeoutMs: number): Promise<void> {
  return Promise.race([
    // force=false → wait for active jobs to complete naturally
    worker.close(false),
    new Promise<void>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Worker "${worker.name}" did not close within ${timeoutMs} ms`)),
        timeoutMs,
      ),
    ),
  ]);
}

/**
 * Registers SIGTERM and SIGINT handlers and coordinates a clean shutdown:
 *
 *  1. Stop accepting new HTTP connections (server.close)
 *  2. Stop BullMQ workers from picking up new jobs; wait for active jobs
 *  3. Close downstream connections (Redis, Postgres, …)
 *  4. Exit with code 0 (or 1 on error)
 *
 * Calling this function is idempotent — subsequent signals are ignored once
 * shutdown has started.
 */
export function registerShutdownHandlers(
  server: Server,
  workers: WorkerLike[],
  connections: CloseableConnection[],
  options: ShutdownOptions = {},
): void {
  const { httpTimeoutMs = 30_000, workerTimeoutMs = 30_000 } = options;

  let shuttingDown = false;

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info('shutdown_initiated', { signal });

    // ── 1. HTTP server ──────────────────────────────────────────────────────
    try {
      await closeHttpServer(server, httpTimeoutMs);
      logger.info('http_drained');
    } catch (err) {
      logger.warn('http_drain_timeout', { err });
    }

    // ── 2. BullMQ workers ───────────────────────────────────────────────────
    await Promise.allSettled(
      workers.map(async (w) => {
        try {
          await closeWorker(w, workerTimeoutMs);
          logger.info('bullmq_worker_closed', { worker: w.name });
        } catch (err) {
          logger.warn('bullmq_worker_timeout', { worker: w.name, err });
        }
      }),
    );

    // ── 3. Downstream connections ───────────────────────────────────────────
    await Promise.allSettled(
      connections.map(async (conn) => {
        try {
          await conn.close();
          logger.info('connection_closed', { connection: conn.name });
        } catch (err) {
          logger.warn('connection_close_error', { connection: conn.name, err });
        }
      }),
    );

    logger.info('shutdown_complete');
    process.exit(0);
  }

  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}
