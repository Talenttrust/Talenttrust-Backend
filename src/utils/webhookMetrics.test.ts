/**
 * @module webhookMetrics.test
 * @description Unit tests for the webhook DLQ metrics counters and gauges.
 *
 * These tests verify that:
 * - DLQ operation counters (enqueue, drop_overflow, drop_poison) increment
 *   correctly and reject invalid label values.
 * - DLQ replay outcome counters (success, failed, idempotent_noop, error)
 *   increment correctly and reject invalid label values.
 * - Label cardinality stays bounded: only `operation` and `outcome` labels
 *   are emitted; raw URLs or other high-cardinality strings never reach
 *   the metric store.
 * - The isolated prom-client registry can be cleared between tests so cases
 *   remain independent.
 *
 * @security
 * - No secret value, URL, or user-controlled string is ever passed into a
 *   metric label in these tests.
 * - Invalid inputs are rejected with TypeError rather than silently accepted.
 */

import {
  webhookDlqRegistry,
  webhookDlqOperationsTotal,
  incrementDlqOperation,
  webhookDlqReplaysTotal,
  incrementDlqReplay,
} from './webhookMetrics';

// ─── Helper functions ─────────────────────────────────────────────────────────

/**
 * Extract the current value of a counter for a specific label set.
 *
 * @param metricName - The prom-client metric name.
 * @param labels - The label key/value pair to look up.
 * @returns The counter value, or `undefined` if the label set has not been
 *   observed yet.
 */
async function getCounterValue(
  metricName: string,
  labels: Record<string, string>,
): Promise<number | undefined> {
  const metrics = await webhookDlqRegistry.getMetricsAsJSON();
  const metric = metrics.find((m) => m.name === metricName);
  if (!metric) return undefined;

  const values = metric.values as Array<{
    labels: Record<string, string>;
    value: number;
  }>;

  const match = values.find((v) =>
    Object.entries(labels).every(([key, val]) => v.labels[key] === val),
  );

  return match?.value;
}

/**
 * Return every distinct label name that appears on a given metric.
 *
 * Used to assert that label cardinality stays bounded and that no
 * unexpected label keys (e.g. `url`, `host`, `path`) are introduced.
 *
 * @param metricName - The prom-client metric name.
 * @returns A sorted array of unique label key names.
 */
async function getMetricLabelNames(metricName: string): Promise<string[]> {
  const metrics = await webhookDlqRegistry.getMetricsAsJSON();
  const metric = metrics.find((m) => m.name === metricName);
  if (!metric) return [];

  const values = metric.values as Array<{ labels: Record<string, string> }>;
  const keys = new Set<string>();
  for (const v of values) {
    for (const k of Object.keys(v.labels)) {
      keys.add(k);
    }
  }
  return Array.from(keys).sort();
}

/**
 * Return every distinct label value for a given label key on a metric.
 *
 * @param metricName - The prom-client metric name.
 * @param labelKey - The label key whose values should be enumerated.
 * @returns A sorted array of unique label values.
 */
async function getMetricLabelValues(
  metricName: string,
  labelKey: string,
): Promise<string[]> {
  const metrics = await webhookDlqRegistry.getMetricsAsJSON();
  const metric = metrics.find((m) => m.name === metricName);
  if (!metric) return [];

  const values = metric.values as Array<{ labels: Record<string, string> }>;
  const seen = new Set<string>();
  for (const v of values) {
    if (labelKey in v.labels) {
      seen.add(v.labels[labelKey]);
    }
  }
  return Array.from(seen).sort();
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('incrementDlqOperation', () => {
  beforeEach(() => {
    resetWebhookMetrics();
  });

  it('throws TypeError for invalid operation', () => {
    expect(() => incrementDlqOperation('invalid' as any)).toThrow(TypeError);
    expect(() => incrementDlqOperation('invalid' as any)).toThrow(
      'Invalid DLQ operation',
    );
  });

  it('increments the enqueue counter', async () => {
    incrementDlqOperation('enqueue');

    const value = await getCounterValue('webhook_dlq_operations_total', {
      operation: 'enqueue',
    });
    expect(value).toBe(1);
  });

  it('increments the drop_overflow counter', async () => {
    incrementDlqOperation('drop_overflow');

    const value = await getCounterValue('webhook_dlq_operations_total', {
      operation: 'drop_overflow',
    });
    expect(value).toBe(1);
  });

  it('increments the drop_poison counter', async () => {
    incrementDlqOperation('drop_poison');

    const value = await getCounterValue('webhook_dlq_operations_total', {
      operation: 'drop_poison',
    });
    expect(value).toBe(1);
  });

  it('accumulates multiple increments for the same operation', async () => {
    incrementDlqOperation('enqueue');
    incrementDlqOperation('enqueue');
    incrementDlqOperation('enqueue');

    const value = await getCounterValue('webhook_dlq_operations_total', {
      operation: 'enqueue',
    });
    expect(value).toBe(3);
  });

  it('tracks multiple operations independently', async () => {
    incrementDlqOperation('enqueue');
    incrementDlqOperation('drop_overflow');
    incrementDlqOperation('drop_poison');
    incrementDlqOperation('enqueue');

    const enqueue = await getCounterValue('webhook_dlq_operations_total', {
      operation: 'enqueue',
    });
    const overflow = await getCounterValue('webhook_dlq_operations_total', {
      operation: 'drop_overflow',
    });
    const poison = await getCounterValue('webhook_dlq_operations_total', {
      operation: 'drop_poison',
    });

    expect(enqueue).toBe(2);
    expect(overflow).toBe(1);
    expect(poison).toBe(1);
  });

  it('throws TypeError for an invalid operation string', () => {
    expect(() => incrementDlqOperation('invalid_operation' as any)).toThrow(
      TypeError,
    );
    expect(() => incrementDlqOperation('invalid_operation' as any)).toThrow(
      /Invalid DLQ operation/,
    );
  });

  it('throws TypeError for empty string', () => {
    expect(() => incrementDlqOperation('' as any)).toThrow(TypeError);
  });

  it('throws TypeError for undefined', () => {
    expect(() => incrementDlqOperation(undefined as any)).toThrow(TypeError);
  });

  it('does not mutate the counter when validation fails', async () => {
    // Pre-seed with one valid increment so we can detect mutation
    incrementDlqOperation('enqueue');

    try {
      incrementDlqOperation('bad' as any);
    } catch {
      // expected
    }

    const value = await getCounterValue('webhook_dlq_operations_total', {
      operation: 'enqueue',
    });
    expect(value).toBe(1);
  });

  it('emits only the "operation" label key', async () => {
    incrementDlqOperation('enqueue');
    incrementDlqOperation('drop_overflow');

    const labelNames = await getMetricLabelNames('webhook_dlq_operations_total');
    expect(labelNames).toEqual(['operation']);
  });

  it('emits a bounded set of operation label values', async () => {
    incrementDlqOperation('enqueue');
    incrementDlqOperation('drop_overflow');
    incrementDlqOperation('drop_poison');

    const labelValues = await getMetricLabelValues(
      'webhook_dlq_operations_total',
      'operation',
    );
    expect(labelValues).toEqual(['drop_overflow', 'drop_poison', 'enqueue']);
  });

  it('never accepts a raw URL as an operation label', () => {
    // This test documents the security boundary: even if a caller mistakenly
    // passes a URL, the Zod schema rejects it before the metric is touched.
    expect(() =>
      incrementDlqOperation('https://example.com/webhook' as any),
    ).toThrow(TypeError);
  });
});

describe('incrementDlqReplay', () => {
  beforeEach(() => {
    resetWebhookMetrics();
  });

  it('throws TypeError for invalid replay outcome', () => {
    expect(() => incrementDlqReplay('invalid' as any)).toThrow(TypeError);
    expect(() => incrementDlqReplay('invalid' as any)).toThrow(
      'Invalid DLQ replay outcome',
    );
  });

  it('increments the success counter', async () => {
    incrementDlqReplay('success');

    const value = await getCounterValue('webhook_dlq_replays_total', {
      outcome: 'success',
    });
    expect(value).toBe(1);
  });

  it('increments the failed counter', async () => {
    incrementDlqReplay('failed');

    const value = await getCounterValue('webhook_dlq_replays_total', {
      outcome: 'failed',
    });
    expect(value).toBe(1);
  });

  it('increments the idempotent_noop counter', async () => {
    incrementDlqReplay('idempotent_noop');

    const value = await getCounterValue('webhook_dlq_replays_total', {
      outcome: 'idempotent_noop',
    });
    expect(value).toBe(1);
  });

  it('increments the error counter', async () => {
    incrementDlqReplay('error');

    const value = await getCounterValue('webhook_dlq_replays_total', {
      outcome: 'error',
    });
    expect(value).toBe(1);
  });

  it('accumulates multiple increments for the same outcome', async () => {
    incrementDlqReplay('success');
    incrementDlqReplay('success');
    incrementDlqReplay('success');

    const value = await getCounterValue('webhook_dlq_replays_total', {
      outcome: 'success',
    });
    expect(value).toBe(3);
  });

  it('tracks multiple outcomes independently', async () => {
    incrementDlqReplay('success');
    incrementDlqReplay('failed');
    incrementDlqReplay('idempotent_noop');
    incrementDlqReplay('error');
    incrementDlqReplay('success');

    const success = await getCounterValue('webhook_dlq_replays_total', {
      outcome: 'success',
    });
    const failed = await getCounterValue('webhook_dlq_replays_total', {
      outcome: 'failed',
    });
    const noop = await getCounterValue('webhook_dlq_replays_total', {
      outcome: 'idempotent_noop',
    });
    const error = await getCounterValue('webhook_dlq_replays_total', {
      outcome: 'error',
    });

    expect(success).toBe(2);
    expect(failed).toBe(1);
    expect(noop).toBe(1);
    expect(error).toBe(1);
  });

  it('throws TypeError for an invalid outcome string', () => {
    expect(() => incrementDlqReplay('unknown' as any)).toThrow(TypeError);
    expect(() => incrementDlqReplay('unknown' as any)).toThrow(
      /Invalid DLQ replay outcome/,
    );
  });

  it('throws TypeError for empty string', () => {
    expect(() => incrementDlqReplay('' as any)).toThrow(TypeError);
  });

  it('throws TypeError for null', () => {
    expect(() => incrementDlqReplay(null as any)).toThrow(TypeError);
  });

  it('does not mutate the counter when validation fails', async () => {
    incrementDlqReplay('success');

    try {
      incrementDlqReplay('bad' as any);
    } catch {
      // expected
    }

    const value = await getCounterValue('webhook_dlq_replays_total', {
      outcome: 'success',
    });
    expect(value).toBe(1);
  });

  it('emits only the "outcome" label key', async () => {
    incrementDlqReplay('success');
    incrementDlqReplay('failed');

    const labelNames = await getMetricLabelNames('webhook_dlq_replays_total');
    expect(labelNames).toEqual(['outcome']);
  });

  it('emits a bounded set of outcome label values', async () => {
    incrementDlqReplay('success');
    incrementDlqReplay('failed');
    incrementDlqReplay('idempotent_noop');
    incrementDlqReplay('error');

    const labelValues = await getMetricLabelValues(
      'webhook_dlq_replays_total',
      'outcome',
    );
    expect(labelValues).toEqual([
      'error',
      'failed',
      'idempotent_noop',
      'success',
    ]);
  });

  it('never accepts a raw URL as an outcome label', () => {
    expect(() =>
      incrementDlqReplay('https://example.com/callback' as any),
    ).toThrow(TypeError);
  });
});

describe('webhookDlqRegistry isolation', () => {
  beforeEach(() => {
    resetWebhookMetrics();
  });

  it('starts with zero metrics after reset', async () => {
    const metrics = await webhookDlqRegistry.getMetricsAsJSON();
    const ops = metrics.find((m) => m.name === 'webhook_dlq_operations_total');
    const replays = metrics.find((m) => m.name === 'webhook_dlq_replays_total');

    expect(ops?.values ?? []).toHaveLength(0);
    expect(replays?.values ?? []).toHaveLength(0);
  });

  it('does not leak state from a previous test case', async () => {
    // Simulate a previous test that incremented counters
    incrementDlqOperation('enqueue');
    incrementDlqReplay('success');

    // Reset (as beforeEach would do)
    resetWebhookMetrics();

    const metrics = await webhookDlqRegistry.getMetricsAsJSON();
    const ops = metrics.find((m) => m.name === 'webhook_dlq_operations_total');
    const replays = metrics.find((m) => m.name === 'webhook_dlq_replays_total');

    expect(ops?.values ?? []).toHaveLength(0);
    expect(replays?.values ?? []).toHaveLength(0);
  });

  it('is a separate registry from the global default registry', () => {
    // The module exports its own Registry instance; it must not be
    // the singleton global registry used by prom-client by default.
    const { register } = require('prom-client');
    expect(webhookDlqRegistry).not.toBe(register);
  });
});

describe('metric name constants', () => {
  it('exports the expected counter metric names', () => {
    expect(webhookDlqOperationsTotal.name).toBe('webhook_dlq_operations_total');
    expect(webhookDlqReplaysTotal.name).toBe('webhook_dlq_replays_total');
  });

  it('exports counters with the correct help text', () => {
    expect(webhookDlqOperationsTotal.help).toContain('DLQ');
    expect(webhookDlqReplaysTotal.help).toContain('DLQ');
  });

  it('exports counters registered to the isolated registry', () => {
    expect(webhookDlqOperationsTotal.registers).toContain(webhookDlqRegistry);
    expect(webhookDlqReplaysTotal.registers).toContain(webhookDlqRegistry);
  });
});

describe('label cardinality guard', () => {
  beforeEach(() => {
    resetWebhookMetrics();
  });

  it('operations metric never exposes raw URLs in any label', async () => {
    // Even though the type system and Zod schema already prevent this,
    // we assert at the metric-store level that no url-like label exists.
    incrementDlqOperation('enqueue');

    const metrics = await webhookDlqRegistry.getMetricsAsJSON();
    const ops = metrics.find((m) => m.name === 'webhook_dlq_operations_total');
    const values = (ops?.values ?? []) as Array<{
      labels: Record<string, string>;
    }>;

    for (const v of values) {
      for (const [key, val] of Object.entries(v.labels)) {
        expect(key).not.toMatch(/url|path|host|endpoint/i);
        expect(val).not.toMatch(/^https?:\/\//);
      }
    }
  });

  it('replays metric never exposes raw URLs in any label', async () => {
    incrementDlqReplay('success');

    const metrics = await webhookDlqRegistry.getMetricsAsJSON();
    const replays = metrics.find((m) => m.name === 'webhook_dlq_replays_total');
    const values = (replays?.values ?? []) as Array<{
      labels: Record<string, string>;
    }>;

    for (const v of values) {
      for (const [key, val] of Object.entries(v.labels)) {
        expect(key).not.toMatch(/url|path|host|endpoint/i);
        expect(val).not.toMatch(/^https?:\/\//);
      }
    }
  });

  it('operations metric has exactly one label dimension', async () => {
    incrementDlqOperation('enqueue');
    incrementDlqOperation('drop_overflow');

    const labelNames = await getMetricLabelNames('webhook_dlq_operations_total');
    expect(labelNames).toHaveLength(1);
  });

  it('replays metric has exactly one label dimension', async () => {
    incrementDlqReplay('success');
    incrementDlqReplay('failed');

    const labelNames = await getMetricLabelNames('webhook_dlq_replays_total');
    expect(labelNames).toHaveLength(1);
  });
});

function resetWebhookMetrics(): void {
  webhookDlqRegistry.resetMetrics();
}
