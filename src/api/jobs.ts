/**
 * @module api/jobs
 *
 * Background job orchestration for webhook delivery and DLQ management.
 *
 * ## Responsibilities
 * - Initialize the DLQ store (in-memory or Redis-backed).
 * - Start the DLQ metrics sampling loop.
 * - Expose authenticated endpoints for idempotent DLQ message replay.
 * - Preserve compatibility contracts for the public store and router surface.
 *
 * ## Configuration (environment variables)
 * | Variable                  | Default | Description                                    |
 * |-------------------------|---------|----------------------------------------------------|
 * | `DLQ_METRICS_INTERVAL_MS ` | `30000` | DLQ metrics sampling interval in milliseconds. |
 *
 * ## Usage
 * Call {@link initializeJobs} once at application startup (e.g., from `index.ts`).
 *
 * ## Failure recovery invariants
 * 1. **Delivery before removal**: `removeEntry` is only called after a confirmed
 *    2xx from `deliverRaw`. This prevents silent data loss.
 * 2. **Idempotency key registered immediately after removal**: if the process
 *    crashes between `removeEntry` and `markEventProcessed`, the next replay of
 *    the same DLQ record will get a 404 (entry gone) rather than re-delivering.
 *    This trades at-most-once delivery (one missed mark) for freedom from
 *    duplicate deliveries, which is safer for downstream consumers.
 * 3. **Partial batch results are always surfaced**: the batch handler catches
 *    per-item errors without aborting the loop, and the final response always
 *    contains the committed `successIds` so callers can reconcile.
 * 4. **Delivery failures are observable**: `deliverRaw` logs the HTTP status code
 *    and a sanitised error type without leaking payload content or secrets.
 */

import axios, { AxiosError } from 'axios';
import { Router, Request, Response, NextFunction } from 'express';
import { startDlqMetricsSampling, incrementDlqReplay } from '../webhookMetrics';
import { redactPayload } from '../utils/redact';
import { IdempotencyLayer } from '../events/idempotency';
import { requireAuth, requireRole } from '../middleware/authorization';
import { logger } from '../logger';

// -----------------------------------------------------------------------------
// Request context propagation
// -----------------------------------------------------------------------------

import { randomUUID } from 'crypto';

/** Context envelope propagated to asynchronous processors (e.g., webhook calls). */
export interface RequestContextEnvelope {
  requestId?: string;
  tenantId?: string;
  actorId?: string;
}

const MAX_CONTEXT_FIELD_LENGTH = 128;

function sanitizeContextValue(value: unknown): string | undefined {
  const raw = Array.isArray(value) ? value.find((v): v is string => typeof v === 'string') : value;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_CONTEXT_FIELD_LENGTH) return undefined;
  // Prevent header injection and other control-character issues.
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return undefined;
  return trimmed;
}

/**
 * Extract a validated context envelope from the incoming request.
 * Unknown, missing, or malformed values are omitted rather than propagated.
 */
export function extractRequestContext(req: Request): RequestContextEnvelope {
  const context: RequestContextEnvelope = {};

  const requestId = sanitizeContextValue(req.headers['x-request-id'] ?? (req as any).id);
  if (requestId) context.requestId = requestId;

  const tenantId = sanitizeContextValue(req.headers['x-tenant-id'] ?? (req as any).tenantId);
  if (tenantId) context.tenantId = tenantId;

  const actorId = sanitizeContextValue((req as any).user?.id ?? req.headers['x-actor-id']);
  if (actorId) context.actorId = actorId;

  return context;
}

// -----------------------------------------------------------------------------
// Store contract
// -----------------------------------------------------------------------------

/** A single replayable DLQ record as consumed by the replay endpoints. */
export interface ReplayableDlqItem {
  id: string;
  eventId: string;
  targetUrl: string;
  payload: Record<string, unknown>;
}

/**
 * Minimal store contract required by the DLQ replay endpoints. Implementations
 * may be in-memory (development/testing) or backed by Redis/SQLite.
 */
export interface ReplayableDlqStore {
  getEntryById(id: string): Promise<ReplayableDlqItem | null> | ReplayableDlqItem | null;
  removeEntry(id: string): Promise<void> | void;
  incrementReplayAttempts(id: string): Promise<void> | void;
}

// ---------------------------------------------------------------------------
// DeliveryResult — structured outcome returned by deliverRaw
// ---------------------------------------------------------------------------

/**
 * Structured outcome from a single delivery attempt. Carries enough
 * diagnostic context to log failures without leaking payload content.
 */
export interface DeliveryResult {
  /** `true` when the destination responded with HTTP 2xx. */
  success: boolean;
  /**
   * HTTP status code returned by the destination, or `undefined` when the
   * request never reached the server (network-level failure).
   */
  statusCode?: number;
  /**
   * Sanitised error type (e.g. `ECONNREFUSED`, `ETIMEDOUT`). Only present on
   * network-level failures; `undefined` on HTTP-level responses.
   */
  errorCode?: string;
}

// ---------------------------------------------------------------------------
// Module-level state
// -----------------------------------------------------------------------------

let dlqStore: ReplayableDlqStore | null = null;
let stopSampling: (() => void) | null = null;
let replayInFlight: Set<string> = new Set();

/**
 * In-flight replay guard.
 *
 * Invariant: for any given DLQ record id, at most one replay attempt may be
 * executing at any moment. Concurrent requests for the same id are rejected
 * with 409 rather than racing to deliver the same payload twice.
 */
const inFlightReplays = new Set<string>();

const router = Router();

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Deliver a raw DLQ payload to its target URL.
 *
 * Uses `validateStatus: () => true` so every HTTP response (including 4xx/5xx)
 * resolves rather than rejects, giving callers a stable `DeliveryResult`.
 * Network-level failures (DNS, TLS, timeout, connection refused) are caught and
 * surfaced via `errorCode` so failures are diagnosable in logs without exposing
 * payload content or secrets.
 *
 * @returns A {@link DeliveryResult} describing the outcome of this attempt.
 */
export async function deliverRaw(
  targetUrl: string,
  eventId: string,
  payload: Record<string, unknown>,
  context: RequestContextEnvelope = {},
): Promise<DeliveryResult> {
  const headers: Record<string, string> = { 'X-Event-Id': eventId };
  if (context.requestId) headers['X-Request-Id'] = context.requestId;
  if (context.tenantId) headers['X-Tenant-Id'] = context.tenantId;
  if (context.actorId) headers['X-Actor-Id'] = context.actorId;

  try {
    const response = await axios.post(targetUrl, payload, {
      headers,
      validateStatus: () => true,
    });
    const success = response.status >= 200 && response.status < 300;
    if (!success) {
      logger.warn('DLQ delivery returned non-2xx status', {
        eventId,
        statusCode: response.status,
        // targetUrl intentionally omitted — may contain tokens in path params
      });
    }
    return { success, statusCode: response.status };
  } catch (err: unknown) {
    // Only network-level errors reach here (DNS, TLS, timeout, refused, etc.)
    // because validateStatus suppresses HTTP-level throws.
    const axiosErr = err as AxiosError;
    const errorCode = axiosErr.code ?? 'UNKNOWN_NETWORK_ERROR';
    logger.warn('DLQ delivery network failure', {
      eventId,
      errorCode,
      // message intentionally not logged — may contain URL fragments with tokens
    });
    return { success: false, errorCode };
  }
}

/**
 * Acquire an exclusive replay lock for a DLQ record id.
 *
 * @returns `true` when the lock was acquired, `false` when another replay for
 *          the same id is already in flight.
 */
function acquireReplayLock(id: string): boolean {
  if (inFlightReplays.has(id)) return false;
  inFlightReplays.add(id);
  return true;
}

/**
 * Release the replay lock for a DLQ record id.
 *
 * Must be called in a `finally` block so that partial failures cannot leak
 * locks and permanently block future replays.
 */
function releaseReplayLock(id: string): void {
  inFlightReplays.delete(id);
}

// ---------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

/**
 * Load DLQ metrics sampling interval from environment variables.
 *
 * @returns Sampling interval in milliseconds.
 * @throws {Error} when the environment value is missing, non-finite, or ≤ 0.
 */
function loadDLQMetricsInterval(): number {
  const raw = process.env.DLQ_METRICS_INTERVAL_MS ?? '30000';
  const parsed = Number(raw);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      `[api/jobs] Invalid DLQ_METRICS_INTERVAL_MS="${raw}". ` +
        'Must be a finite positive number greater than zero.',
    );
  }

  return parsed;
}

// -----------------------------------------------------------------------------
// Public API & Lifecycle Orchestration
// -----------------------------------------------------------------------------

/**
 * Initialize background jobs: DLQ store and metrics sampling.
 *
 * This function is idempotent — calling it multiple times will stop the
 * previous sampling loop and start a new one.
 *
 * If the metrics sampling interval is misconfigured, or if
 * {@link startDlqMetricsSampling} itself throws, `initializeJobs` logs a
 * structured warning and continues without sampling rather than crashing the
 * process. The DLQ store is still activated so replay endpoints remain
 * operational.
 *
 * @param customDlqStore - The DLQ store backing replay operations.
 * @returns The initialized DLQ store.
 */
export function initializeJobs(customDlqStore: ReplayableDlqStore): ReplayableDlqStore {
  // Stop any existing sampling loop before replacing it.
  if (stopSampling !== null) {
    stopSampling();
    stopSampling = null;
  }

  dlqStore = customDlqStore;

  // Start DLQ metrics sampling. Guard against misconfigured env vars and any
  // unexpected throw from startDlqMetricsSampling — the process must stay up
  // even if sampling cannot start (replay endpoints remain fully operational).
  try {
    const intervalMs = loadDlqMetricsInterval();
    stopSampling = startDlqMetricsSampling(dlqStore, intervalMs);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('[api/jobs] DLQ metrics sampling could not be started — replay endpoints remain active', {
      reason: message,
    });
    stopSampling = null;
  }

  return dlqStore;
}

/**
 * Stop all background jobs and clean up resources.
 *
 * Intended for graceful shutdown or testing.
 */
export function shutdownJobs(): void {
  if (stopSampling !== null) {
    stopSampling();
    stopSampling = null;
  }

  // Release all in-flight locks so a subsequent initializeJobs starts clean.
  inFlightReplays.clear();

  dlqStore = null;
}

/**
 * Get the current DLQ store instance.
 *
 * @returns The DLQ store, or `null` if {@link initializeJobs} has not been called.
 */
export function getDlqStore(): ReplayableDlqStore | null {
  return dlqStore;
}

// -----------------------------------------------------------------------------
// REST API Routing Interface Endpoints
// -----------------------------------------------------------------------------

const adminOnly = [requireAuth, requireRole('admin')];

/**
 * POST /jobs/dlq/:id/replay
 *
 * Replays a single dead-letter-queue message back through the delivery stack.
 *
 * ### Atomicity contract
 * The operation is logically sequenced as:
 *   1. Check idempotency key — short-circuit on duplicate.
 *   2. Deliver payload to `targetUrl`.
 *   3. Remove DLQ entry (delivery confirmed).
 *   4. Register idempotency key (prevents future re-delivery).
 *
 * Steps 3 and 4 are not wrapped in a distributed transaction. If the process
 * crashes after step 3 but before step 4, the next replay attempt will receive
 * 404 (entry already removed) and cannot re-deliver — this is the safe
 * at-most-once outcome. The alternative (mark-before-remove) would risk
 * permanent data loss if `removeEntry` fails after the key was marked.
 */
router.post(
  '/jobs/dlq/:id/replay',
  ...adminOnly,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const idResult = validateDlqId(req.params.id);
    if (!idResult.ok || idResult.value === undefined) {
      res.status(400).json({ error: idResult.error ?? 'Invalid DLQ ID' });
      return;
    }
    const id = idResult.value;

    const reasonResult = validateReason(req.body?.reason);
    if (!reasonResult.ok || reasonResult.value === undefined) {
      res.status(400).json({ error: reasonResult.error ?? 'Invalid audit trail reason' });
      return;
    }
    const reason = reasonResult.value;

    if (!acquireReplayLock(id)) {
      res.status(409).json({ error: 'Replay already in progress for this DLQ record' });
      return;
    }

    try {
      if (!dlqStore) {
        res.status(503).json({ error: 'DLQ store is not initialized' });
        return;
      }

      if (replayInFlight.has(id)) {
        res.status(409).json({ error: 'Replay already in progress for this DLQ record' });
        return;
      }
      replayInFlight.add(id);

      const dlqItem = await dlqStore.getEntryById(id);
      if (!dlqItem) {
        replayInFlight.delete(id);
        res.status(404).json({ error: 'DLQ item not found' });
        return;
      }

      // Step 1: idempotency check — if the event was already processed by a
      // previous successful replay, short-circuit without re-delivering.
      const isDuplicate = await IdempotencyLayer.isEventProcessed(dlqItem.eventId);
      if (isDuplicate) {
        incrementDlqReplay('idempotent_noop');
        replayInFlight.delete(id);
        res.status(200).json({ status: 'ignored', reason: 'Idempotent no-op: Event already delivered' });
        return;
      }

      // Step 2: redact secrets, then attempt delivery.
      const safePayload = redactPayload(dlqItem.payload);
      const context = extractRequestContext(req);
      const result = await deliverRaw(dlqItem.targetUrl, dlqItem.eventId, safePayload, context);

      if (result.success) {
        // Step 3: remove from DLQ — delivery is confirmed.
        await dlqStore.removeEntry(id);

        // Step 4: register idempotency key — suppresses future re-delivery.
        // If this step fails the process is still correct (at-most-once): the
        // entry is gone so a second replay attempt will get 404.
        await IdempotencyLayer.markEventProcessed(dlqItem.eventId);

        incrementDlqReplay('success');
        res.status(200).json({
          status: 'success',
          message: 'DLQ record replayed and processed',
          auditReason: reason,
        });
      } else {
        // Delivery failed — increment attempt counter for poison-message detection.
        await dlqStore.incrementReplayAttempts(id);
        incrementDlqReplay('failed');
        res.status(500).json({
          status: 'failed',
          error: 'Delivery transmission failed during retry execution',
          ...(result.statusCode !== undefined && { statusCode: result.statusCode }),
          ...(result.errorCode !== undefined && { errorCode: result.errorCode }),
        });
      }
    } catch (error) {
      incrementDlqReplay('error');
      replayInFlight.delete(id);
      next(error);
    } finally {
      releaseReplayLock(id);
    }
  },
);

/**
 * POST /jobs/dlq/replay
 *
 * Batch replay over an arbitrary array of DLQ record IDs.
 *
 * ### Partial-failure semantics
 * Each record is processed independently. Per-item errors (store failure,
 * unexpected throw) are caught, counted as failures, and logged — they do not
 * abort the loop or discard already-committed deliveries. The response always
 * includes `successIds` so callers can reconcile what was committed even when
 * the overall response status is 200 with non-zero `failureCount`.
 *
 * An outer `try/catch` covers unrecoverable errors (e.g. store unavailable
 * before the loop starts) and delegates to Express error handling via `next`.
 */
router.post(
  '/jobs/dlq/replay',
  ...adminOnly,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const idsResult = validateBatchIds(req.body?.ids);
    if (!idsResult.ok || idsResult.value === undefined) {
      res.status(400).json({ error: idsResult.error ?? 'An array of valid IDs is required' });
      return;
    }
    const ids = idsResult.value;

    const reasonResult = validateReason(req.body?.reason);
    if (!reasonResult.ok || reasonResult.value === undefined) {
      res.status(400).json({ error: reasonResult.error ?? 'Invalid audit trail reason' });
      return;
    }
    const reason = reasonResult.value;

    // Deduplicate ids within the request and skip ids already in flight so
    // that a single batch cannot race against itself or another request.
    const uniqueIds = Array.from(new Set(ids as string[]));
    const lockedIds: string[] = [];
    const skippedIds: string[] = [];
    for (const id of uniqueIds) {
      if (acquireReplayLock(id)) {
        lockedIds.push(id);
      } else {
        skippedIds.push(id);
      }
    }

    try {
      if (!dlqStore) {
        res.status(503).json({ error: 'DLQ store is not initialized' });
        return;
      }

      const summary = { successCount: 0, noOpCount: 0, failureCount: 0 };
      // Track IDs that were successfully delivered and removed so callers can
      // reconcile even when failureCount > 0.
      const successIds: string[] = [];
      const context = extractRequestContext(req);

      for (const id of ids as string[]) {
        try {
          const dlqItem = await dlqStore.getEntryById(id);
          if (!dlqItem) {
            summary.failureCount++;
            continue;
          }

          // Idempotency guard — skip already-processed events.
          const isDuplicate = await IdempotencyLayer.isEventProcessed(dlqItem.eventId);
          if (isDuplicate) {
            incrementDlqReplay('idempotent_noop');
            summary.noOpCount++;
            continue;
          }

          const safePayload = redactPayload(dlqItem.payload);
          const result = await deliverRaw(dlqItem.targetUrl, dlqItem.eventId, safePayload, context);

          if (result.success) {
            // Remove before marking — see atomicity contract on the single-item handler.
            await dlqStore.removeEntry(id);
            await IdempotencyLayer.markEventProcessed(dlqItem.eventId);
            incrementDlqReplay('success');
            summary.successCount++;
            successIds.push(id);
          } else {
            await dlqStore.incrementReplayAttempts(id);
            incrementDlqReplay('failed');
            summary.failureCount++;
          }
        } catch (itemError: unknown) {
          // Per-item errors must not abort the batch. Log with enough context
          // to diagnose without leaking payload content.
          const message = itemError instanceof Error ? itemError.message : 'unknown error';
          logger.error('Batch DLQ replay: unexpected error processing item', {
            dlqItemId: id,
            error: message,
          });
          summary.failureCount++;
        }
      }

      res.status(200).json({
        status: 'batch_completed',
        auditReason: reason,
        details: summary,
        successIds,
      });
    } catch (error) {
      next(error);
    } finally {
      for (const id of lockedIds) {
        releaseReplayLock(id);
      }
    }
  },
);

export { router as jobsRouter };
export type { ReplayableDlqItem as DlqItem, ReplayableDlqStore as DlqStore };
export const __compat = { MAX_CONTEXT_FIELD_LENGTH } as const;
