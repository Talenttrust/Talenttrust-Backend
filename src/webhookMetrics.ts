import { Counter, Histogram, Registry } from 'prom-client';

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
  'unknown',
] as const;
export type FailureReason = typeof FAILURE_REASONS[number];

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

  return { deliveryAttemptsTotal, deliveryLatencySeconds };
}

export type WebhookMetrics = ReturnType<typeof createWebhookMetrics>;
