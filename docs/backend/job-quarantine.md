# Job Quarantine

## Problem

A permanently-invalid job (for example a contract job whose `contractId` is too
short, or an email job whose payload is malformed) can never succeed. Before
this feature, BullMQ retried it through the entire configured retry budget
(`attempts`) with backoff. Under concurrency pressure a single poison job
consumes retries, backoff delay, and a worker slot — stalling unrelated,
healthy work that is waiting for that slot.

## Design

Terminal failures are classified and **moved to quarantine** instead of being
retried to exhaustion. A quarantined job no longer occupies a worker slot and
no longer burns retry budget, so unrelated work proceeds.

### Components

| Component | File | Role |
|---|---|---|
| Error classifier | `src/queue/queue-errors.ts` | Marks failures terminal vs transient. |
| Quarantine store | `src/queue/job-quarantine.ts` | Durable SQLite store + metrics + instance. |
| Wiring | `src/queue/queue-manager.ts` | Classifies in `processJob`, quarantines, replays. |
| HTTP API | `src/index.ts` | `GET/POST /api/v1/jobs/quarantine*` (admin). |

### Terminal vs transient

- A processor signals a permanent failure by throwing a `TerminalJobError`
  (or subclass such as `InvalidJobPayloadError` or `StaleJobReferenceError`).
- Everything else — timeouts, upstream 5xx, temporary chain inconsistency —
  is **transient** and continues to use the normal BullMQ retry policy.
- The classifier (`classifyFailure`) treats any `TerminalJobError` as terminal
  and everything else as transient, so the retry behaviour of existing jobs is
  unchanged unless a processor explicitly opts in by throwing a terminal error.

### No silent deletion

Quarantined entries are **never silently deleted** by the worker. An entry is
only removed by an explicit admin replay that re-enqueues the original job.
Capacity overflow evicts the oldest *pending* (not-yet-replayed) entry,
mirroring the webhook DLQ policy.

### Redaction

The persisted payload is passed through `redactPayload` and the persisted
reason through the safe-error sanitizer (`sanitizeErrorMessage`) before they
are stored, so quarantine records never contain secrets, credentials, stack
traces, or internal paths.

### Tenant isolation

Every entry records its `tenantId` (defaulting to the `default` tenant, the
same constant used by the fair scheduler). Replay preserves the tenant so a
re-enqueued job stays within its tenant. `GET /api/v1/jobs/quarantine` accepts
an optional `tenantId` filter.

## HTTP API

All endpoints require admin authentication (`authMiddleware` +
`requireRole('admin')`) and write an audit entry.

- `GET /api/v1/jobs/quarantine?type=&tenantId=&limit=&offset=` — inspect
  quarantined jobs. Returns `{ entries, limit, offset, count }`.
- `POST /api/v1/jobs/quarantine/replay` with `{ quarantineId, reason }` —
  re-enqueue a quarantined job after a fix. The `reason` (min 5 chars) is
  recorded in the audit log. Replay is idempotent: a second call with the same
  `quarantineId` returns `deduplicated: true`.

## Operational notes

- Quarantine storage failures are logged and reported; they never crash the
  worker, and the job is still marked failed (never silently deleted).
- `JOB_QUARANTINE_PATH` (default `<cwd>/data/job-quarantine.db`) controls the
  on-disk location; under `NODE_ENV=test` an in-memory store is used per call.
- Metrics: `job_quarantine_operations_total` (`enqueue`, `drop_overflow`,
  `replay_attempt`).

## Out of scope

Silent deletion of quarantined jobs is intentionally out of scope — an entry
is only retired through explicit replay or capacity eviction of pending
entries.