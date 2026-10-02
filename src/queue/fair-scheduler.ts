/**
 * Weighted Fair Scheduler
 *
 * Pure, deterministic scheduling policy that prevents a high-priority job
 * stream from starving reconciliation, notification, or cleanup work. The
 * policy is *stateless*: every ordering decision is derived solely from the
 * current set of pending jobs plus the configuration, so a worker restart
 * loses nothing — fairness is reconstructed from durable job metadata
 * (enqueue timestamp, priority level, tenant id) the next time the policy is
 * evaluated.
 *
 * ## Model
 *
 * ### Weighted fairness
 * Each {@link PriorityLevel} carries a weight. A level's "fair share" of
 * service is proportional to its weight. The policy computes a per-level
 * *occupancy ratio* — `waiting(level) / weight(level)` — and serves the level
 * with the largest ratio first. A level that has accumulated the most backlog
 * relative to its entitlement is the one that has been served least, so
 * serving it equalizes backlogs and yields exactly weight-proportional service
 * (e.g. CRITICAL weight 4 vs LOW weight 1 interleaves ~4:1 under continuous
 * load). This is an occupancy-based approximation of weighted fair queuing
 * (WFQ) that needs no in-memory service counters.
 *
 * ### Per-tenant isolation
 * Within the chosen level, tenants are served by fewest-waiting-first, so one
 * tenant flooding a priority level cannot block other tenants of that level.
 * Jobs without a tenant are grouped under {@link DEFAULT_TENANT_ID}.
 *
 * ### Maximum wait bound
 * Any job that has waited longer than `maxWaitMs` is promoted unconditionally
 * to the front of the line (oldest overdue job first). This is the hard
 * anti-starvation guarantee: no job waits indefinitely, regardless of how hot
 * a higher-priority stream is.
 *
 * ### Only one priority / empty queue
 * With a single priority level the policy degrades to FIFO by enqueue time.
 * An empty backlog yields an empty ordering and never throws.
 *
 * @module queue/fair-scheduler
 */

/**
 * Bounded set of priority levels. Lower is more urgent, matching BullMQ's
 * convention where a smaller `priority` number runs first.
 */
export enum PriorityLevel {
  CRITICAL = 'critical',
  HIGH = 'high',
  NORMAL = 'normal',
  LOW = 'low',
}

/**
 * Canonical level order from most to least urgent. Used for deterministic
 * tie-breaking so ordering is stable across worker restarts.
 */
export const PRIORITY_LEVEL_ORDER: readonly PriorityLevel[] = [
  PriorityLevel.CRITICAL,
  PriorityLevel.HIGH,
  PriorityLevel.NORMAL,
  PriorityLevel.LOW,
];

/**
 * Default weight per priority level. Service share is proportional to weight:
 * CRITICAL is served about 4x as often as LOW when both have continuous work.
 */
export const DEFAULT_FAIR_WEIGHTS: Record<PriorityLevel, number> = {
  [PriorityLevel.CRITICAL]: 4,
  [PriorityLevel.HIGH]: 3,
  [PriorityLevel.NORMAL]: 2,
  [PriorityLevel.LOW]: 1,
};

/**
 * Default maximum time a job may wait before the scheduler promotes it to the
 * front of the queue (hard anti-starvation bound). 5 minutes.
 */
export const DEFAULT_MAX_WAIT_MS = 5 * 60 * 1000;

/** Tenant id assigned to jobs enqueued without an explicit tenant. */
export const DEFAULT_TENANT_ID = 'default';

export interface FairSchedulerConfig {
  /** Weight per priority level; service share is proportional to these. */
  weights: Record<PriorityLevel, number>;
  /**
   * Maximum wait bound in milliseconds. A job waiting at least this long is
   * unconditionally promoted ahead of all non-overdue jobs.
   */
  maxWaitMs: number;
}

export const DEFAULT_FAIR_SCHEDULER_CONFIG: FairSchedulerConfig = {
  weights: DEFAULT_FAIR_WEIGHTS,
  maxWaitMs: DEFAULT_MAX_WAIT_MS,
};

/**
 * A single pending job as seen by the scheduler. All fields are meant to be
 * reconstructable from durable queue metadata so scheduling survives restarts.
 */
export interface PendingJob {
  jobId: string;
  priorityLevel: PriorityLevel;
  tenantId: string;
  /** Epoch milliseconds when the job was first enqueued. */
  enqueuedAt: number;
}

/**
 * Why a job was placed where it was. Exposed in metrics so operators can see
 * scheduling decisions (`aged` = max-wait promotion, `weighted_fair` = the
 * fairness policy).
 */
export type SchedulingDecisionKind = 'aged' | 'weighted_fair';

export interface SchedulingDecision {
  jobId: string;
  priorityLevel: PriorityLevel;
  tenantId: string;
  /** Milliseconds the job has waited so far. */
  waitMs: number;
  kind: SchedulingDecisionKind;
  /**
   * BullMQ-compatible priority for this job. Lower runs first. Priorities are
   * compact integers `0..n-1` in run order, so applying them to the waiting
   * set makes BullMQ drain exactly in scheduler order.
   */
  effectivePriority: number;
}

export interface FairOrdering {
  /** Decisions in run order (index 0 runs first). */
  decisions: SchedulingDecision[];
  /** Number of jobs promoted by the maximum-wait bound in this ordering. */
  overdueCount: number;
}

/**
 * Map the existing numeric `priority` API (BullMQ convention: lower = more
 * urgent) to a bounded {@link PriorityLevel}. `undefined`/absent maps to
 * NORMAL so callers that never set a priority get default weight fairness.
 *
 * @param priority - numeric priority, or undefined when not set
 */
export function normalizePriority(priority: number | undefined): PriorityLevel {
  if (priority === undefined || !Number.isFinite(priority) || priority <= 0) {
    return PriorityLevel.NORMAL;
  }
  if (priority <= 1) {
    return PriorityLevel.CRITICAL;
  }
  if (priority <= 2) {
    return PriorityLevel.HIGH;
  }
  if (priority <= 3) {
    return PriorityLevel.NORMAL;
  }
  return PriorityLevel.LOW;
}

/**
 * True when the job has waited at least `maxWaitMs` and must be promoted.
 */
export function isOverdue(
  job: Pick<PendingJob, 'enqueuedAt'>,
  now: number,
  config: FairSchedulerConfig = DEFAULT_FAIR_SCHEDULER_CONFIG,
): boolean {
  return now - job.enqueuedAt >= config.maxWaitMs;
}

/**
 * Compute the full run order for a set of pending jobs.
 *
 * Ordering rules (lexicographic):
 * 1. Overdue jobs first (oldest first) — maximum wait bound.
 * 2. Non-overdue jobs by descending level occupancy ratio (`count / weight`)
 *    — the level with the largest backlog relative to its weight is served
 *    first, which produces weighted-proportional service.
 * 3. Ratio ties: higher weight first, then {@link PRIORITY_LEVEL_ORDER}.
 * 4. Same level: tenant with fewest waiting jobs in that level first
 *    (per-tenant isolation — a flooding tenant cannot block sparse tenants).
 * 5. Same tenant: FIFO by enqueue time, then job id for full determinism.
 *
 * The result is a pure function of `backlog`, `now`, and `config` — identical
 * input produces identical output on any worker, which is what makes
 * scheduling survive worker restarts.
 *
 * @param backlog - pending jobs; may be empty
 * @param now - current epoch milliseconds (injectable for deterministic tests)
 * @param config - weights and maximum wait bound
 */
export function orderPendingJobs(
  backlog: readonly PendingJob[],
  now: number,
  config: FairSchedulerConfig = DEFAULT_FAIR_SCHEDULER_CONFIG,
): FairOrdering {
  const decisions: SchedulingDecision[] = [];

  if (backlog.length === 0) {
    return { decisions, overdueCount: 0 };
  }

  const sorted = [...backlog].sort((a, b) => comparePendingJobs(a, b, backlog, now, config));

  for (let index = 0; index < sorted.length; index += 1) {
    const job = sorted[index];
    const waitMs = Math.max(0, now - job.enqueuedAt);
    decisions.push({
      jobId: job.jobId,
      priorityLevel: job.priorityLevel,
      tenantId: job.tenantId,
      waitMs,
      kind: isOverdue(job, now, config) ? 'aged' : 'weighted_fair',
      effectivePriority: index,
    });
  }

  const overdueCount = decisions.filter((d) => d.kind === 'aged').length;
  return { decisions, overdueCount };
}

/**
 * Convenience wrapper returning the single next job to run (or null when the
 * backlog is empty). Used by callers that need just the head of the order.
 */
export function selectNext(
  backlog: readonly PendingJob[],
  now: number,
  config: FairSchedulerConfig = DEFAULT_FAIR_SCHEDULER_CONFIG,
): SchedulingDecision | null {
  const { decisions } = orderPendingJobs(backlog, now, config);
  return decisions.length > 0 ? decisions[0] : null;
}

/**
 * Comparator implementing the ordering rules of {@link orderPendingJobs}.
 */
function comparePendingJobs(
  a: PendingJob,
  b: PendingJob,
  backlog: readonly PendingJob[],
  now: number,
  config: FairSchedulerConfig,
): number {
  const aOverdue = isOverdue(a, now, config);
  const bOverdue = isOverdue(b, now, config);

  if (aOverdue !== bOverdue) {
    return aOverdue ? -1 : 1;
  }
  if (aOverdue && bOverdue) {
    return compareByEnqueuedAt(a, b);
  }

  // Weighted fairness: serve the level with the largest backlog relative to
  // its weight first. This equalizes occupancy ratios and yields service
  // proportional to weight under continuous load.
  const ratioDiff = levelRatio(b.priorityLevel, backlog, config) - levelRatio(a.priorityLevel, backlog, config);
  if (ratioDiff !== 0) {
    return ratioDiff;
  }

  // Tie-break ratio ties by weight (heavier level wins) then canonical order.
  const weightDiff = config.weights[b.priorityLevel] - config.weights[a.priorityLevel];
  if (weightDiff !== 0) {
    return weightDiff;
  }
  const orderDiff = PRIORITY_LEVEL_ORDER.indexOf(a.priorityLevel) - PRIORITY_LEVEL_ORDER.indexOf(b.priorityLevel);
  if (orderDiff !== 0) {
    return orderDiff;
  }

  // Same level: per-tenant isolation — serve the tenant with the fewest
  // waiting jobs in this level first, so a tenant flood cannot block others.
  const tenantDiff = tenantCountInLevel(a, backlog) - tenantCountInLevel(b, backlog);
  if (tenantDiff !== 0) {
    return tenantDiff;
  }

  // FIFO within (level, tenant), then stable job id ordering.
  return compareByEnqueuedAt(a, b);
}

function compareByEnqueuedAt(a: PendingJob, b: PendingJob): number {
  if (a.enqueuedAt !== b.enqueuedAt) {
    return a.enqueuedAt - b.enqueuedAt;
  }
  if (a.jobId < b.jobId) {
    return -1;
  }
  if (a.jobId > b.jobId) {
    return 1;
  }
  return 0;
}

/**
 * Occupancy ratio for a level: waiting count divided by weight. A higher ratio
 * means the level is ahead of its fair share and should step back.
 */
function levelRatio(
  level: PriorityLevel,
  backlog: readonly PendingJob[],
  config: FairSchedulerConfig,
): number {
  const weight = config.weights[level] ?? 1;
  let count = 0;
  for (const job of backlog) {
    if (job.priorityLevel === level) {
      count += 1;
    }
  }
  return count / weight;
}

/**
 * Number of pending jobs belonging to the same (level, tenant) pair as the
 * reference job. Used to enforce per-tenant isolation within a level.
 */
function tenantCountInLevel(job: PendingJob, backlog: readonly PendingJob[]): number {
  let count = 0;
  for (const other of backlog) {
    if (other.priorityLevel === job.priorityLevel && other.tenantId === job.tenantId) {
      count += 1;
    }
  }
  return count;
}
