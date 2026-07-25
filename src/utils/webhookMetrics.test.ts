/**
 * @file webhookMetrics.test.ts
 * @description Unit tests for webhook DLQ metrics helpers
 */

import {
  incrementDlqOperation,
  incrementDlqReplay,
  webhookDlqRegistry,

} from './webhookMetrics';

describe('webhookMetrics DLQ counters', () => {
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
  });
});
