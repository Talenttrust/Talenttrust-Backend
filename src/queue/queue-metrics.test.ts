/**
 * Fair Scheduler Metrics — unit tests
 *
 * Verifies metric registration (round-trip against the canonical name list),
 * record helpers, and reset/isolation semantics.
 */

import { Registry } from 'prom-client';
import {
  initializeQueueFairMetrics,
  QUEUE_FAIR_METRIC_NAMES,
  recordAgedBoost,
  recordPriorityAssigned,
  recordSchedulingDecision,
  resetQueueFairMetrics,
  setOverdueWaiting,
} from './queue-metrics';
import { PriorityLevel } from './fair-scheduler';

describe('queue fair scheduler metrics', () => {
  let registry: Registry;

  beforeEach(() => {
    registry = new Registry();
    resetQueueFairMetrics();
  });

  afterEach(() => {
    resetQueueFairMetrics();
  });

  it('registers exactly the canonical metric families', async () => {
    initializeQueueFairMetrics(registry);

    const metrics = await registry.getMetricsAsJSON();
    const names = metrics.map((m) => m.name).sort();
    expect(names).toEqual([...QUEUE_FAIR_METRIC_NAMES].sort());
  });

  it('is idempotent across repeated initialization calls', () => {
    initializeQueueFairMetrics(registry);
    // Second call must not throw (duplicate registration would).
    initializeQueueFairMetrics(registry);
  });

  it('records priority assignments by job type and level', async () => {
    initializeQueueFairMetrics(registry);
    recordPriorityAssigned('email-notification', PriorityLevel.CRITICAL);
    recordPriorityAssigned('email-notification', PriorityLevel.CRITICAL);
    recordPriorityAssigned('email-notification', PriorityLevel.LOW);

    const metrics = await registry.getMetricsAsJSON();
    const counter = metrics.find((m) => m.name === 'queue_fair_priority_assigned_total')!;
    const values = counter.values as { labels: { job_type: string; priority_level: string }; value: number }[];
    expect(values.find((v) => v.labels.job_type === 'email-notification' && v.labels.priority_level === 'critical')?.value).toBe(2);
    expect(values.find((v) => v.labels.job_type === 'email-notification' && v.labels.priority_level === 'low')?.value).toBe(1);
  });

  it('records scheduling decisions by kind', async () => {
    initializeQueueFairMetrics(registry);
    recordSchedulingDecision('contract-processing', 'weighted_fair');
    recordSchedulingDecision('contract-processing', 'aged');
    recordSchedulingDecision('contract-processing', 'aged');

    const metrics = await registry.getMetricsAsJSON();
    const counter = metrics.find((m) => m.name === 'queue_fair_decisions_total')!;
    const values = counter.values as { labels: { decision: string }; value: number }[];
    expect(values.find((v) => v.labels.decision === 'weighted_fair')?.value).toBe(1);
    expect(values.find((v) => v.labels.decision === 'aged')?.value).toBe(2);
  });

  it('records aged boosts and the overdue gauge', async () => {
    initializeQueueFairMetrics(registry);
    recordAgedBoost('blockchain-sync');
    recordAgedBoost('blockchain-sync');
    setOverdueWaiting('blockchain-sync', 3);

    const metrics = await registry.getMetricsAsJSON();
    const boosts = metrics.find((m) => m.name === 'queue_fair_aged_boosts_total')!;
    expect((boosts.values as { value: number }[])[0].value).toBe(2);

    const gauge = metrics.find((m) => m.name === 'queue_fair_overdue_waiting')!;
    expect((gauge.values as { value: number }[])[0].value).toBe(3);
  });

  it('record helpers are no-ops before initialization', async () => {
    // Without initializeQueueFairMetrics, helpers must not throw.
    recordPriorityAssigned('x', PriorityLevel.NORMAL);
    recordSchedulingDecision('x', 'aged');
    recordAgedBoost('x');
    setOverdueWaiting('x', 1);

    const metrics = await registry.getMetricsAsJSON();
    expect(metrics.length).toBe(0);
  });
});
