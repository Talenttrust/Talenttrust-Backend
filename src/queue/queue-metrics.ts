/**
 * Fair Scheduler Metrics
 *
 * Prometheus metrics exposing the scheduling decisions made by the weighted
 * fair scheduler so operators can observe that no priority stream is starving
 * another and that the maximum wait bound is being enforced.
 *
 * Follows the same pattern as `webhook-dlq.ts`: counters/gauges are registered
 * against an injected `Registry` via {@link initializeQueueFairMetrics}, and
 * the record helpers are no-ops until then so `QueueManager` works without a
 * registry attached.
 *
 * Metric families:
 * - `queue_fair_priority_assigned_total{job_type, priority_level}` — enqueues
 *   classified by normalized priority level.
 * - `queue_fair_decisions_total{job_type, decision}` — scheduling decisions
 *   (`aged` = max-wait promotion, `weighted_fair` = fairness policy).
 * - `queue_fair_aged_boosts_total{job_type}` — jobs promoted by the maximum
 *   wait bound (subset of `aged` decisions; kept separate for alerting).
 * - `queue_fair_overdue_waiting{job_type}` — current number of waiting jobs
 *   past the maximum wait bound.
 *
 * @module queue/queue-metrics
 */

import { Counter, Gauge, Registry } from 'prom-client';
import { PriorityLevel, SchedulingDecisionKind } from './fair-scheduler';

/**
 * Canonical metric family names for the fair scheduler. Tests assert the set
 * of registered metrics matches this list exactly (round-trip verification).
 */
export const QUEUE_FAIR_METRIC_NAMES: readonly string[] = [
  'queue_fair_priority_assigned_total',
  'queue_fair_decisions_total',
  'queue_fair_aged_boosts_total',
  'queue_fair_overdue_waiting',
] as const;

let priorityAssignedTotal: Counter<string> | null = null;
let decisionsTotal: Counter<string> | null = null;
let agedBoostsTotal: Counter<string> | null = null;
let overdueWaiting: Gauge<string> | null = null;

/**
 * Register the fair scheduler metrics on the provided registry. Idempotent:
 * calling it more than once (e.g. across tests that share a module cache) is
 * a no-op. Call {@link resetQueueFairMetrics} to re-register against a fresh
 * registry.
 *
 * @param registry - Prometheus registry to register metrics on
 */
export function initializeQueueFairMetrics(registry: Registry): void {
  if (priorityAssignedTotal !== null) {
    return;
  }

  priorityAssignedTotal = new Counter({
    name: 'queue_fair_priority_assigned_total',
    help: 'Total number of jobs enqueued, by normalized priority level.',
    labelNames: ['job_type', 'priority_level'] as const,
    registers: [registry],
  });

  decisionsTotal = new Counter({
    name: 'queue_fair_decisions_total',
    help: 'Total fair-scheduler ordering decisions by kind (aged=wait bound, weighted_fair=policy).',
    labelNames: ['job_type', 'decision'] as const,
    registers: [registry],
  });

  agedBoostsTotal = new Counter({
    name: 'queue_fair_aged_boosts_total',
    help: 'Total number of jobs promoted by the maximum wait bound.',
    labelNames: ['job_type'] as const,
    registers: [registry],
  });

  overdueWaiting = new Gauge({
    name: 'queue_fair_overdue_waiting',
    help: 'Current number of waiting jobs past the maximum wait bound, per job type.',
    labelNames: ['job_type'] as const,
    registers: [registry],
  });
}

/**
 * Drop all registered fair scheduler metrics. Intended for test isolation so a
 * fresh registry can be used without duplicate-registration errors.
 */
export function resetQueueFairMetrics(): void {
  priorityAssignedTotal = null;
  decisionsTotal = null;
  agedBoostsTotal = null;
  overdueWaiting = null;
}

/** Record an enqueue classified by normalized priority level. */
export function recordPriorityAssigned(jobType: string, priorityLevel: PriorityLevel): void {
  priorityAssignedTotal?.inc({ job_type: jobType, priority_level: priorityLevel });
}

/** Record one scheduling decision for a job in a rebalance pass. */
export function recordSchedulingDecision(jobType: string, kind: SchedulingDecisionKind): void {
  decisionsTotal?.inc({ job_type: jobType, decision: kind });
}

/** Record a job promoted by the maximum wait bound. */
export function recordAgedBoost(jobType: string): void {
  agedBoostsTotal?.inc({ job_type: jobType });
}

/** Set the current count of overdue waiting jobs for a queue. */
export function setOverdueWaiting(jobType: string, count: number): void {
  overdueWaiting?.set({ job_type: jobType }, count);
}
