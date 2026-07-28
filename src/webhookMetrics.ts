import { Counter, Gauge, Histogram, Registry } from 'prom-client';

// Finite set of allowed label values — cardinality-safe
export const PROVIDERS = ['stripe', 'github', 'slack', 'sendgrid', 'generic'] as const;
export type Provider = typeof PROVIDERS[number];

export const STATUSES = ['success', 'failure'] as const;
export type Status = typeof STATUSES[number];

export const FAILURE_REASONS = [
  'timeout',
  '4xx_client_error',
  '5xx_server_error',
  'dns_resolution_failure',
  'connection_refused',
  'circuit_open',
  'unknown',
] as const;
export type FailureReason = typeof FAILURE_REASONS[number];

export const DLQ_OPERATIONS = ['enqueue', 'drop_overflow', 'drop_poison'] as const;
export type DLQOperation = typeof DLQ_OPERATIONS[number];

/**
 * Numeric encoding for circuit-breaker states used in the Prometheus gauge.
 * Using a gauge (not a counter) so dashboards can read the current state directly.
 *
 * | Value | State      |
 * |-------|------------|
 * |   0   | CLOSED     |
 * |   1   | OPEN       |
 * |   2   | HALF_OPEN  |
 */
export const BREAKER_STATE_VALUES = {
  CLOSED: 0,
  OPEN: 1,
  HALF_OPEN: 2,
} as const;

export type BreakerStateValue = typeof BREAKER_STATE_VALUES[keyof typeof BREAKER_STATE_VALUES];

/**
 * Maps an HTTP status code or error type to a structured failure reason.
 * Never exposes raw error messages or unique identifiers.
 */
export function getLabelValues(
  statusCode?: number,
  errorType?: string,
): { status: Status; reason: FailureReason } {
  if (errorType === 'ECONNREFUSED') {
    return { status: 'failure', reason: 'connection_refused' };
  }
  if (errorType === 'ENOTFOUND' || errorType === 'EAI_AGAIN') {
    return { status: 'failure', reason: 'dns_resolution_failure' };
  }
  if (errorType === 'ETIMEDOUT' || errorType === 'ECONNABORTED') {
    return { status: 'failure', reason: 'timeout' };
  }
  if (statusCode !== undefined) {
    if (statusCode >= 200 && statusCode < 300) {
      return { status: 'success', reason: 'unknown' };
    }
    if (statusCode >= 400 && statusCode < 500) {
      return { status: 'failure', reason: '4xx_client_error' };
    }
    if (statusCode >= 500) {
      return { status: 'failure', reason: '5xx_server_error' };
    }
  }
  return { status: 'failure', reason: 'unknown' };
}

export function createWebhookMetrics(registry: Registry) {
  const deliveryAttemptsTotal = new Counter({
    name: 'webhook_delivery_attempts_total',
    help: 'Total number of webhook delivery attempts',
    labelNames: ['status', 'provider', 'reason'] as const,
    registers: [registry],
  });

  const deliveryLatencySeconds = new Histogram({
    name: 'webhook_delivery_latency_seconds',
    help: 'Webhook delivery latency in seconds',
    labelNames: ['status', 'provider'] as const,
    buckets: [0.1, 0.5, 1, 2, 5, 10],
    registers: [registry],
  });

  const deliveryRetriesTotal = new Counter({
    name: 'webhook_delivery_retries_total',
    help: 'Total number of webhook delivery retries due to transient failures',
    labelNames: ['provider', 'reason'] as const,
    registers: [registry],
  });

  const dlqOperationsTotal = new Counter({
    name: 'webhook_dlq_operations_total',
    help: 'Total number of DLQ operations',
    labelNames: ['operation'] as const,
    registers: [registry],
  });

  /**
   * Per-provider circuit-breaker state gauge.
   *
   * Label: `provider` — sanitized to the finite {@link PROVIDERS} set.
   * Value encoding: 0 = CLOSED, 1 = OPEN, 2 = HALF_OPEN (see {@link BREAKER_STATE_VALUES}).
   *
   * Using a Gauge (not a Counter) so monitoring dashboards can read the
   * current state directly without needing to diff successive counter values.
   */
  const webhookBreakerState = new Gauge({
    name: 'webhook_breaker_state',
    help: 'Current circuit-breaker state per provider (0=CLOSED, 1=OPEN, 2=HALF_OPEN)',
    labelNames: ['provider'] as const,
    registers: [registry],
  });

  return {
    deliveryAttemptsTotal,
    deliveryLatencySeconds,
    deliveryRetriesTotal,
    dlqOperationsTotal,
    webhookBreakerState,
  };
}

export type WebhookMetrics = ReturnType<typeof createWebhookMetrics>;

/**
 * Record a throttled webhook delivery (rate limit triggered).
 * @param providerId - The provider ID that was throttled.
 */
export function recordThrottled(_providerId: string): void {
  // Placeholder implementation - can be connected to metrics system
  // For now, this is a no-op function to satisfy the import requirement
}

/**
 * Record a webhook delivery rejected because the per-provider waiter queue
 * reached its configured maximum depth. No provider label is attached so
 * cardinality stays at zero.
 */
export function recordQueueOverflow(): void {
  // Placeholder implementation - no-op until connected to a real metrics
  // backend. Kept as a stable hook so callers have a side-effect-free
  // integration point.
}

/**
 * Record the outcome of a DLQ replay attempt.
 * @param _outcome - Replay outcome label (e.g. 'success', 'failed', 'error',
 *   'idempotent_noop').
 */
export function incrementDlqReplay(_outcome: string): void {
  // Placeholder implementation - can be connected to a counter in the metrics
  // registry. Kept as a no-op so callers have a stable, side-effect-free hook.
}

/**
 * Start DLQ metrics sampling at regular intervals.
 * @param dlqStore - The DLQ store instance.
 * @param intervalMs - Sampling interval in milliseconds.
 * @returns A function to stop sampling.
 */
export function startDlqMetricsSampling(dlqStore: any, intervalMs: number): () => void {
  const intervalId = setInterval(() => {
    // Placeholder implementation for DLQ metrics sampling
    // This would typically query dlqStore and record metrics
  }, intervalMs);

  return () => clearInterval(intervalId);
}

