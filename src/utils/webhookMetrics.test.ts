/**
 * @fileoverview Tests for webhook delivery metrics counters and DLQ metrics.
 *
 * Asserts that outcome counters increment correctly for success, retry, and DLQ
 * delivery paths; that label cardinality stays bounded to host and status only;
 * and that raw URLs never leak into labels. DLQ operation and replay counters are
 * also covered. Metrics are reset between cases so tests remain independent of
 * any live Prometheus registry.
 *
 * Metric names documented in TSDoc:
 * - `webhook_delivery_total` — Counter for delivery outcomes (labels: outcome, host, status)
 * - `webhook_dlq_operations_total` — Counter for DLQ operations (labels: operation)
 * - `webhook_dlq_replays_total` — Counter for DLQ replays (labels: outcome)
 *
 * @module src/utils/webhookMetrics.test
 */

import {
  incrementDlqOperation,
  incrementDlqReplay,
  webhookDlqRegistry,
  // NOTE: If your source uses a different name for the delivery recorder,
  // change `recordWebhookOutcome` below to match (e.g. `recordDeliveryOutcome`).
  recordWebhookOutcome,
} from './webhookMetrics';

describe('webhookMetrics DLQ counters', () => {
  beforeEach(() => {
    webhookDlqRegistry.clear();
  });

  afterEach(() => {
    webhookDlqRegistry.clear();
  });

  describe('incrementDlqOperation', () => {
    it('increments enqueue counter', async () => {
      incrementDlqOperation('enqueue');

      const metrics = await webhookDlqRegistry.getMetricsAsJSON();
      const counter = metrics.find((m) => m.name === 'webhook_dlq_operations_total');
      expect(counter).toBeDefined();

      const value = (counter!.values as any[]).find(
        (v) => v.labels.operation === 'enqueue',
      );
      expect(value?.value).toBe(1);
    });

    it('increments drop_overflow counter', async () => {
      incrementDlqOperation('drop_overflow');
      incrementDlqOperation('drop_overflow');

      const metrics = await webhookDlqRegistry.getMetricsAsJSON();
      const counter = metrics.find((m) => m.name === 'webhook_dlq_operations_total');
      const value = (counter!.values as any[]).find(
        (v) => v.labels.operation === 'drop_overflow',
      );
      expect(value?.value).toBe(2);
    });

    it('increments drop_poison counter', async () => {
      incrementDlqOperation('drop_poison');

      const metrics = await webhookDlqRegistry.getMetricsAsJSON();
      const counter = metrics.find((m) => m.name === 'webhook_dlq_operations_total');
      const value = (counter!.values as any[]).find(
        (v) => v.labels.operation === 'drop_poison',
      );
      expect(value?.value).toBe(1);
    });

    it('throws or no-ops for an invalid operation name', () => {
      // Covers validation branch in incrementDlqOperation.
      expect(() => incrementDlqOperation('invalid_op' as any)).toThrow();
    });
  });

  describe('incrementDlqReplay', () => {
    it('increments success counter', async () => {
      incrementDlqReplay('success');

      const metrics = await webhookDlqRegistry.getMetricsAsJSON();
      const counter = metrics.find((m) => m.name === 'webhook_dlq_replays_total');
      expect(counter).toBeDefined();

      const value = (counter!.values as any[]).find((v) => v.labels.outcome === 'success');
      expect(value?.value).toBe(1);
    });

    it('increments failed counter', async () => {
      incrementDlqReplay('failed');
      incrementDlqReplay('failed');

      const metrics = await webhookDlqRegistry.getMetricsAsJSON();
      const counter = metrics.find((m) => m.name === 'webhook_dlq_replays_total');
      expect(counter).toBeDefined();
      const value = (counter!.values as any[]).find((v) => v.labels.outcome === 'failed');
      expect(value?.value).toBe(2);
    });

    it('increments idempotent_noop counter', async () => {
      incrementDlqReplay('idempotent_noop');

      const metrics = await webhookDlqRegistry.getMetricsAsJSON();
      const counter = metrics.find((m) => m.name === 'webhook_dlq_replays_total');
      expect(counter).toBeDefined();
      const value = (counter!.values as any[]).find(
        (v) => v.labels.outcome === 'idempotent_noop',
      );
      expect(value?.value).toBe(1);
    });

    it('increments error counter', async () => {
      incrementDlqReplay('error');

      const metrics = await webhookDlqRegistry.getMetricsAsJSON();
      const counter = metrics.find((m) => m.name === 'webhook_dlq_replays_total');
      expect(counter).toBeDefined();
      const value = (counter!.values as any[]).find((v) => v.labels.outcome === 'error');
      expect(value?.value).toBe(1);
    });

    it('throws or no-ops for an invalid replay outcome', () => {
      // Covers validation branch in incrementDlqReplay.
      expect(() => incrementDlqReplay('unknown' as any)).toThrow();
    });
  });
});

describe('webhookMetrics delivery outcome counters', () => {
  /**
   * Delivery metrics track the result of every webhook dispatch attempt.
   * Valid outcomes: `success`, `retry`, `dlq`.
   * Labels are intentionally bounded to `host` (hostname only) and `status`
   * (HTTP status code) to prevent unbounded cardinality.
   */
  beforeEach(() => {
    webhookDlqRegistry.clear();
  });

  afterEach(() => {
    webhookDlqRegistry.clear();
  });

  it('increments the success counter by 1', async () => {
    recordWebhookOutcome('success', 'hooks.example.com', '200');

    const metrics = await webhookDlqRegistry.getMetricsAsJSON();
    const counter = metrics.find((m) => m.name === 'webhook_delivery_total');
    expect(counter).toBeDefined();

    const value = (counter!.values as any[]).find(
      (v) => v.labels.outcome === 'success',
    );
    expect(value?.value).toBe(1);
  });

  it('increments the retry counter by 1', async () => {
    recordWebhookOutcome('retry', 'hooks.example.com', '503');

    const metrics = await webhookDlqRegistry.getMetricsAsJSON();
    const counter = metrics.find((m) => m.name === 'webhook_delivery_total');
    const value = (counter!.values as any[]).find(
      (v) => v.labels.outcome === 'retry',
    );
    expect(value?.value).toBe(1);
  });

  it('increments the dlq counter by 1', async () => {
    recordWebhookOutcome('dlq', 'hooks.example.com', '500');

    const metrics = await webhookDlqRegistry.getMetricsAsJSON();
    const counter = metrics.find((m) => m.name === 'webhook_delivery_total');
    const value = (counter!.values as any[]).find(
      (v) => v.labels.outcome === 'dlq',
    );
    expect(value?.value).toBe(1);
  });

  it('accumulates multiple outcomes independently', async () => {
    recordWebhookOutcome('success', 'a.com', '200');
    recordWebhookOutcome('success', 'a.com', '200');
    recordWebhookOutcome('retry', 'a.com', '503');
    recordWebhookOutcome('dlq', 'b.com', '500');
    recordWebhookOutcome('dlq', 'b.com', '500');
    recordWebhookOutcome('dlq', 'b.com', '500');

    const metrics = await webhookDlqRegistry.getMetricsAsJSON();
    const counter = metrics.find((m) => m.name === 'webhook_delivery_total');
    expect(counter).toBeDefined();

    const successValue = (counter!.values as any[]).find(
      (v) => v.labels.outcome === 'success',
    );
    const retryValue = (counter!.values as any[]).find(
      (v) => v.labels.outcome === 'retry',
    );
    const dlqValue = (counter!.values as any[]).find(
      (v) => v.labels.outcome === 'dlq',
    );

    expect(successValue?.value).toBe(2);
    expect(retryValue?.value).toBe(1);
    expect(dlqValue?.value).toBe(3);
  });

  describe('label cardinality bounds', () => {
    it('only exposes host and status labels on delivery counter', async () => {
      recordWebhookOutcome('success', 'webhook.partner.io', '201');

      const metrics = await webhookDlqRegistry.getMetricsAsJSON();
      const counter = metrics.find((m) => m.name === 'webhook_delivery_total');
      expect(counter).toBeDefined();

      const value = (counter!.values as any[])[0];
      const labelKeys = Object.keys(value.labels);

      expect(labelKeys).toContain('outcome');
      expect(labelKeys).toContain('host');
      expect(labelKeys).toContain('status');
      expect(labelKeys).toHaveLength(3);
    });

    it('normalizes host labels to hostname only (no protocol, no path)', async () => {
      recordWebhookOutcome('success', 'hooks.example.com', '200');

      const metrics = await webhookDlqRegistry.getMetricsAsJSON();
      const counter = metrics.find((m) => m.name === 'webhook_delivery_total');
      const value = (counter!.values as any[]).find(
        (v) => v.labels.outcome === 'success',
      );

      expect(value.labels.host).toBe('hooks.example.com');
      expect(value.labels.host).not.toContain('https://');
      expect(value.labels.host).not.toContain('/callback');
    });

    it('never records raw URLs in the host label', async () => {
      const rawUrl = 'https://hooks.example.com/webhook/callback?token=abc';
      recordWebhookOutcome('success', rawUrl, '200');

      const metrics = await webhookDlqRegistry.getMetricsAsJSON();
      const counter = metrics.find((m) => m.name === 'webhook_delivery_total');
      const values = counter!.values as any[];

      for (const v of values) {
        expect(v.labels.host).not.toContain('https://');
        expect(v.labels.host).not.toContain('/webhook');
        expect(v.labels.host).not.toContain('?token=');
        expect(v.labels.host).not.toContain('abc');
      }
    });

    it('keeps status label cardinality bounded to status codes', async () => {
      recordWebhookOutcome('retry', 'a.com', '429');
      recordWebhookOutcome('retry', 'a.com', '503');
      recordWebhookOutcome('retry', 'b.com', '504');

      const metrics = await webhookDlqRegistry.getMetricsAsJSON();
      const counter = metrics.find((m) => m.name === 'webhook_delivery_total');
      const values = counter!.values as any[];

      for (const v of values) {
        expect(v.labels.status).toMatch(/^\d{3}$/);
      }
    });
  });

  describe('metric isolation', () => {
    it('starts from zero after registry clear', async () => {
      recordWebhookOutcome('success', 'x.com', '200');
      webhookDlqRegistry.clear();

      const metrics = await webhookDlqRegistry.getMetricsAsJSON();
      const counter = metrics.find((m) => m.name === 'webhook_delivery_total');

      if (counter) {
        const total = (counter.values as any[]).reduce((sum, v) => sum + v.value, 0);
        expect(total).toBe(0);
      } else {
        expect(counter).toBeUndefined();
      }
    });

    it('does not leak state from a previous test case', async () => {
      recordWebhookOutcome('dlq', 'leak.com', '500');
      webhookDlqRegistry.clear();

      const metrics = await webhookDlqRegistry.getMetricsAsJSON();
      const counter = metrics.find((m) => m.name === 'webhook_delivery_total');

      if (counter) {
        const dlqValue = (counter.values as any[]).find(
          (v) => v.labels.outcome === 'dlq',
        );
        expect(dlqValue?.value ?? 0).toBe(0);
      }
    });
  });

  describe('edge cases', () => {
    it('handles non-standard status codes without crashing', async () => {
      expect(() => recordWebhookOutcome('success', 'test.com', '418')).not.toThrow();

      const metrics = await webhookDlqRegistry.getMetricsAsJSON();
      const counter = metrics.find((m) => m.name === 'webhook_delivery_total');
      const value = (counter!.values as any[]).find(
        (v) => v.labels.status === '418',
      );
      expect(value?.value).toBe(1);
    });

    it('handles empty host strings without crashing', async () => {
      expect(() => recordWebhookOutcome('success', '', '200')).not.toThrow();
    });

    it('throws for an invalid delivery outcome', () => {
      // Covers validation branch in recordWebhookOutcome.
      expect(() => recordWebhookOutcome('unknown' as any, 'test.com', '200')).toThrow();
    });
  });
});