# Reputation Operations Runbook

This runbook is for operators diagnosing reputation API and score recomputation
problems in TalentTrust Backend. It reflects the current implementation, including
the places where recovery still requires an application maintenance action.

## Architecture

| Component | Path | Responsibility |
|---|---|---|
| HTTP routes | `src/routes/reputation.routes.ts` | Authenticates requests and enforces `reviews.read` or `reviews.create` permissions |
| Controller | `src/controllers/reputation.controller.ts` | Maps service and validation failures to HTTP responses |
| Reputation service | `src/services/reputation.service.ts` | Applies rating rules, calculates scores, persists ratings, and writes audit events |
| Repository | `src/repositories/reputationRepository.ts` | Reads and writes `reputation_entries` in SQLite |
| Recompute processor | `src/queue/processors/reputation-recompute-processor.ts` | Recomputes profiles in pages and isolates failures by subject |
| Queue manager | `src/queue/queue-manager.ts` | Runs BullMQ workers, retries jobs, and exposes queue health |
| Scheduler service | `src/services/reputation-scheduler.service.ts` | Can enqueue periodic or manual recomputes |
| Checkpoint store | `src/models/reputation-checkpoint.store.ts` | Tracks recompute progress in process memory |
| Profile store | `src/models/reputation.store.ts` | Holds recomputed profiles in process memory |
| Audit service | `src/audit/service.ts` | Records `REPUTATION_UPDATED` after a rating is stored |

The API is mounted at `/api/v1/reputation` in `src/app.ts`.

| Method | Path | Permission | Purpose |
|---|---|---|---|
| `GET` | `/api/v1/reputation/:id` | `reviews.read` | Return the current reputation profile |
| `PUT` | `/api/v1/reputation/:id` | `reviews.create` | Validate and submit a review |

The current router serves the write operation as `PUT`. Do not use the
`POST /:id/rate` path described by older API documentation unless the router is
changed to mount it.

## Configuration

### Reputation scoring

| Variable | Default | Validation | Effect |
|---|---:|---|---|
| `REPUTATION_DECAY_LAMBDA` | `0.005` | Number greater than 0 and at most 1 | Controls how quickly old ratings lose weight |
| `REPUTATION_SCORE_ALGORITHM_VERSION` | `exp-decay-v1` | Non-empty string | Identifies the algorithm in API responses |

Invalid scoring configuration is caught by `validateEnv()`. During profile reads,
the reputation service falls back to the defaults above if full environment
validation fails. Treat repeated fallback behavior as a configuration defect
rather than an acceptable production state.

### Persistence and queues

| Variable | Default | Effect |
|---|---:|---|
| `DB_PATH` | `talenttrust.db` | SQLite file containing `reputation_entries` |
| `REDIS_HOST` | `localhost` | BullMQ Redis host |
| `REDIS_PORT` | `6379` | BullMQ Redis port |
| `REDIS_PASSWORD` | unset | Redis password; treat as a secret |
| `QUEUE_CONCURRENCY` | `5` | Worker concurrency shared by queue types |
| `QUEUE_JOB_TIMEOUT_MS` | `30000` | Default job attempt timeout in milliseconds |
| `QUEUE_JOB_TIMEOUT_REPUTATION_UPDATE_MS` | default timeout | Timeout override for reputation update jobs |
| `QUEUE_JOB_TIMEOUT_REPUTATION_RECOMPUTE_MS` | default timeout | Timeout override for reputation recompute jobs |

Retry policies are defined in `src/queue/retry-policy.ts`:

| Queue | Attempts | Backoff |
|---|---:|---|
| `reputation-update` | 2 | Fixed, 5 seconds |
| `reputation-recompute` | 3 | Exponential, starting at 2 seconds |

`RETRY_POLICY_REPUTATION_UPDATE_*` and
`RETRY_POLICY_REPUTATION_RECOMPUTE_*` environment overrides are supported by the
shared retry-policy loader. See `docs/configuration.md` before changing them.

## Normal Operation

### Rating write

1. Authentication and `reviews.create` authorization run before the controller.
2. The payload is validated.
3. The service rejects self-ratings, duplicate ratings, non-participants, and
   invalid comments.
4. The repository inserts one row into `reputation_entries`.
5. The audit service writes a `REPUTATION_UPDATED` event.

The database enforces one rating for each
`reviewer_id + target_id + context_id` combination.

### Profile read

`ReputationService.getProfile()` reads all ratings for the target and returns both
an arithmetic score and a recency-weighted score. The weighted score uses
`REPUTATION_DECAY_LAMBDA`.

### Recompute job

The `reputation-recompute` processor:

1. Pages through distinct `target_id` values, 100 at a time by default.
2. Calls `ReputationService.getProfile()` for each target.
3. Skips profiles updated within 24 hours unless `forceRecompute` is true.
4. Writes computed profiles to the in-memory reputation store.
5. Updates the in-memory checkpoint after each successful target.
6. Logs and skips an individual target when its recompute fails.

Important limitations:

- `ReputationSchedulerService` defaults to a daily interval, but `src/app.ts`
  does not currently start it. Do not assume daily jobs are running merely
  because the service exists.
- Checkpoints and recomputed profiles use in-memory `Map` stores. They do not
  survive a process restart.

## Monitoring and Alerts

### Queue health

An admin can inspect all initialized queues and recent failures:

```http
GET /api/v1/admin/queue-health
Authorization: Bearer <admin-token>
```

For `reputation-update` and `reputation-recompute`, inspect:

- `isInitialized`: the queue and worker were created;
- `waiting` and `delayed`: backlog or repeated retries;
- `active`: work currently running;
- `failed`: jobs retained after exhausting retries;
- `paused`: worker is not processing work;
- `failures`: recent sanitized failure reasons.

### Logs

Logs are structured JSON. Search on these stable fields and messages:

| Signal | Meaning |
|---|---|
| `processor="reputation"` | Reputation update processor activity |
| `processor="reputation-recompute"` | Bulk recompute activity |
| `Failed to start reputation scheduler` | Redis or queue initialization failed |
| `Failed to schedule reputation recompute job` | A recompute was not enqueued |
| `Failed to recompute reputation for subject; skipping` | One target was omitted from the run |
| `Audit logging failed` | The rating row may exist without its audit record |
| `Reputation recompute job completed` | A batch finished; inspect `totalProcessed` |

There are no dedicated reputation Prometheus counters or gauges in the current
source. Use the admin queue-health endpoint, structured logs, audit records, and
generic HTTP metrics.

### Suggested alerts

| Condition | Severity | Response |
|---|---|---|
| Any retained failed `reputation-update` job | Warning | Inspect validation and Redis errors before replaying |
| Any retained failed `reputation-recompute` job | Warning | Check the failure reason and whether a full recompute is required |
| Queue is uninitialized or paused in a service expected to process reputation jobs | Critical | Restore Redis connectivity and restart the worker |
| Repeated per-subject recompute warnings | Warning | Identify affected target IDs and repair the underlying data |
| Any audit logging failure | Critical | Reconcile the rating row and audit trail before accepting another write |
| Recompute has no successful completion within the intended schedule | Warning | Verify a scheduler or external trigger is actually configured |

## Failure Modes and Recovery

### Reputation request returns 401 or 403

**Likely cause:** missing/invalid JWT, missing role permission, self-rating, or a
reviewer/target that is not part of the referenced contract.

**Recovery:**

1. Use the request ID from the response to find the request log.
2. Verify the caller has `reviews.read` or `reviews.create` as appropriate.
3. Verify both users belong to the referenced contract.
4. Do not bypass the participation or self-rating guards.

### Reputation request returns 400 or 422

**Likely cause:** malformed payload, rating outside integer range 1-5, missing
identifier, or an invalid comment.

**Recovery:** correct the request. Retrying the same payload will not help.

### Reputation request returns 409

**Likely cause:** the reviewer already rated this target for this context.

**Recovery:** fetch or query the existing row. Ratings are immutable; do not
delete one merely to make a retry succeed.

### Reputation request returns 500 during audit logging

**Symptom:** logs contain `Audit logging failed`.

**Risk:** the repository insert happens before the audit write. The API error
message says the rating was not persisted, but the SQLite row may already exist.

**Recovery:**

1. Stop automatic client retries for the affected request.
2. Query `reputation_entries` using reviewer, target, and context IDs.
3. Check the audit store for the corresponding `REPUTATION_UPDATED` event.
4. If the rating exists without an audit event, follow the audit reconciliation
   procedure rather than submitting the rating again.
5. Restore the audit backend and verify it with a controlled write.

### Queue is uninitialized, paused, or cannot reach Redis

**Recovery:**

1. Check `/api/v1/admin/queue-health`.
2. Verify `REDIS_HOST`, `REDIS_PORT`, and secret injection for `REDIS_PASSWORD`.
3. Confirm Redis is reachable from the application environment.
4. Restart the worker after connectivity is restored.
5. Confirm both reputation queues report `isInitialized: true` before enqueuing
   more work.

### Recompute job exhausted retries

**Recovery:**

1. Read the retained failure reason from queue health or worker logs.
2. Correct Redis, database, timeout, or data problems first.
3. Re-enqueue a `REPUTATION_RECOMPUTE` job through approved maintenance tooling.
   There is currently no public HTTP endpoint for this action.
4. Use `forceRecompute: true` when the goal is to rebuild all profiles.
5. Monitor for a completion log and compare `totalProcessed` with the expected
   number of distinct reputation targets.

### Some targets were skipped during recompute

**Symptom:** `Failed to recompute reputation for subject; skipping` warnings.

**Recovery:**

1. Collect the affected target IDs from correlated logs.
2. Verify their rating timestamps and related rows are readable.
3. Repair the data or configuration error.
4. Run a forced recompute and confirm the warning does not recur.

### Application restarted during recompute

The checkpoint and profile stores are in memory, so restart recovery cannot rely
on the previous checkpoint.

**Recovery:** enqueue a new forced recompute from the beginning. Do not claim the
old run resumed unless the checkpoint implementation has first been replaced by
durable storage.

### Scores changed unexpectedly after configuration change

**Recovery:**

1. Verify the deployed `REPUTATION_DECAY_LAMBDA` and algorithm version.
2. Compare a small sample against the formula in
   `docs/reputation-scoring.md`.
3. Restore the previous configuration if the change was accidental.
4. Run a forced recompute after configuration is stable.

## Verification Checklist

After recovery:

- `GET /api/v1/reputation/:id` returns the expected score for a known target.
- Authorization still rejects an unauthorized write.
- `/api/v1/admin/queue-health` shows initialized, unpaused reputation queues.
- No new reputation queue failures appear.
- A controlled rating produces one database row and one
  `REPUTATION_UPDATED` audit event.
- A recompute emits a completion log with the expected processed count.

## Related Documentation

- [Reputation system](backend/reputation-system.md)
- [Reputation scoring](reputation-scoring.md)
- [Queue processors](queue-processors.md)
- [Queue configuration](configuration.md)
- [Audit log](audit.md)
- [Environment variables](backend/environment-variables.md)
- [Structured logging](backend/structured-logging.md)

