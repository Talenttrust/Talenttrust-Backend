# Queue Weighted Fair Scheduling

## Problem

BullMQ's native `priority` option is a strict priority ladder: whenever a
higher-priority job exists, workers take it before any lower-priority job. If a
high-priority stream (for example contract processing) is continuously
replenished, reconciliation, notification, and cleanup work can be starved
**indefinitely** — their jobs wait forever behind a hot priority stream.

This feature adds a **weighted fair scheduler** on top of BullMQ that:

1. guarantees every priority stream receives service proportional to its
   configured weight,
2. isolates tenants from each other so one tenant's flood cannot block others,
3. enforces a **maximum wait bound** — no job waits longer than
   `QUEUE_FAIR_MAX_WAIT_MS` regardless of how hot a higher-priority stream is,
4. exposes every scheduling decision in Prometheus metrics.

Strict FIFO across all job families is explicitly **out of scope**; priority
still matters, it is just bounded and fair.

## Design

### Components

| Component | File | Role |
|---|---|---|
| `FairScheduler` policy | `src/queue/fair-scheduler.ts` | Pure, deterministic ordering policy (no I/O). |
| Scheduling metrics | `src/queue/queue-metrics.ts` | Prometheus counters/gauges for decisions. |
| Rebalance loop | `src/queue/queue-manager.ts` | Applies the policy to waiting BullMQ jobs on a timer. |
| Config | `src/queue/config.ts` | `QUEUE_FAIR_MAX_WAIT_MS`, `QUEUE_FAIR_REBALANCE_INTERVAL_MS`. |

### Weighted fairness

Each priority level carries a weight (service share is proportional to weight):

| Level | Weight | Derived from numeric `priority` |
|---|---|---|
| `critical` | 4 | `1` |
| `high` | 3 | `2` |
| `normal` | 2 | `3` or unset |
| `low` | 1 | `>= 4` |

The policy computes a per-level **occupancy ratio** — `waiting(level) / weight(level)` —
and orders waiting jobs so the level with the largest backlog relative to its
entitlement is served first. This equalizes occupancy and yields exactly
weight-proportional service under continuous load: `critical` (weight 4)
against `low` (weight 1) interleaves roughly 4:1 instead of letting `critical`
run to the end of the queue.

Fairness is enforced **across rebalance passes**: each pass re-orders the
waiting set, so as a level's backlog shrinks below its fair share its remaining
jobs move toward the head on the next pass. The maximum wait bound is the hard
liveness guarantee on top of that.

### Maximum wait bound

Any job waiting longer than `QUEUE_FAIR_MAX_WAIT_MS` (default 5 minutes) is
promoted unconditionally to the front of the line — oldest overdue job first.
This is what converts "starves indefinitely" into "waits at most a bounded
amount", and it also rescues jobs under an adversarial *trickle* (e.g. a single
critical job always present), where occupancy-based fairness alone would keep
preferring the hot stream.

### Per-tenant isolation

`addJob` accepts an optional `tenantId`. Jobs without one share a `default`
tenant bucket. Within a chosen priority level, the tenant with the fewest
waiting jobs is served first, so a tenant flooding a level cannot block other
tenants of that level; within a `(level, tenant)` pair, ordering is FIFO by
enqueue time. The tenant id is stored on the job payload (like
`correlationId`/`requestId`), so isolation is enforced identically on every
worker.

### Worker restart safety

The policy is **stateless**: every ordering decision is a pure function of the
waiting set (`jobId`, `priorityLevel`, `tenantId`, enqueue timestamp) plus
configuration. The rebalance pass reconstructs those inputs from durable
BullMQ/Redis metadata — the enqueue timestamp and the `tenantId`/
`priorityLevel` fields merged into the payload at enqueue time (the derived
level is always persisted, since the rebalance pass rewrites `job.opts.priority`
and the immutable payload field is the stable source of truth). A worker that
restarts computes the same ordering as the worker it replaced; there is no
in-memory service-counter state to lose. Jobs enqueued before this feature
shipped fall back to their original numeric priority (mapped via
`normalizePriority`) on the first pass.

### How the rebalance pass works

On a timer (`QUEUE_FAIR_REBALANCE_INTERVAL_MS`, default 5s) per queue:

1. Fetch up to 1 000 waiting jobs (`Queue.getWaiting` — bounded, so the pass
   stays cheap under pathological backlog).
2. Build `PendingJob` entries from durable metadata and run
   `orderPendingJobs` to get the fair run order.
3. Assign compact BullMQ priorities `0..n-1` in run order via
   `Job.changePriority`, skipping jobs whose priority is already correct.
4. Record metrics (`aged` decisions for wait-bound promotions, `weighted_fair`
   decisions for everything else).

`changePriority` races (e.g. a worker picked the job mid-pass) are caught and
logged as warnings; a failed update never aborts the pass or crashes the
worker. The timer is `unref()`'d and cleared on shutdown.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `QUEUE_FAIR_MAX_WAIT_MS` | `300000` | Hard wait bound in ms (1..86400000). A waiting job past this is promoted to the front. |
| `QUEUE_FAIR_REBALANCE_INTERVAL_MS` | `5000` | How often fair priorities are recomputed (1..3600000). |

Level weights are compile-time constants in `src/queue/fair-scheduler.ts`
(`DEFAULT_FAIR_WEIGHTS`) — documented defaults that are not intended to be
tuned per deployment.

## Enqueue API

```ts
await queueManager.addJob(JobType.EMAIL_NOTIFICATION, payload, {
  priorityLevel: 'high',   // optional; derived from `priority` when omitted
  tenantId: 'tenant-42',   // optional; defaults to 'default'
});
```

The existing numeric `priority` option is unchanged and still honored; when
`priorityLevel` is omitted it is derived from `priority` via
`normalizePriority` (`1` → critical, `2` → high, `3`/unset → normal, `>= 4` →
low). This keeps the API backward compatible.

## Metrics

All families are prefixed `queue_fair_` and registered via
`initializeQueueFairMetrics(registry)` (same pattern as the webhook DLQ
metrics):

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `queue_fair_priority_assigned_total` | Counter | `job_type`, `priority_level` | Enqueues by normalized level. |
| `queue_fair_decisions_total` | Counter | `job_type`, `decision` | Ordering decisions: `aged` (wait bound) or `weighted_fair`. |
| `queue_fair_aged_boosts_total` | Counter | `job_type` | Jobs promoted by the maximum wait bound. |
| `queue_fair_overdue_waiting` | Gauge | `job_type` | Current waiting jobs past the wait bound. |

Alert on `queue_fair_aged_boosts_total` / `queue_fair_overdue_waiting` climbing
sustainedly — that signals a stream is repeatedly hitting the wait bound, which
usually means arrival rate exceeds capacity for a whole level.

## Edge cases

| Case | Behavior |
|---|---|
| Only one priority | Degrades to FIFO by enqueue time within the level (stable for equal timestamps via job-id tie-break). |
| Priority flood | The flooded level steps back once its occupancy exceeds its fair share; other levels are served proportionally. |
| Priority trickle | Occupancy fairness alone prefers the hot stream while it is scarce; the maximum wait bound guarantees the sparse stream still runs. |
| Tenant flood | Sparse tenants of the same level are served before the flooding tenant's backlog. |
| Worker restart | Identical ordering reconstructed from durable job metadata; no in-memory state. |
| Empty queue | Rebalance is a no-op; gauge reports zero overdue; no errors. |
| Retries | A retried job keeps its original enqueue timestamp; if that makes it overdue it is promoted like any other job. |
| `changePriority` failure | Caught and logged; the pass continues and other jobs are still re-prioritized. |

## Operational and security notes

- **Bounded side effects**: at most 1 000 waiting jobs are examined per pass,
  the timer is `unref()`'d, and every per-job failure is isolated. A
  misbehaving queue cannot take the process down.
- **No new trust surface**: the scheduler does not read request input beyond
  the optional `tenantId`/`priorityLevel` fields, which are opaque strings
  stored in the payload. `tenantId` is a logical grouping key, **not** an
  authorization boundary — access control remains the responsibility of the
  API/auth layer, which is unchanged.
- **No secrets in logs**: rebalance failures log sanitized error messages only
  (`error.message`), never payloads, tenant values, or stack traces.
- **Compatibility**: the `addJob` signature, `POST /api/v1/jobs` route, DLQ,
  retry, and dedupe semantics are unchanged; new options are additive.
