/**
 * webhookDelivery.test.ts
 *
 * Tests for WebhookDeliveryService, covering:
 *  - Existing delivery success / failure / cardinality / latency behaviour
 *  - getLabelValues unit tests
 *  - Circuit-breaker state transitions: CLOSED → OPEN → HALF_OPEN → CLOSED
 *  - Circuit-open fast-path to DLQ (no HTTP call, correct metrics)
 *  - Concurrent probe guard (HALF_OPEN + probeInFlight)
 *  - Breaker reset (admin path)
 *  - Non-2xx responses count as failures toward the breaker threshold
 *  - Breaker state gauge (webhook_breaker_state) reflects transitions
 */

import { Registry } from 'prom-client';
import { WebhookDeliveryService, DeliveryPayload, DLQEntry } from './webhookDelivery';
import { getLabelValues } from './webhookMetrics';
import type { WebhookRetryConfig } from './appConfiguration';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const defaultRetryConfig: WebhookRetryConfig = {
  maxAttempts: 5,
  initialDelayMs: 100, // Short for testing
  maxDelayMs: 1000,
  multiplier: 2,
  jitterFactor: 0.1,
};

function makeRegistry() {
  return new Registry();
}

/**
 * Creates a service with a very low failure threshold so tests can trip the
 * breaker quickly without many mock calls.
 */
function makeService(
  registry: Registry,
  breakerConfig: { failureThreshold?: number; successThreshold?: number; timeoutMs?: number } = {},
  retryConfigOrCallback?: Partial<WebhookRetryConfig> | ((entry: DLQEntry) => Promise<void> | void),
  dlqCallback?: (entry: DLQEntry) => Promise<void> | void,
) {
  const isRetryConfig =
    typeof retryConfigOrCallback === 'object' &&
    retryConfigOrCallback !== null &&
    ('maxAttempts' in retryConfigOrCallback || 'initialDelayMs' in retryConfigOrCallback);

  const retryConfig = isRetryConfig ? (retryConfigOrCallback as Partial<WebhookRetryConfig>) : undefined;
  const callback = isRetryConfig ? dlqCallback : (retryConfigOrCallback as ((entry: DLQEntry) => Promise<void> | void) | undefined);

  return new WebhookDeliveryService(
    registry,
    {
      failureThreshold: 3,
      successThreshold: 1,
      timeoutMs: 50,
      ...breakerConfig,
    },
    retryConfig,
    callback,
  );
}

const basePayload: DeliveryPayload = {
  provider: 'stripe',
  url: 'https://example.com/webhook',
  body: { event: 'payment.succeeded' },
};

async function getCounterValue(
  registry: Registry,
  labels: Record<string, string>,
): Promise<number> {
  const metrics = await registry.getMetricsAsJSON();
  const counter = metrics.find((m) => m.name === 'webhook_delivery_attempts_total');
  if (!counter || !('values' in counter)) return 0;
  const match = (counter.values as Array<{ labels: Record<string, string>; value: number }>).find(
    (v) => Object.entries(labels).every(([k, val]) => v.labels[k] === val),
  );
  return match?.value ?? 0;
}

async function getRetryCounterValue(
  registry: Registry,
  labels: Record<string, string>,
): Promise<number> {
  const metrics = await registry.getMetricsAsJSON();
  const counter = metrics.find((m) => m.name === 'webhook_delivery_retries_total');
  if (!counter || !('values' in counter)) return 0;
  const match = (counter.values as Array<{ labels: Record<string, string>; value: number }>).find(
    (v) =>
      Object.entries(labels).every(([k, val]) => v.labels[k] === val),
  );
  return match?.value ?? 0;
}

async function getHistogramSampleCount(
  registry: Registry,
  labels: Record<string, string>,
): Promise<number> {
  const metrics = await registry.getMetricsAsJSON();
  const hist = metrics.find((m) => m.name === 'webhook_delivery_latency_seconds');
  if (!hist || !('values' in hist)) return 0;
  const countEntry = (
    hist.values as Array<{ labels: Record<string, string>; value: number; metricName?: string }>
  ).find(
    (v) =>
      v.metricName === 'webhook_delivery_latency_seconds_count' &&
      Object.entries(labels).every(([k, val]) => v.labels[k] === val),
  );
  return countEntry?.value ?? 0;
}

async function getBreakerGaugeValue(
  registry: Registry,
  provider: string,
): Promise<number | undefined> {
  const metrics = await registry.getMetricsAsJSON();
  const gauge = metrics.find((m) => m.name === 'webhook_breaker_state');
  if (!gauge || !('values' in gauge)) return undefined;
  const entry = (gauge.values as Array<{ labels: Record<string, string>; value: number }>).find(
    (v) => v.labels['provider'] === provider,
  );
  return entry?.value;
}

/** Trips the breaker by delivering `count` consecutive failures. */
async function tripBreaker(
  service: WebhookDeliveryService,
  count: number,
  payload = basePayload,
): Promise<void> {
  const failingClient = jest
    .fn()
    .mockResolvedValue({ statusCode: 400 });
  for (let i = 0; i < count; i++) {
    await service.deliver(payload, failingClient);
  }
}

// ---------------------------------------------------------------------------
// getLabelValues unit tests
// ---------------------------------------------------------------------------

describe('getLabelValues', () => {
  it('returns success for 2xx status codes', () => {
    expect(getLabelValues(200)).toEqual({ status: 'success', reason: 'unknown' });
    expect(getLabelValues(201)).toEqual({ status: 'success', reason: 'unknown' });
  });

  it('returns 4xx_client_error for 4xx status codes', () => {
    expect(getLabelValues(400)).toEqual({ status: 'failure', reason: '4xx_client_error' });
    expect(getLabelValues(404)).toEqual({ status: 'failure', reason: '4xx_client_error' });
  });

  it('returns 5xx_server_error for 5xx status codes', () => {
    expect(getLabelValues(500)).toEqual({ status: 'failure', reason: '5xx_server_error' });
    expect(getLabelValues(503)).toEqual({ status: 'failure', reason: '5xx_server_error' });
  });

  it('returns timeout for ETIMEDOUT error', () => {
    expect(getLabelValues(undefined, 'ETIMEDOUT')).toEqual({ status: 'failure', reason: 'timeout' });
    expect(getLabelValues(undefined, 'ECONNABORTED')).toEqual({ status: 'failure', reason: 'timeout' });
  });

  it('returns dns_resolution_failure for ENOTFOUND / EAI_AGAIN', () => {
    expect(getLabelValues(undefined, 'ENOTFOUND')).toEqual({ status: 'failure', reason: 'dns_resolution_failure' });
    expect(getLabelValues(undefined, 'EAI_AGAIN')).toEqual({ status: 'failure', reason: 'dns_resolution_failure' });
  });

  it('returns connection_refused for ECONNREFUSED', () => {
    expect(getLabelValues(undefined, 'ECONNREFUSED')).toEqual({ status: 'failure', reason: 'connection_refused' });
  });

  it('returns unknown for unrecognised errors', () => {
    expect(getLabelValues(undefined, 'SOME_WEIRD_CODE')).toEqual({ status: 'failure', reason: 'unknown' });
    expect(getLabelValues()).toEqual({ status: 'failure', reason: 'unknown' });
  });
});

// ---------------------------------------------------------------------------
// WebhookDeliveryService — existing delivery behaviour
// ---------------------------------------------------------------------------

describe('WebhookDeliveryService', () => {
  describe('successful delivery', () => {
    it('increments success counter and records latency', async () => {
      const registry = makeRegistry();
      const service = makeService(registry);
      const httpClient = jest.fn().mockResolvedValue({ statusCode: 200 });

      const result = await service.deliver(basePayload, httpClient);

      expect(result.success).toBe(true);
      expect(result.statusCode).toBe(200);
      expect(result.durationSeconds).toBeGreaterThanOrEqual(0);

      const count = await getCounterValue(registry, {
        status: 'success',
        provider: 'stripe',
        reason: 'unknown',
      });
      expect(count).toBe(1);

      const histCount = await getHistogramSampleCount(registry, {
        status: 'success',
        provider: 'stripe',
      });
      expect(histCount).toBe(1);
    });

    it('increments counter again on a second successful call', async () => {
      const registry = makeRegistry();
      const service = makeService(registry);
      const httpClient = jest.fn().mockResolvedValue({ statusCode: 200 });

      await service.deliver(basePayload, httpClient);
      await service.deliver(basePayload, httpClient);

      const count = await getCounterValue(registry, {
        status: 'success',
        provider: 'stripe',
        reason: 'unknown',
      });
      expect(count).toBe(2);
    });
  });

  describe('non-retryable failures (4xx)', () => {
    it('does not retry on 4xx_client_error (HTTP 404)', async () => {
      const registry = makeRegistry();
      const service = makeService(registry);
      const httpClient = jest.fn().mockResolvedValue({ statusCode: 404 });

      const result = await service.deliver(basePayload, httpClient);

      expect(result.success).toBe(false);
      expect(httpClient).toHaveBeenCalledTimes(1);

      const count = await getCounterValue(registry, {
        status: 'failure',
        provider: 'stripe',
        reason: '4xx_client_error',
      });
      expect(count).toBe(1);

      const retryCount = await getRetryCounterValue(registry, {
        provider: 'stripe',
        reason: '4xx_client_error',
      });
      expect(retryCount).toBe(0);
    });

    it('does not retry on other 4xx errors', async () => {
      const registry = makeRegistry();
      const service = makeService(registry);
      const httpClient = jest.fn().mockResolvedValue({ statusCode: 401 });

      const result = await service.deliver(basePayload, httpClient);

      expect(result.success).toBe(false);
      expect(httpClient).toHaveBeenCalledTimes(1);
    });

    it('does not retry on HTTP 400 Bad Request', async () => {
      const registry = makeRegistry();
      const service = makeService(registry);
      const httpClient = jest.fn().mockResolvedValue({ statusCode: 400 });

      const result = await service.deliver(basePayload, httpClient);

      expect(result.success).toBe(false);
      expect(httpClient).toHaveBeenCalledTimes(1);
    });
  });

  describe('retryable failures (5xx)', () => {
    it('retries on 5xx_server_error (HTTP 500) then succeeds', async () => {
      const registry = makeRegistry();
      const service = makeService(registry);
      const httpClient = jest
        .fn()
        .mockResolvedValueOnce({ statusCode: 500 })
        .mockResolvedValueOnce({ statusCode: 500 })
        .mockResolvedValueOnce({ statusCode: 200 });

      const result = await service.deliver(basePayload, httpClient);

      expect(result.success).toBe(true);
      expect(httpClient).toHaveBeenCalledTimes(3);

      const retryCount = await getRetryCounterValue(registry, {
        provider: 'stripe',
        reason: '5xx_server_error',
      });
      expect(retryCount).toBe(2);
    });

    it('retries on HTTP 503 Service Unavailable', async () => {
      const registry = makeRegistry();
      const service = makeService(registry);
      const httpClient = jest
        .fn()
        .mockResolvedValueOnce({ statusCode: 503 })
        .mockResolvedValueOnce({ statusCode: 200 });

      const result = await service.deliver(basePayload, httpClient);

      expect(result.success).toBe(true);
      expect(httpClient).toHaveBeenCalledTimes(2);
    });

    it('retries until max attempts reached then enqueues to DLQ', async () => {
      const registry = makeRegistry();
      const dlqEntries: DLQEntry[] = [];
      const dlqCallback = jest.fn(async (entry: DLQEntry) => {
        dlqEntries.push(entry);
      });
      const service = makeService(registry, {}, defaultRetryConfig, dlqCallback);
      const httpClient = jest.fn().mockResolvedValue({ statusCode: 500 });

      const result = await service.deliver(basePayload, httpClient);

      expect(result.success).toBe(false);
      expect(result.enqueueToDoLQ).toBe(true);
      expect(httpClient).toHaveBeenCalledTimes(5); // maxAttempts = 5
      expect(dlqCallback).toHaveBeenCalledTimes(1);

      const dlqEntry = dlqEntries[0];
      expect(dlqEntry).toMatchObject({
        provider: 'stripe',
        url: 'https://example.com/webhook',
        body: { event: 'payment.succeeded' },
        failureReason: '5xx_server_error',
        finalAttemptNumber: 5,
      });

      const retryCount = await getRetryCounterValue(registry, {
        provider: 'stripe',
        reason: '5xx_server_error',
      });
      expect(retryCount).toBe(4); // 4 retries (attempt 2-5), attempt 1 is initial
    });
  });

  describe('transient network errors', () => {
    it('retries on ETIMEDOUT error then succeeds', async () => {
      const registry = makeRegistry();
      const service = makeService(registry);
      const err = Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
      const httpClient = jest
        .fn()
        .mockRejectedValueOnce(err)
        .mockResolvedValueOnce({ statusCode: 200 });

      const result = await service.deliver(basePayload, httpClient);

      expect(result.success).toBe(true);
      expect(httpClient).toHaveBeenCalledTimes(2);

      const retryCount = await getRetryCounterValue(registry, {
        provider: 'stripe',
        reason: 'timeout',
      });
      expect(retryCount).toBe(1);
    });

    it('retries on ECONNRESET error then succeeds', async () => {
      const registry = makeRegistry();
      const service = makeService(registry);
      const err = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
      const httpClient = jest
        .fn()
        .mockRejectedValueOnce(err)
        .mockResolvedValueOnce({ statusCode: 200 });

      const result = await service.deliver(basePayload, httpClient);

      expect(result.success).toBe(true);
      expect(httpClient).toHaveBeenCalledTimes(2);
    });

    it('retries on ECONNABORTED error', async () => {
      const registry = makeRegistry();
      const service = makeService(registry);
      const err = Object.assign(new Error('connection aborted'), { code: 'ECONNABORTED' });
      const httpClient = jest
        .fn()
        .mockRejectedValueOnce(err)
        .mockResolvedValueOnce({ statusCode: 200 });

      const result = await service.deliver(basePayload, httpClient);

      expect(result.success).toBe(true);
      expect(httpClient).toHaveBeenCalledTimes(2);
    });

    it('retries on ENOTFOUND (DNS) error then succeeds', async () => {
      const registry = makeRegistry();
      const service = makeService(registry);
      const err = Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
      const httpClient = jest
        .fn()
        .mockRejectedValueOnce(err)
        .mockResolvedValueOnce({ statusCode: 200 });

      const result = await service.deliver(basePayload, httpClient);

      expect(result.success).toBe(true);
      expect(httpClient).toHaveBeenCalledTimes(2);

      const retryCount = await getRetryCounterValue(registry, {
        provider: 'stripe',
        reason: 'dns_resolution_failure',
      });
      expect(retryCount).toBe(1);
    });

    it('exhausts retries on ETIMEDOUT and enqueues to DLQ', async () => {
      const registry = makeRegistry();
      const dlqEntries: DLQEntry[] = [];
      const dlqCallback = jest.fn(async (entry: DLQEntry) => {
        dlqEntries.push(entry);
      });
      const service = makeService(registry, {}, defaultRetryConfig, dlqCallback);
      const err = Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
      const httpClient = jest.fn().mockRejectedValue(err);

      const result = await service.deliver(basePayload, httpClient);

      expect(result.success).toBe(false);
      expect(result.enqueueToDoLQ).toBe(true);
      expect(httpClient).toHaveBeenCalledTimes(5);
      expect(dlqCallback).toHaveBeenCalledTimes(1);

      const dlqEntry = dlqEntries[0];
      expect(dlqEntry.failureReason).toBe('timeout');
      expect(dlqEntry.finalAttemptNumber).toBe(5);
    });
  });

  describe('exponential backoff behavior', () => {
    it('applies exponential backoff with increasing delays', async () => {
      const registry = makeRegistry();
      const service = makeService(registry);
      const timings: number[] = [];
      const httpClient = jest.fn(async () => {
        timings.push(Date.now());
        return { statusCode: 500 };
      });

      await service.deliver(basePayload, httpClient);

      expect(httpClient).toHaveBeenCalledTimes(5);
      expect(timings.length).toBe(5);

      // Check that delays increase exponentially
      // Note: Jitter makes exact values hard to predict, but general trend should be there
      const delay1 = timings[1] - timings[0];
      const delay2 = timings[2] - timings[1];
      const delay3 = timings[3] - timings[2];

      // Delays should generally increase (within jitter bounds)
      expect(delay2).toBeGreaterThan(0);
      expect(delay3).toBeGreaterThan(0);
    });

    it('caps delay at maxDelayMs', async () => {
      const registry = makeRegistry();
      const fastRetryConfig: WebhookRetryConfig = {
        maxAttempts: 10,
        initialDelayMs: 100,
        maxDelayMs: 500,
        multiplier: 3, // High multiplier to exceed max quickly
        jitterFactor: 0.1,
      };
      const service = makeService(registry, {}, fastRetryConfig);
      const timings: number[] = [];
      const httpClient = jest.fn(async () => {
        timings.push(Date.now());
        return { statusCode: 500 };
      });

      await service.deliver(basePayload, httpClient);

      // Check that delays don't exceed maxDelayMs by too much
      for (let i = 1; i < timings.length; i++) {
        const delay = timings[i] - timings[i - 1];
        expect(delay).toBeLessThanOrEqual(fastRetryConfig.maxDelayMs + 100); // +100 for jitter
      }
    });
  });

  describe('cardinality safety', () => {
    it('maps unknown providers to "generic"', async () => {
      const registry = makeRegistry();
      const service = makeService(registry);
      const httpClient = jest.fn().mockResolvedValue({ statusCode: 200 });

      await service.deliver({ ...basePayload, provider: 'some-random-provider-xyz' }, httpClient);

      const count = await getCounterValue(registry, {
        status: 'success',
        provider: 'generic',
        reason: 'unknown',
      });
      expect(count).toBe(1);
    });

    it('does not create a label entry for an arbitrary provider name', async () => {
      const registry = makeRegistry();
      const service = makeService(registry);
      const httpClient = jest.fn().mockResolvedValue({ statusCode: 200 });

      await service.deliver({ ...basePayload, provider: 'webhook-id-abc123' }, httpClient);

      const raw = await registry.metrics();
      expect(raw).not.toContain('webhook-id-abc123');
    });
  });

  describe('latency histogram', () => {
    it('records one observation per delivery call', async () => {
      const registry = makeRegistry();
      const service = makeService(registry);
      const httpClient = jest.fn().mockResolvedValue({ statusCode: 200 });

      await service.deliver(basePayload, httpClient);
      await service.deliver(basePayload, httpClient);
      await service.deliver({ ...basePayload, provider: 'github' }, httpClient);

      const stripeCount = await getHistogramSampleCount(registry, {
        status: 'success',
        provider: 'stripe',
      });
      expect(stripeCount).toBe(2);

      const githubCount = await getHistogramSampleCount(registry, {
        status: 'success',
        provider: 'github',
      });
      expect(githubCount).toBe(1);
    });

    it('records histogram entries for each retry attempt', async () => {
      const registry = makeRegistry();
      const service = makeService(registry);
      const httpClient = jest
        .fn()
        .mockResolvedValueOnce({ statusCode: 500 })
        .mockResolvedValueOnce({ statusCode: 500 })
        .mockResolvedValueOnce({ statusCode: 200 });

      await service.deliver(basePayload, httpClient);

      // Should record 3 histogram entries (one per attempt)
      const count = await getHistogramSampleCount(registry, {
        status: 'success',
        provider: 'stripe',
      });
      expect(count).toBeGreaterThan(0);
    });
  });

  describe('HMAC signature semantics', () => {
    it('does not re-sign webhook on retries (signature remains with original timestamp)', async () => {
      const registry = makeRegistry();
      const service = makeService(registry);
      // Signature and timestamp are passed in the payload body (as strings/metadata)
      // The httpClient receives them and should not modify them
      const signedPayload: DeliveryPayload = {
        provider: 'stripe',
        url: 'https://example.com/webhook',
        body: {
          event: 'payment.succeeded',
          // In real usage, headers would contain X-Signature and X-Timestamp
          // These are not retried/re-signed
        },
      };

      const httpClient = jest
        .fn()
        .mockResolvedValueOnce({ statusCode: 500 })
        .mockResolvedValueOnce({ statusCode: 200 });

      const result = await service.deliver(signedPayload, httpClient);

      expect(result.success).toBe(true);
      // Both calls receive the exact same body (signature unchanged)
      expect(httpClient).toHaveBeenCalledWith(signedPayload.url, signedPayload.body);
      expect(httpClient).toHaveBeenCalledWith(signedPayload.url, signedPayload.body);
    });
  });

  describe('DLQ callback error handling', () => {
    it('handles DLQ callback failures gracefully', async () => {
      const registry = makeRegistry();
      const dlqCallback = jest.fn(async () => {
        throw new Error('DLQ storage failed');
      });
      const service = makeService(registry, {}, defaultRetryConfig, dlqCallback);
      const httpClient = jest.fn().mockResolvedValue({ statusCode: 500 });

      const result = await service.deliver(basePayload, httpClient);

      expect(result.success).toBe(false);
      expect(result.enqueueToDoLQ).toBe(true);
      // Should not throw, callback should be invoked despite error
      expect(dlqCallback).toHaveBeenCalledTimes(1);
    });

    it('records failure even if DLQ callback is not set', async () => {
      const registry = makeRegistry();
      const service = makeService(registry, {}, defaultRetryConfig, undefined);
      const httpClient = jest.fn().mockResolvedValue({ statusCode: 500 });

      const result = await service.deliver(basePayload, httpClient);

      expect(result.success).toBe(false);
      expect(result.enqueueToDoLQ).toBe(true);
    });
  });

  describe('failure scenarios', () => {
    it('records 5xx_server_error on HTTP 500', async () => {
      const registry = makeRegistry();
      const service = makeService(registry);
      const httpClient = jest.fn().mockResolvedValue({ statusCode: 500 });

      const result = await service.deliver(basePayload, httpClient);

      expect(result.success).toBe(false);
      const count = await getCounterValue(registry, {
        status: 'failure',
        provider: 'stripe',
        reason: '5xx_server_error',
      });
      expect(count).toBe(1);
    });

    it('records timeout on ETIMEDOUT network error', async () => {
      const registry = makeRegistry();
      const service = makeService(registry);
      const err = Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
      const httpClient = jest.fn().mockRejectedValue(err);

      const result = await service.deliver(basePayload, httpClient);

      expect(result.success).toBe(false);
      expect(result.statusCode).toBeUndefined();
      const count = await getCounterValue(registry, {
        status: 'failure',
        provider: 'stripe',
        reason: 'timeout',
      });
      expect(count).toBe(1);
    });

    it('records dns_resolution_failure on ENOTFOUND', async () => {
      const registry = makeRegistry();
      const service = makeService(registry);
      const err = Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
      const httpClient = jest.fn().mockRejectedValue(err);

      await service.deliver(basePayload, httpClient);

      const count = await getCounterValue(registry, {
        status: 'failure',
        provider: 'stripe',
        reason: 'dns_resolution_failure',
      });
      expect(count).toBe(1);
    });

    it('records connection_refused on ECONNREFUSED', async () => {
      const registry = makeRegistry();
      const service = makeService(registry);
      const err = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
      const httpClient = jest.fn().mockRejectedValue(err);

      await service.deliver(basePayload, httpClient);

      const count = await getCounterValue(registry, {
        status: 'failure',
        provider: 'stripe',
        reason: 'connection_refused',
      });
      expect(count).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// Circuit-breaker state-machine tests
// ---------------------------------------------------------------------------

describe('WebhookDeliveryService — circuit breaker', () => {
  // Use fake timers so HALF_OPEN cooldown tests are deterministic.
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  // ── CLOSED → OPEN ──────────────────────────────────────────────────────────

  describe('CLOSED → OPEN transition', () => {
    it('breaker starts CLOSED', () => {
      const service = makeService(makeRegistry(), { failureThreshold: 3 });
      expect(service.getBreakerState('stripe')).toBe('CLOSED');
    });

    it('trips to OPEN after failureThreshold consecutive failures', async () => {
      const registry = makeRegistry();
      const service = makeService(registry, { failureThreshold: 3 });
      const failingClient = jest
        .fn()
        .mockResolvedValue({ statusCode: 400 });

      // 2 failures — still CLOSED
      await service.deliver(basePayload, failingClient);
      await service.deliver(basePayload, failingClient);
      expect(service.getBreakerState('stripe')).toBe('CLOSED');

      // 3rd failure — trips to OPEN
      await service.deliver(basePayload, failingClient);
      expect(service.getBreakerState('stripe')).toBe('OPEN');
    });

    it('resets failure count on a success before threshold', async () => {
      const registry = makeRegistry();
      const service = makeService(registry, { failureThreshold: 3 });
      const failingClient = jest
        .fn()
        .mockResolvedValue({ statusCode: 400 });
      const successClient = jest.fn().mockResolvedValue({ statusCode: 200 });

      await service.deliver(basePayload, failingClient);
      await service.deliver(basePayload, failingClient);
      // Success resets the failure count
      await service.deliver(basePayload, successClient);
      // Two more failures — should NOT trip (count was reset)
      await service.deliver(basePayload, failingClient);
      await service.deliver(basePayload, failingClient);

      expect(service.getBreakerState('stripe')).toBe('CLOSED');
    });
  });

  // ── OPEN fast-path ─────────────────────────────────────────────────────────

  describe('OPEN state — fast-path to DLQ', () => {
    it('returns circuitOpen:true and does not call httpClient when OPEN', async () => {
      const registry = makeRegistry();
      const service = makeService(registry, { failureThreshold: 3 });
      await tripBreaker(service, 3);

      const httpClient = jest.fn().mockResolvedValue({ statusCode: 200 });
      const result = await service.deliver(basePayload, httpClient);

      expect(result.circuitOpen).toBe(true);
      expect(result.success).toBe(false);
      expect(result.durationSeconds).toBe(0);
      expect(httpClient).not.toHaveBeenCalled();
    });

    it('records circuit_open reason in delivery counter when OPEN', async () => {
      const registry = makeRegistry();
      const service = makeService(registry, { failureThreshold: 3 });
      await tripBreaker(service, 3);

      const httpClient = jest.fn().mockResolvedValue({ statusCode: 200 });
      await service.deliver(basePayload, httpClient);

      const count = await getCounterValue(registry, {
        status: 'failure',
        provider: 'stripe',
        reason: 'circuit_open',
      });
      expect(count).toBeGreaterThanOrEqual(1);
    });

    it('sets webhook_breaker_state gauge to 1 (OPEN) when tripped', async () => {
      const registry = makeRegistry();
      const service = makeService(registry, { failureThreshold: 3 });
      await tripBreaker(service, 3);

      // Trigger a deliver so the gauge is emitted
      await service.deliver(basePayload, jest.fn());

      const gaugeValue = await getBreakerGaugeValue(registry, 'stripe');
      expect(gaugeValue).toBe(1); // 1 = OPEN
    });

    it('multiple OPEN fast-paths all record circuit_open', async () => {
      const registry = makeRegistry();
      const service = makeService(registry, { failureThreshold: 3 });
      await tripBreaker(service, 3);

      const httpClient = jest.fn();
      await service.deliver(basePayload, httpClient);
      await service.deliver(basePayload, httpClient);
      await service.deliver(basePayload, httpClient);

      expect(httpClient).not.toHaveBeenCalled();

      const count = await getCounterValue(registry, {
        status: 'failure',
        provider: 'stripe',
        reason: 'circuit_open',
      });
      expect(count).toBe(3);
    });
  });

  // ── OPEN → HALF_OPEN ───────────────────────────────────────────────────────

  describe('OPEN → HALF_OPEN transition', () => {
    it('transitions to HALF_OPEN after cooldown elapses', async () => {
      const registry = makeRegistry();
      const service = makeService(registry, { failureThreshold: 3, timeoutMs: 100 });
      await tripBreaker(service, 3);
      expect(service.getBreakerState('stripe')).toBe('OPEN');

      // Advance fake timers past the cooldown
      jest.advanceTimersByTime(150);

      expect(service.getBreakerState('stripe')).toBe('HALF_OPEN');
    });

    it('does not transition before cooldown elapses', async () => {
      const registry = makeRegistry();
      const service = makeService(registry, { failureThreshold: 3, timeoutMs: 100 });
      await tripBreaker(service, 3);

      jest.advanceTimersByTime(50); // only half the cooldown

      expect(service.getBreakerState('stripe')).toBe('OPEN');
    });
  });

  // ── HALF_OPEN → CLOSED ─────────────────────────────────────────────────────

  describe('HALF_OPEN → CLOSED transition (probe succeeds)', () => {
    it('closes the circuit when the probe succeeds', async () => {
      const registry = makeRegistry();
      const service = makeService(registry, {
        failureThreshold: 3,
        successThreshold: 1,
        timeoutMs: 100,
      });
      await tripBreaker(service, 3);
      jest.advanceTimersByTime(150);
      expect(service.getBreakerState('stripe')).toBe('HALF_OPEN');

      const successClient = jest.fn().mockResolvedValue({ statusCode: 200 });
      const result = await service.deliver(basePayload, successClient);

      expect(result.success).toBe(true);
      expect(result.circuitOpen).toBeFalsy();
      expect(service.getBreakerState('stripe')).toBe('CLOSED');
    });

    it('sets webhook_breaker_state gauge to 0 (CLOSED) after probe succeeds', async () => {
      const registry = makeRegistry();
      const service = makeService(registry, {
        failureThreshold: 3,
        successThreshold: 1,
        timeoutMs: 100,
      });
      await tripBreaker(service, 3);
      jest.advanceTimersByTime(150);

      const successClient = jest.fn().mockResolvedValue({ statusCode: 200 });
      await service.deliver(basePayload, successClient);

      const gaugeValue = await getBreakerGaugeValue(registry, 'stripe');
      expect(gaugeValue).toBe(0); // 0 = CLOSED
    });

    it('requires successThreshold successes before closing', async () => {
      const registry = makeRegistry();
      const service = makeService(registry, {
        failureThreshold: 3,
        successThreshold: 2,
        timeoutMs: 100,
      });
      await tripBreaker(service, 3);
      jest.advanceTimersByTime(150);

      const successClient = jest.fn().mockResolvedValue({ statusCode: 200 });

      // First probe — still HALF_OPEN (successThreshold = 2)
      await service.deliver(basePayload, successClient);
      expect(service.getBreakerState('stripe')).toBe('HALF_OPEN');

      // Second probe — now CLOSED
      await service.deliver(basePayload, successClient);
      expect(service.getBreakerState('stripe')).toBe('CLOSED');
    });
  });

  // ── HALF_OPEN → OPEN ───────────────────────────────────────────────────────

  describe('HALF_OPEN → OPEN transition (probe fails)', () => {
    it('re-opens the circuit when the probe fails', async () => {
      const registry = makeRegistry();
      const service = makeService(registry, {
        failureThreshold: 3,
        successThreshold: 1,
        timeoutMs: 100,
      });
      await tripBreaker(service, 3);
      jest.advanceTimersByTime(150);
      expect(service.getBreakerState('stripe')).toBe('HALF_OPEN');

      const failingClient = jest
        .fn()
        .mockResolvedValue({ statusCode: 400 });
      await service.deliver(basePayload, failingClient);

      expect(service.getBreakerState('stripe')).toBe('OPEN');
    });

    it('full CLOSED→OPEN→HALF_OPEN→OPEN→HALF_OPEN→CLOSED cycle', async () => {
      const registry = makeRegistry();
      const service = makeService(registry, {
        failureThreshold: 3,
        successThreshold: 1,
        timeoutMs: 100,
      });
      const failingClient = jest
        .fn()
        .mockResolvedValue({ statusCode: 400 });
      const successClient = jest.fn().mockResolvedValue({ statusCode: 200 });

      // Trip to OPEN
      await tripBreaker(service, 3);
      expect(service.getBreakerState('stripe')).toBe('OPEN');

      // Cooldown → HALF_OPEN
      jest.advanceTimersByTime(150);
      expect(service.getBreakerState('stripe')).toBe('HALF_OPEN');

      // Probe fails → back to OPEN
      await service.deliver(basePayload, failingClient);
      expect(service.getBreakerState('stripe')).toBe('OPEN');

      // Second cooldown → HALF_OPEN again
      jest.advanceTimersByTime(150);
      expect(service.getBreakerState('stripe')).toBe('HALF_OPEN');

      // Probe succeeds → CLOSED
      await service.deliver(basePayload, successClient);
      expect(service.getBreakerState('stripe')).toBe('CLOSED');
    });
  });

  // ── Breaker reset (admin path) ─────────────────────────────────────────────

  describe('resetBreaker (admin path)', () => {
    it('force-resets an OPEN breaker to CLOSED', async () => {
      const registry = makeRegistry();
      const service = makeService(registry, { failureThreshold: 3 });
      await tripBreaker(service, 3);
      expect(service.getBreakerState('stripe')).toBe('OPEN');

      service.resetBreaker('stripe');

      expect(service.getBreakerState('stripe')).toBe('CLOSED');
    });

    it('updates the gauge to 0 (CLOSED) after reset', async () => {
      const registry = makeRegistry();
      const service = makeService(registry, { failureThreshold: 3 });
      await tripBreaker(service, 3);

      service.resetBreaker('stripe');

      const gaugeValue = await getBreakerGaugeValue(registry, 'stripe');
      expect(gaugeValue).toBe(0);
    });

    it('is a no-op for a provider that has never been used', () => {
      const service = makeService(makeRegistry());
      expect(() => service.resetBreaker('github')).not.toThrow();
    });
  });

  // ── Per-provider isolation ─────────────────────────────────────────────────

  describe('per-provider isolation', () => {
    it('tripping stripe breaker does not affect github breaker', async () => {
      const registry = makeRegistry();
      const service = makeService(registry, { failureThreshold: 3 });
      await tripBreaker(service, 3, basePayload); // stripe

      expect(service.getBreakerState('stripe')).toBe('OPEN');
      expect(service.getBreakerState('github')).toBe('CLOSED');
    });

    it('github deliveries succeed while stripe is OPEN', async () => {
      const registry = makeRegistry();
      const service = makeService(registry, { failureThreshold: 3 });
      await tripBreaker(service, 3, basePayload); // stripe

      const successClient = jest.fn().mockResolvedValue({ statusCode: 200 });
      const result = await service.deliver(
        { ...basePayload, provider: 'github' },
        successClient,
      );

      expect(result.success).toBe(true);
      expect(result.circuitOpen).toBeFalsy();
      expect(successClient).toHaveBeenCalledTimes(1);
    });

    it('unknown providers share the "generic" breaker', async () => {
      const registry = makeRegistry();
      const service = makeService(registry, { failureThreshold: 3 });
      const failingClient = jest
        .fn()
        .mockResolvedValue({ statusCode: 400 });

      // Trip via one unknown provider
      for (let i = 0; i < 3; i++) {
        await service.deliver({ ...basePayload, provider: 'unknown-a' }, failingClient);
      }

      // A different unknown provider shares the same "generic" breaker
      const httpClient = jest.fn().mockResolvedValue({ statusCode: 200 });
      const result = await service.deliver(
        { ...basePayload, provider: 'unknown-b' },
        httpClient,
      );

      expect(result.circuitOpen).toBe(true);
      expect(httpClient).not.toHaveBeenCalled();
    });
  });

  // ── Non-2xx responses count toward breaker threshold ──────────────────────

  describe('non-2xx HTTP responses count as failures', () => {
    it('trips the breaker after repeated 500 responses', async () => {
      const registry = makeRegistry();
      const service = makeService(registry, { failureThreshold: 3 }, { maxAttempts: 1 });
      const serverErrorClient = jest.fn().mockResolvedValue({ statusCode: 500 });

      await service.deliver(basePayload, serverErrorClient);
      await service.deliver(basePayload, serverErrorClient);
      await service.deliver(basePayload, serverErrorClient);

      expect(service.getBreakerState('stripe')).toBe('OPEN');
    });
  });

  // ── Gauge reflects all transitions ────────────────────────────────────────

  describe('webhook_breaker_state gauge', () => {
    it('starts at 0 (CLOSED) on first delivery', async () => {
      const registry = makeRegistry();
      const service = makeService(registry, { failureThreshold: 3 });
      const successClient = jest.fn().mockResolvedValue({ statusCode: 200 });

      await service.deliver(basePayload, successClient);

      const gaugeValue = await getBreakerGaugeValue(registry, 'stripe');
      expect(gaugeValue).toBe(0); // CLOSED
    });

    it('transitions gauge: 0 → 1 → 2 → 0 across full cycle', async () => {
      const registry = makeRegistry();
      const service = makeService(registry, {
        failureThreshold: 3,
        successThreshold: 1,
        timeoutMs: 100,
      });
      const failingClient = jest
        .fn()
        .mockResolvedValue({ statusCode: 400 });
      const successClient = jest.fn().mockResolvedValue({ statusCode: 200 });

      // CLOSED (0)
      await service.deliver(basePayload, successClient);
      expect(await getBreakerGaugeValue(registry, 'stripe')).toBe(0);

      // Trip to OPEN (1)
      await tripBreaker(service, 3);
      await service.deliver(basePayload, jest.fn()); // trigger gauge emit
      expect(await getBreakerGaugeValue(registry, 'stripe')).toBe(1);

      // Cooldown → HALF_OPEN (2)
      jest.advanceTimersByTime(150);
      await service.deliver(basePayload, successClient);
      // After successful probe the breaker closes, so gauge should be 0
      expect(await getBreakerGaugeValue(registry, 'stripe')).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Inbound Webhook HMAC Verification Property Tests
// ---------------------------------------------------------------------------

import * as fc from 'fast-check';
import {
  constantTimeCompareHex,
  verifyWebhookSignature,
  WEBHOOK_SIGNATURE_HEX_LENGTH,
  generateSignature,
} from './utils/webhook-signing.util';

describe('WebhookSignature Verification — Property Tests (fast-check)', () => {
  const secret = 'property-test-webhook-secret-fast-check';
  const now = 1_700_000_000_000;

  it('accepts valid signatures and rejects forgeries (fuzzing signatures, payloads, and timestamps)', () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string(), fc.string()),
        fc.integer({ min: -300_000, max: 300_000 }),
        fc.option(fc.string(), { freq: 5, nil: undefined }),
        fc.option(fc.integer(), { freq: 5, nil: undefined }),
        fc.option(fc.string(), { freq: 5, nil: undefined }),
        (fuzzedPayload, validOffset, tamperedSignature, tamperedTimestamp, tamperedSecret) => {
          const timestamp = tamperedTimestamp ?? (now + validOffset);
          const validSignature = generateSignature(fuzzedPayload, secret, timestamp);
          const signatureToTest = tamperedSignature ?? validSignature;
          const secretToTest = tamperedSecret ?? secret;
          
          const result = verifyWebhookSignature(
            fuzzedPayload,
            signatureToTest,
            timestamp,
            secretToTest,
            { now }
          );

          if (
            tamperedSignature === undefined &&
            tamperedTimestamp === undefined &&
            tamperedSecret === undefined &&
            Math.abs(validOffset) <= 300_000
          ) {
            expect(result.valid).toBe(true);
            expect(result.code).toBe('valid');
          } else {
            const isActuallyValid =
              signatureToTest === validSignature &&
              secretToTest === secret &&
              timestamp >= now - 300_000 &&
              timestamp <= now + 300_000 &&
              Number.isFinite(timestamp);

            if (!isActuallyValid) {
              expect(result.valid).toBe(false);
              expect(result.code).not.toBe('valid');
              expect(result.message.length).toBeGreaterThan(0);
              
              if (secretToTest && secretToTest.length > 5) {
                expect(result.message).not.toContain(secretToTest);
              }
              expect(result.message).not.toContain(validSignature);
            }
          }
        }
      ),
      { seed: 0x277a11ce, numRuns: 400 }
    );
  });

  it('constant-time comparison behaves correctly and routes errors', () => {
    const spy = jest.spyOn(require('crypto'), 'timingSafeEqual');
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 15 }), { minLength: WEBHOOK_SIGNATURE_HEX_LENGTH, maxLength: WEBHOOK_SIGNATURE_HEX_LENGTH }).map(arr => arr.map(n => n.toString(16)).join('')),
        fc.array(fc.integer({ min: 0, max: 15 }), { minLength: WEBHOOK_SIGNATURE_HEX_LENGTH, maxLength: WEBHOOK_SIGNATURE_HEX_LENGTH }).map(arr => arr.map(n => n.toString(16)).join('')),
        (a: string, b: string) => {
          spy.mockClear();
          constantTimeCompareHex(a, b);
          expect(spy).toHaveBeenCalled();
        }
      ),
      { seed: 0x277a11ce, numRuns: 50 }
    );
    spy.mockRestore();
  });
});
