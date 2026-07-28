import { Server } from 'http';
import { logger } from './logger';

// ─────────────────────────────────────────────────────────────────────────────
// Public interfaces
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minimal interface satisfied by a BullMQ Worker (and by test fakes).
 * Using a structural interface instead of importing Worker directly keeps
 * this module free of a hard runtime dependency on bullmq.
 */
export interface WorkerLike {
  name: string;
  close(force?: boolean): Promise<void>;
}

/**
 * Structural interface for any service that tracks in-flight webhook
 * deliveries and can be asked to drain them before shutdown.
 *
 * Implement this on `WebhookDeliveryService` (or any wrapper) and pass the
 * instance to `registerShutdownHandlers` via `ShutdownOptions.webhookService`.
 *
 * @example
 * ```ts
 * class WebhookDeliveryService implements DrainableWebhookService {
 *   get inFlightCount(): number { return this._inFlight; }
 *   stopAccepting(): void      { this._accepting = false; }
 *   async drain(): Promise<void> { ... }
 *   async flushToDLQ(): Promise<void> { ... }
 * }
 * ```
 */
export interface DrainableShutdownHandler {
  /**
   * Human-readable handler name used in shutdown logs.
   */
  readonly name: string;

  /**
   * Prevents new work from being accepted.
   * Called immediately on SIGTERM, before any waiting begins.
   * Must be synchronous and idempotent.
   */
  stopAccepting(): void;

  /**
   * Resolves when all in-flight work has completed.
   * The caller races this against the shutdown grace period.
   */
  drain(): Promise<void>;

  /**
   * Persists any remaining state that still needs to survive shutdown.
   * Called when the grace period expires before `drain()` completes.
   */
  checkpoint(): Promise<void>;

  /**
   * Optional finalizer invoked after draining/checkpointing to release any
   * underlying resources owned by the handler.
   */
  close?(): Promise<void>;
}

export interface DrainableWebhookService {
  /**
   * Number of deliveries currently in-flight.
   * Used for logging and to decide whether to wait.
   */
  readonly inFlightCount: number;

  /**
   * Prevents new deliveries from being accepted.
   * Called immediately on SIGTERM, before any waiting begins.
   * Must be synchronous and idempotent.
   */
  stopAccepting(): void;

  /**
   * Resolves when all in-flight deliveries have completed (success or failure).
   * The caller races this against `webhookDrainTimeoutMs`; if the race is lost
   * the caller invokes `flushToDLQ()` for any remaining in-flight items.
   */
  drain(): Promise<void>;

  /**
   * Force-moves every remaining in-flight delivery to the DLQ.
   * Called only when `drain()` does not complete within the grace timeout.
   * Must be idempotent — safe to call even when `inFlightCount === 0`.
   */
  flushToDLQ(): Promise<void>;
}

export interface ShutdownOptions {
  /** Max ms to wait for HTTP server to drain in-flight requests. Default 30 s. */
  httpTimeoutMs?: number;
  /** Max ms to wait for each BullMQ worker to finish active jobs. Default 30 s. */
  workerTimeoutMs?: number;
  /**
   * Max ms to wait for in-flight webhook deliveries to complete before
   * force-flushing them to the DLQ.
   *
   * Reads `WEBHOOK_DRAIN_TIMEOUT_MS` from the environment when not supplied.
   * Default: 30 s.
   *
   * During a blue/green switch the router stops sending traffic to the old
   * color before SIGTERM is sent, so most deliveries will already be done by
   * the time this timeout starts.  Set it to a value that comfortably covers
   * your p99 delivery latency.
   */
  webhookDrainTimeoutMs?: number;
  /**
   * Optional webhook delivery service to drain before closing workers.
   * When omitted the drain phase is skipped entirely.
   */
  webhookService?: DrainableWebhookService;
  /**
   * Optional drainable handlers for long-running background work such as the
   * transaction poller or queue workers. They stop new work, wait for in-flight
   * work, and checkpoint any remaining state if the grace period expires.
   */
  shutdownDrainHandlers?: DrainableShutdownHandler[];
  /**
   * Max ms to wait for registered shutdown drain handlers to finish in-flight
   * work before checkpointing remaining state and continuing shutdown.
   * Default: 30 s.
   */
  shutdownDrainTimeoutMs?: number;
}

export interface CloseableConnection {
  /** Human-readable name used in log messages (e.g. "Redis", "Postgres"). */
  name: string;
  close(): Promise<void>;
}

let draining = false;

export function isReadinessDraining(): boolean {
  return draining;
}
// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

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
 * Drains in-flight webhook deliveries, then force-flushes any remainder to
 * the DLQ if the grace timeout expires first.
 *
 * Sequence:
 *  1. `stopAccepting()` — gate is closed; no new deliveries start.
 *  2. Race `drain()` against `timeoutMs`.
 *     - If drain wins  → log `webhook_deliveries_drained`.
 *     - If timeout wins → log `webhook_drain_timeout`, call `flushToDLQ()`.
 *
 * Security note: `flushToDLQ()` must redact `webhookSecret` before persisting
 * (enforced by the DLQ storage layer — see `src/queue/webhook-dlq.ts`).
 *
 * @param service   The drainable webhook service.
 * @param timeoutMs Grace period in milliseconds.
 */
async function drainWebhookDeliveries(
  service: DrainableWebhookService,
  timeoutMs: number,
): Promise<void> {
  // Gate: stop accepting new deliveries immediately.
  service.stopAccepting();

  const inFlight = service.inFlightCount;
  if (inFlight === 0) {
    logger.info('webhook_deliveries_drained');
    return;
  }

  logger.info('webhook_drain_started');

  let timedOut = false;

  await Promise.race([
    service.drain().then(() => {
      if (!timedOut) {
        logger.info('webhook_deliveries_drained');
      }
    }),
    new Promise<void>((resolve) =>
      setTimeout(() => {
        timedOut = true;
        resolve();
      }, timeoutMs),
    ),
  ]);

  if (timedOut) {
    logger.warn('webhook_drain_timeout');
    // Force-flush remaining deliveries to DLQ so they are not silently lost.
    // flushToDLQ() must be idempotent and must NOT include raw secrets in the
    // persisted payload (enforced by WebhookDLQStorage).
    // Errors are caught so a DLQ write failure never prevents process.exit().
    try {
      await service.flushToDLQ();
      logger.info('webhook_drain_flushed_to_dlq');
    } catch {
      logger.warn('webhook_drain_flush_error');
    }
  }
}

async function drainShutdownHandlers(
  handlers: DrainableShutdownHandler[],
  timeoutMs: number,
): Promise<void> {
  if (handlers.length === 0) {
    return;
  }

  for (const handler of handlers) {
    try {
      handler.stopAccepting();
    } catch {
      logger.warn('shutdown_handler_stop_accepting_error');
    }
  }

  logger.info('shutdown_drainers_started');

  let timedOut = false;

  await Promise.race([
    Promise.allSettled(
      handlers.map(async (handler) => {
        try {
          await handler.drain();
        } catch {
          logger.warn('shutdown_handler_drain_error');
        }
      }),
    ).then(() => {
      if (!timedOut) {
        logger.info('shutdown_drainers_drained');
      }
    }),
    new Promise<void>((resolve) => {
      setTimeout(() => {
        timedOut = true;
        resolve();
      }, timeoutMs);
    }),
  ]);

  if (timedOut) {
    logger.warn('shutdown_drainers_timeout');

    try {
      await Promise.allSettled(
        handlers.map(async (handler) => {
          try {
            await handler.checkpoint();
          } catch {
            logger.warn('shutdown_handler_checkpoint_error');
          }
        }),
      );
      logger.info('shutdown_drainers_checkpointed');
    } catch {
      logger.warn('shutdown_drainers_checkpoint_error');
    }
  }

  await Promise.allSettled(
    handlers.map(async (handler) => {
      try {
        if (handler.close) {
          await handler.close();
        }
      } catch {
        logger.warn('shutdown_handler_close_error');
      }
    }),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Registers SIGTERM and SIGINT handlers and coordinates a clean shutdown:
 *
 *  1. Stop accepting new HTTP connections (server.close).
 *  2. Stop accepting new webhook deliveries; wait for in-flight ones to finish
 *     (or force-flush to DLQ on timeout).  Skipped when no `webhookService`
 *     is provided.
 *  3. Stop BullMQ workers from picking up new jobs; wait for active jobs.
 *  4. Close downstream connections (Redis, Postgres, …).
 *  5. Exit with code 0.
 *
 * Calling this function is idempotent — subsequent signals are ignored once
 * shutdown has started.
 *
 * ### Blue/green interaction
 * During a `deploy:switch-green` the router is updated first, so the old
 * color stops receiving new traffic before SIGTERM arrives.  This means most
 * in-flight deliveries will already be complete by the time the drain phase
 * starts, and the grace timeout is rarely exercised in practice.
 *
 * ### Environment variables
 * | Variable                   | Default | Description                                      |
 * |----------------------------|---------|--------------------------------------------------|
 * | `WEBHOOK_DRAIN_TIMEOUT_MS` | 30000   | Grace period for in-flight webhook deliveries.   |
 *
 * @param server      Express/Node HTTP server.
 * @param workers     BullMQ workers to close gracefully.
 * @param connections Downstream connections (Redis, Postgres, …) to close.
 * @param options     Timeout overrides and optional webhook service.
 */
export function registerShutdownHandlers(
  server: Server,
  workers: WorkerLike[],
  connections: CloseableConnection[],
  options: ShutdownOptions = {},
): void {
  const {
    httpTimeoutMs = 30_000,
    workerTimeoutMs = 30_000,
    webhookDrainTimeoutMs = Number(process.env['WEBHOOK_DRAIN_TIMEOUT_MS'] ?? 30_000),
    shutdownDrainTimeoutMs = 30_000,
    webhookService,
    shutdownDrainHandlers = [],
  } = options;

  let shuttingDown = false;

  async function shutdown(_signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    draining = true;

    logger.info('shutdown_initiated');

    // ── 1. HTTP server ──────────────────────────────────────────────────────
    try {
      await closeHttpServer(server, httpTimeoutMs);
      logger.info('http_drained');
    } catch {
      logger.warn('http_drain_timeout');
    }

    // ── 2. Webhook delivery drain ───────────────────────────────────────────
    // Runs after HTTP is closed so no new delivery requests can arrive, but
    // before BullMQ workers stop so the queue is still available for DLQ writes.
    if (webhookService) {
      await drainWebhookDeliveries(webhookService, webhookDrainTimeoutMs);
    }

    // ── 3. Registered shutdown drain handlers ─────────────────────────────
    if (shutdownDrainHandlers.length > 0) {
      await drainShutdownHandlers(shutdownDrainHandlers, shutdownDrainTimeoutMs);
    }

    // ── 4. BullMQ workers ───────────────────────────────────────────────────
    await Promise.allSettled(
      workers.map(async (w) => {
        try {
          await closeWorker(w, workerTimeoutMs);
          logger.info('bullmq_worker_closed');
        } catch {
          logger.warn('bullmq_worker_timeout');
        }
      }),
    );

    // ── 5. Downstream connections ───────────────────────────────────────────
    await Promise.allSettled(
      connections.map(async (conn) => {
        try {
          await conn.close();
          logger.info('connection_closed');
        } catch {
          logger.warn('connection_close_error');
        }
      }),
    );

    logger.info('shutdown_complete');
    process.exit(0);
  }

  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}
