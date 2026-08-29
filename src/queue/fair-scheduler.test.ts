/**
 * Weighted Fair Scheduler — unit tests
 *
 * Pure policy tests (no Redis). Covers every edge case from the issue:
 * only-one-priority, priority flood, tenant flood, worker restart, empty
 * queue, plus the maximum wait bound and weight proportionality.
 */

import {
  DEFAULT_FAIR_SCHEDULER_CONFIG,
  DEFAULT_TENANT_ID,
  FairSchedulerConfig,
  isOverdue,
  normalizePriority,
  orderPendingJobs,
  PriorityLevel,
  PendingJob,
  selectNext,
} from './fair-scheduler';

// Short max-wait bound so aging tests are readable without huge timestamps.
const NOW = 1_000_000;
const MAX_WAIT_MS = 1_000;

function job(
  id: string,
  priorityLevel: PriorityLevel,
  tenantId: string = DEFAULT_TENANT_ID,
  enqueuedAt: number = NOW - 100,
): PendingJob {
  return { jobId: id, priorityLevel, tenantId, enqueuedAt };
}

/** Drain order helper: repeatedly select the head and remove it. */
function drainOrder(backlog: PendingJob[], now = NOW, config?: FairSchedulerConfig): string[] {
  const remaining = [...backlog];
  const order: string[] = [];
  for (let i = 0; i < backlog.length; i += 1) {
    const next = selectNext(remaining, now, config);
    if (!next) {
      break;
    }
    order.push(next.jobId);
    remaining.splice(
      remaining.findIndex((j) => j.jobId === next.jobId),
      1,
    );
  }
  return order;
}

describe('normalizePriority', () => {
  it('maps undefined to NORMAL (default)', () => {
    expect(normalizePriority(undefined)).toBe(PriorityLevel.NORMAL);
  });

  it('maps non-positive and non-finite values to NORMAL', () => {
    expect(normalizePriority(0)).toBe(PriorityLevel.NORMAL);
    expect(normalizePriority(-5)).toBe(PriorityLevel.NORMAL);
    expect(normalizePriority(Number.NaN)).toBe(PriorityLevel.NORMAL);
  });

  it('maps 1 to CRITICAL, 2 to HIGH, 3 to NORMAL, >=4 to LOW', () => {
    expect(normalizePriority(1)).toBe(PriorityLevel.CRITICAL);
    expect(normalizePriority(2)).toBe(PriorityLevel.HIGH);
    expect(normalizePriority(3)).toBe(PriorityLevel.NORMAL);
    expect(normalizePriority(4)).toBe(PriorityLevel.LOW);
    expect(normalizePriority(99)).toBe(PriorityLevel.LOW);
  });
});

describe('edge case: empty queue', () => {
  it('selectNext returns null', () => {
    expect(selectNext([], NOW)).toBeNull();
  });

  it('orderPendingJobs returns an empty ordering with zero overdue', () => {
    const { decisions, overdueCount } = orderPendingJobs([], NOW);
    expect(decisions).toEqual([]);
    expect(overdueCount).toBe(0);
  });
});

describe('edge case: only one priority level', () => {
  it('serves jobs FIFO by enqueue time', () => {
    const backlog = [
      job('c', PriorityLevel.NORMAL, DEFAULT_TENANT_ID, NOW - 300),
      job('a', PriorityLevel.NORMAL, DEFAULT_TENANT_ID, NOW - 100),
      job('b', PriorityLevel.NORMAL, DEFAULT_TENANT_ID, NOW - 200),
    ];
    expect(drainOrder(backlog)).toEqual(['c', 'b', 'a']);
  });

  it('is stable for equal enqueue times (job id tie-break)', () => {
    const backlog = [
      job('b', PriorityLevel.HIGH, DEFAULT_TENANT_ID, NOW - 100),
      job('a', PriorityLevel.HIGH, DEFAULT_TENANT_ID, NOW - 100),
    ];
    expect(drainOrder(backlog)).toEqual(['a', 'b']);
  });

  it('assigns compact priorities 0..n-1 in run order', () => {
    const backlog = [
      job('a', PriorityLevel.LOW, DEFAULT_TENANT_ID, NOW - 200),
      job('b', PriorityLevel.LOW, DEFAULT_TENANT_ID, NOW - 100),
    ];
    const { decisions } = orderPendingJobs(backlog, NOW);
    expect(decisions.map((d) => d.effectivePriority)).toEqual([0, 1]);
    expect(decisions.map((d) => d.jobId)).toEqual(['a', 'b']);
  });
});

describe('edge case: priority flood', () => {
  it('serves the sparse low stream within its weighted share during a critical flood', () => {
    // 8 critical jobs (weight 4 -> ratio 2) vs 1 low job (weight 1 -> ratio 1).
    // Critical is served first while its ratio exceeds the low ratio, but the
    // low job must run before the flood drains (it is never starved).
    const backlog: PendingJob[] = [];
    for (let i = 0; i < 8; i += 1) {
      backlog.push(job(`crit-${i}`, PriorityLevel.CRITICAL, DEFAULT_TENANT_ID, NOW - 100));
    }
    backlog.push(job('low-1', PriorityLevel.LOW, DEFAULT_TENANT_ID, NOW - 50));

    // Fairness is enforced across rebalance passes, so the long-run behavior
    // is the iterative drain: as the critical backlog shrinks below its fair
    // share the low job moves to the head and runs.
    const order = drainOrder(backlog);
    const lowIndex = order.indexOf('low-1');
    // Weight 4:1 => the low job runs after at most ~4 critical jobs (plus the
    // initial tie-break favouring the heavier level), never after the flood.
    expect(lowIndex).toBeGreaterThan(0);
    expect(lowIndex).toBeLessThanOrEqual(5);
    expect(lowIndex).toBeLessThan(8);
  });

  it('serves priority levels proportionally to their weights over a drain', () => {
    // Flood: 40 critical + 10 low. Critical weight 4, low weight 1.
    const backlog: PendingJob[] = [];
    for (let i = 0; i < 40; i += 1) {
      backlog.push(job(`crit-${i}`, PriorityLevel.CRITICAL, DEFAULT_TENANT_ID, NOW - 1000));
    }
    for (let i = 0; i < 10; i += 1) {
      backlog.push(job(`low-${i}`, PriorityLevel.LOW, DEFAULT_TENANT_ID, NOW - 500));
    }

    const order = drainOrder(backlog);
    const lowPositions = order
      .map((id, index) => (id.startsWith('low-') ? index : -1))
      .filter((index) => index >= 0);

    // Low jobs must be interleaved rather than starved until the very end:
    // the first low job must appear before more than ~4x the low share has
    // been served. With 10 low jobs and weight 4:1, expect low jobs spread
    // across the first ~50 slots.
    expect(lowPositions[0]).toBeLessThan(20);
    // Rough proportionality: low gets ~1 of every 5 picks (weight 1 of 5).
    const lowFractionInFirstHalf = lowPositions.filter((p) => p < order.length / 2).length;
    expect(lowFractionInFirstHalf).toBeGreaterThanOrEqual(2);
  });

  it('guarantees the only low-priority job is served once it exceeds the wait bound', () => {
    // Adversarial trickle: exactly one critical job is waiting at all times
    // (ratio 1/4), so weighted fairness alone would keep preferring it. The
    // maximum wait bound is the hard guarantee that the lone low job still
    // runs — it is promoted ahead of everything once overdue.
    const config = { ...DEFAULT_FAIR_SCHEDULER_CONFIG, maxWaitMs: 1_000 };
    const lowEnqueuedAt = NOW - 1_500; // overdue under maxWaitMs=1000
    const backlog: PendingJob[] = [
      job('low-1', PriorityLevel.LOW, DEFAULT_TENANT_ID, lowEnqueuedAt),
      job('crit-0', PriorityLevel.CRITICAL, DEFAULT_TENANT_ID, NOW - 1),
    ];

    const { decisions, overdueCount } = orderPendingJobs(backlog, NOW, config);
    expect(overdueCount).toBe(1);
    expect(decisions[0].jobId).toBe('low-1');
    expect(decisions[0].kind).toBe('aged');
    expect(decisions[0].effectivePriority).toBe(0);
  });
});

describe('edge case: tenant flood', () => {
  it('keeps other tenants of the same level from being starved by a flood', () => {
    // Tenant A floods the HIGH level; tenants B and C have one job each.
    const backlog: PendingJob[] = [];
    for (let i = 0; i < 10; i += 1) {
      backlog.push(job(`a-${i}`, PriorityLevel.HIGH, 'tenant-a', NOW - 100));
    }
    backlog.push(job('b-1', PriorityLevel.HIGH, 'tenant-b', NOW - 50));
    backlog.push(job('c-1', PriorityLevel.HIGH, 'tenant-c', NOW - 50));

    const order = drainOrder(backlog);
    // Both sparse tenants run before tenant-a's flood is drained.
    expect(order.indexOf('b-1')).toBeLessThan(order.indexOf('a-9'));
    expect(order.indexOf('c-1')).toBeLessThan(order.indexOf('a-9'));
    // And both run within the first few picks.
    expect(order.indexOf('b-1')).toBeLessThan(3);
    expect(order.indexOf('c-1')).toBeLessThan(3);
  });

  it('falls back to FIFO within a (level, tenant) bucket', () => {
    const backlog = [
      job('a-2', PriorityLevel.NORMAL, 'tenant-a', NOW - 200),
      job('a-1', PriorityLevel.NORMAL, 'tenant-a', NOW - 100),
    ];
    expect(drainOrder(backlog)).toEqual(['a-2', 'a-1']);
  });

  it('treats jobs without a tenant as one shared default bucket', () => {
    const backlog = [
      job('no-tenant-2', PriorityLevel.NORMAL, DEFAULT_TENANT_ID, NOW - 200),
      job('no-tenant-1', PriorityLevel.NORMAL, DEFAULT_TENANT_ID, NOW - 100),
    ];
    const { decisions } = orderPendingJobs(backlog, NOW);
    expect(decisions[0].tenantId).toBe(DEFAULT_TENANT_ID);
    expect(decisions[0].jobId).toBe('no-tenant-2');
  });
});

describe('edge case: worker restart', () => {
  it('produces identical ordering from durable metadata on a fresh scheduler', () => {
    // Worker "A" computes an ordering; worker "B" restarts and computes the
    // ordering again from the same durable inputs. It must match exactly —
    // no in-memory state may influence the result.
    const backlog = [
      job('crit-1', PriorityLevel.CRITICAL, 'tenant-x', NOW - 900),
      job('norm-1', PriorityLevel.NORMAL, 'tenant-y', NOW - 700),
      job('crit-2', PriorityLevel.CRITICAL, 'tenant-x', NOW - 800),
      job('low-1', PriorityLevel.LOW, DEFAULT_TENANT_ID, NOW - 500),
      job('high-1', PriorityLevel.HIGH, 'tenant-z', NOW - 600),
    ];

    const first = orderPendingJobs(backlog, NOW);
    // Simulated restart: a brand-new call with identical inputs.
    const second = orderPendingJobs(backlog, NOW);

    expect(second.decisions.map((d) => d.jobId)).toEqual(first.decisions.map((d) => d.jobId));
    expect(second.decisions.map((d) => d.effectivePriority)).toEqual(
      first.decisions.map((d) => d.effectivePriority),
    );
    expect(second.decisions.map((d) => d.kind)).toEqual(first.decisions.map((d) => d.kind));
  });
});

describe('maximum wait bound', () => {
  it('promotes an overdue low-priority job ahead of fresh high-priority jobs', () => {
    const now = NOW;
    const config = { ...DEFAULT_FAIR_SCHEDULER_CONFIG, maxWaitMs: MAX_WAIT_MS };
    const backlog = [
      job('high-1', PriorityLevel.CRITICAL, DEFAULT_TENANT_ID, now - 10),
      job('stale-low', PriorityLevel.LOW, DEFAULT_TENANT_ID, now - MAX_WAIT_MS - 1),
    ];

    const { decisions, overdueCount } = orderPendingJobs(backlog, now, config);
    expect(overdueCount).toBe(1);
    expect(decisions[0].jobId).toBe('stale-low');
    expect(decisions[0].kind).toBe('aged');
    expect(decisions[0].effectivePriority).toBe(0);
  });

  it('serves multiple overdue jobs oldest-first', () => {
    const now = NOW;
    const config = { ...DEFAULT_FAIR_SCHEDULER_CONFIG, maxWaitMs: MAX_WAIT_MS };
    const backlog = [
      job('overdue-b', PriorityLevel.CRITICAL, DEFAULT_TENANT_ID, now - MAX_WAIT_MS - 200),
      job('overdue-a', PriorityLevel.LOW, DEFAULT_TENANT_ID, now - MAX_WAIT_MS - 500),
      job('fresh', PriorityLevel.CRITICAL, DEFAULT_TENANT_ID, now - 10),
    ];

    const order = drainOrder(backlog, now, config);
    expect(order.slice(0, 2)).toEqual(['overdue-a', 'overdue-b']);
  });

  it('does not promote jobs below the bound', () => {
    const now = NOW;
    const config = { ...DEFAULT_FAIR_SCHEDULER_CONFIG, maxWaitMs: MAX_WAIT_MS };
    const justUnder = job('ok', PriorityLevel.LOW, DEFAULT_TENANT_ID, now - MAX_WAIT_MS + 1);
    expect(isOverdue(justUnder, now, config)).toBe(false);
    expect(isOverdue({ ...justUnder, enqueuedAt: now - MAX_WAIT_MS }, now, config)).toBe(true);
  });
});

describe('decisions and priorities', () => {
  it('marks every non-overdue job as weighted_fair', () => {
    const backlog = [
      job('a', PriorityLevel.HIGH, DEFAULT_TENANT_ID, NOW - 100),
      job('b', PriorityLevel.NORMAL, DEFAULT_TENANT_ID, NOW - 50),
    ];
    const { decisions } = orderPendingJobs(backlog, NOW);
    expect(decisions.every((d) => d.kind === 'weighted_fair')).toBe(true);
    expect(decisions.every((d) => d.waitMs >= 0)).toBe(true);
  });

  it('never assigns duplicate priorities and always starts at 0', () => {
    const backlog = [
      job('a', PriorityLevel.CRITICAL, 't1', NOW - 100),
      job('b', PriorityLevel.LOW, 't2', NOW - 50),
      job('c', PriorityLevel.NORMAL, 't3', NOW - 10),
    ];
    const { decisions } = orderPendingJobs(backlog, NOW);
    const priorities = decisions.map((d) => d.effectivePriority);
    expect(priorities[0]).toBe(0);
    expect(new Set(priorities).size).toBe(priorities.length);
  });

  it('weight order wins when occupancy ratios tie', () => {
    // critical: 4 jobs / weight 4 = 1.0 ; low: 1 job / weight 1 = 1.0
    const backlog = [
      job('low-1', PriorityLevel.LOW, DEFAULT_TENANT_ID, NOW - 10),
      job('crit-1', PriorityLevel.CRITICAL, DEFAULT_TENANT_ID, NOW - 100),
      job('crit-2', PriorityLevel.CRITICAL, DEFAULT_TENANT_ID, NOW - 90),
      job('crit-3', PriorityLevel.CRITICAL, DEFAULT_TENANT_ID, NOW - 80),
      job('crit-4', PriorityLevel.CRITICAL, DEFAULT_TENANT_ID, NOW - 70),
    ];
    const { decisions } = orderPendingJobs(backlog, NOW);
    // Heavier (critical) level is served first on a ratio tie.
    expect(decisions[0].jobId).toBe('crit-1');
  });
});
