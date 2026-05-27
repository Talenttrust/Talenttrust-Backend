import { Registry } from 'prom-client';
import { WebhookDeliveryService, DeliveryPayload } from './webhookDelivery';
import { getLabelValues } from './webhookMetrics';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRegistry() {
  return new Registry();
}

function makeService(registry: Registry) {
  return new WebhookDeliveryService(registry);
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
// WebhookDeliveryService integration tests
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

    it('records 4xx_client_error on HTTP 404', async () => {
      const registry = makeRegistry();
      const service = makeService(registry);
      const httpClient = jest.fn().mockResolvedValue({ statusCode: 404 });

      const result = await service.deliver(basePayload, httpClient);

      expect(result.success).toBe(false);
      const count = await getCounterValue(registry, {
        status: 'failure',
        provider: 'stripe',
        reason: '4xx_client_error',
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

      // The raw provider name must NOT appear in the metrics output
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
  });
});
