import { Counter, Registry } from 'prom-client';

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
 */
export function incrementDlqOperation(operation: 'enqueue' | 'drop_overflow' | 'drop_poison'): void {
  webhookDlqOperationsTotal.labels(operation).inc();
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
 */
export function incrementDlqReplay(outcome: 'success' | 'failed' | 'idempotent_noop' | 'error'): void {
  webhookDlqReplaysTotal.labels(outcome).inc();
}