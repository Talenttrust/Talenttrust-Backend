/**
 * @module api/jobs
 *
 * Background job orchestration for webhook delivery and DLQ management.
 *
 * ## Responsibilities
 * - Initialize the DLQ store (in-memory or Redis-backed).
 * - Start the DLQ metrics sampling loop.
 * - Expose authenticated endpoints for idempotent DLQ message replay.
 *
 * ## Configuration (environment variables)
 * | Variable                  | Default | Description                                    |
 * |---------------------------|---------|------------------------------------------------|
 * | `DLQ_METRICS_INTERVAL_MS` | `30000` | DLQ metrics sampling interval in milliseconds. |
 *
 * ## Usage
 * Call {@link initializeJobs} once at application startup (e.g., from `index.ts`).
 */

import axios from 'axios';
import { Router, Request, Response, NextFunction } from 'express';
import { startDlqMetricsSampling, incrementDlqReplay } from '../webhookMetrics';
import { redactPayload } from '../utils/redact';
import { IdempotencyLayer } from '../events/idempotency';
import { requireAuth, requireRole } from '../middleware/authorization';

// ---------------------------------------------------------------------------
// Store contract
// ---------------------------------------------------------------------------

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
// Module-level state
// ---------------------------------------------------------------------------

let dlqStore: ReplayableDlqStore | null = null;
let stopSampling: (() => void) | null = null;

const router = Router();

/**
 * Deliver a raw DLQ payload to its target URL.
 *
 * @returns `true` when the destination responded with a 2xx status.
 */
async function deliverRaw(
  targetUrl: string,
  eventId: string,
  payload: Record<string, unknown>,
): Promise<boolean> {
  try {
    const response = await axios.post(targetUrl, payload, {
      headers: { 'X-Event-Id': eventId },
      validateStatus: () => true,
    });
    return response.status >= 200 && response.status < 300;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Load DLQ metrics sampling interval from environment variables.
 *
 * @returns Sampling interval in milliseconds.
 */
function loadDlqMetricsInterval(): number {
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

// ---------------------------------------------------------------------------
// Public API & Lifecycle Orchestration
// ---------------------------------------------------------------------------

/**
 * Initialize background jobs: DLQ store and metrics sampling.
 *
 * This function is idempotent — calling it multiple times will stop the
 * previous sampling loop and start a new one.
 *
 * @param customDlqStore - The DLQ store backing replay operations.
 * @returns The initialized DLQ store.
 */
export function initializeJobs(customDlqStore: ReplayableDlqStore): ReplayableDlqStore {
  // Stop any existing sampling loop
  if (stopSampling !== null) {
    stopSampling();
    stopSampling = null;
  }

  dlqStore = customDlqStore;

  // Start DLQ metrics sampling
  const intervalMs = loadDlqMetricsInterval();
  stopSampling = startDlqMetricsSampling(dlqStore, intervalMs);

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

// ---------------------------------------------------------------------------
// REST API Routing Interface Endpoints
// ---------------------------------------------------------------------------

const adminOnly = [requireAuth, requireRole('admin')];

/**
 * POST /jobs/dlq/:id/replay
 * Replays an individual dead letter queue message back through the delivery stack.
 */
router.post(
  '/jobs/dlq/:id/replay',
  ...adminOnly,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const id = String(req.params.id ?? '');
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : '';

    if (id.length === 0) {
      res.status(400).json({ error: 'Invalid DLQ record ID' });
      return;
    }
    if (reason.length < 5) {
      res.status(400).json({ error: 'Audit trail reason must be at least 5 characters long' });
      return;
    }

    try {
      if (!dlqStore) {
        res.status(503).json({ error: 'DLQ store is not initialized' });
        return;
      }

      const dlqItem = await dlqStore.getEntryById(id);
      if (!dlqItem) {
        res.status(404).json({ error: 'DLQ item not found' });
        return;
      }

      // Check the event idempotency layer cache before delivery
      const isDuplicate = await IdempotencyLayer.isEventProcessed(dlqItem.eventId);
      if (isDuplicate) {
        incrementDlqReplay('idempotent_noop');
        res.status(200).json({ status: 'ignored', reason: 'Idempotent no-op: Event already delivered' });
        return;
      }

      // Redact sensitive payload properties before delivery logic processing
      const safePayload = redactPayload(dlqItem.payload);

      const deliverySuccess = await deliverRaw(dlqItem.targetUrl, dlqItem.eventId, safePayload);

      if (deliverySuccess) {
        await dlqStore.removeEntry(id);
        await IdempotencyLayer.markEventProcessed(dlqItem.eventId);
        incrementDlqReplay('success');
        res.status(200).json({ status: 'success', message: 'DLQ record replayed and processed', auditReason: reason });
      } else {
        await dlqStore.incrementReplayAttempts(id);
        incrementDlqReplay('failed');
        res.status(500).json({ status: 'failed', error: 'Delivery transmission failed during retry execution' });
      }
    } catch (error) {
      incrementDlqReplay('error');
      next(error);
    }
  },
);

/**
 * POST /jobs/dlq/replay
 * Performs batch replay over an arbitrary array of target active DLQ item IDs.
 */
router.post(
  '/jobs/dlq/replay',
  ...adminOnly,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const ids: unknown = req.body?.ids;
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : '';

    if (!Array.isArray(ids) || ids.length === 0 || !ids.every((v) => typeof v === 'string')) {
      res.status(400).json({ error: 'An array of valid IDs is required' });
      return;
    }
    if (reason.length < 5) {
      res.status(400).json({ error: 'Audit trail reason must be at least 5 characters long' });
      return;
    }

    try {
      if (!dlqStore) {
        res.status(503).json({ error: 'DLQ store is not initialized' });
        return;
      }

      const summary = { successCount: 0, noOpCount: 0, failureCount: 0 };

      for (const id of ids as string[]) {
        const dlqItem = await dlqStore.getEntryById(id);
        if (!dlqItem) {
          summary.failureCount++;
          continue;
        }

        const isDuplicate = await IdempotencyLayer.isEventProcessed(dlqItem.eventId);
        if (isDuplicate) {
          incrementDlqReplay('idempotent_noop');
          summary.noOpCount++;
          continue;
        }

        const safePayload = redactPayload(dlqItem.payload);
        const deliverySuccess = await deliverRaw(dlqItem.targetUrl, dlqItem.eventId, safePayload);

        if (deliverySuccess) {
          await dlqStore.removeEntry(id);
          await IdempotencyLayer.markEventProcessed(dlqItem.eventId);
          incrementDlqReplay('success');
          summary.successCount++;
        } else {
          await dlqStore.incrementReplayAttempts(id);
          incrementDlqReplay('failed');
          summary.failureCount++;
        }
      }

      res.status(200).json({ status: 'batch_completed', auditReason: reason, details: summary });
    } catch (error) {
      next(error);
    }
  },
);

export { router as jobsRouter };
