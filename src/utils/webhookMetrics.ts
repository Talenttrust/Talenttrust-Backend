import { Counter, Registry } from 'prom-client';
import {
  DlqOperationSchema,
  DlqReplayOutcomeSchema,
  DLQ_OPERATIONS,
  DLQ_REPLAY_OUTCOMES,
} from '../observability/metrics-validation';

// ---------------------------------------------------------------------------
// Isolated Registry for WebhookMetrics DLQ counters
// ---------------------------------------------------------------------------

/**
 * Isolated prom-client Registry for webhook DLQ metrics.
 * Using a dedicated registry prevents duplicate metric registration errors
 * in test environments and allows test isolation via registry.clear().
 */
export const webhookDlqRegistry = new Registry();

// ---------------------------------------------------------------------------
// Existing Metrics (From Project Specifications)
// ---------------------------------------------------------------------------

/**
 * Total count of standard webhook DLQ lifecycle operations.
 * Labels cover: 'enqueue', 'drop_overflow', 'drop_poison'
 */
export const webhookDlqOperationsTotal = new Counter({
  name: 'webhook_dlq_operations_total',
  help: 'Total number of webhook DLQ core operations.',
  labelNames: ['operation'],
  registers: [webhookDlqRegistry],
});

/**
 * Helper to increment standard DLQ storage lifecycle events.
 * @param operation - The storage operation type executed
 * @throws {TypeError} when operation is not a recognised DLQ operation string
 */
export function incrementDlqOperation(operation: 'enqueue' | 'drop_overflow' | 'drop_poison'): void {
  const result = DlqOperationSchema.safeParse(operation);
  if (!result.success) {
    throw new TypeError(
      `Invalid DLQ operation: ${JSON.stringify(operation)}. ` +
        `Must be one of: ${DLQ_OPERATIONS.join(', ')}`,
    );
  }
  webhookDlqOperationsTotal.labels(result.data).inc();
}

// ---------------------------------------------------------------------------
// New Issue #256 Metrics (DLQ Idempotent Replays)
// ---------------------------------------------------------------------------

/**
 * Total tracking counts of manual or batch DLQ replay operations.
 * Labels cover: 'success', 'failed', 'idempotent_noop', 'error'
 */
export const webhookDlqReplaysTotal = new Counter({
  name: 'webhook_dlq_replays_total',
  help: 'Total tracking counts of webhook DLQ manual or batch replay jobs executed.',
  labelNames: ['outcome'],
  registers: [webhookDlqRegistry],
});

/**
 * Helper to increment metrics counters following a DLQ replay attempt.
 * @param outcome - The resulting resolution path of the replay action
 * @throws {TypeError} when outcome is not a recognised DLQ replay outcome string
 */
export function incrementDlqReplay(outcome: 'success' | 'failed' | 'idempotent_noop' | 'error'): void {
  const result = DlqReplayOutcomeSchema.safeParse(outcome);
  if (!result.success) {
    throw new TypeError(
      `Invalid DLQ replay outcome: ${JSON.stringify(outcome)}. ` +
        `Must be one of: ${DLQ_REPLAY_OUTCOMES.join(', ')}`,
    );
  }
  webhookDlqReplaysTotal.labels(result.data).inc();
}