---
title: "Add exponential backoff with jitter to WebhookDeliveryService retry path"
labels: ["type:feature", "area:webhooks", "stack:typescript", "priority:high"]
type: Task
---

## Description

`WebhookDeliveryService.deliver` in `src/webhookDelivery.ts` currently performs a single delivery attempt and records the outcome via `webhookMetrics.ts`. Failed deliveries should be retried with bounded exponential backoff and jitter before being handed to the DLQ. This reduces spurious DLQ entries for transient downstream outages on partner webhook endpoints.

## Requirements and context

- Implement configurable retry policy (max attempts, base delay, max delay, jitter) read from env and validated at startup.
- Retries must preserve the HMAC signature semantics and not re-sign with a stale timestamp without bumping `webhookMetrics` retry counters.
- Only retry on transient classes (5xx, ECONNRESET, ETIMEDOUT); never retry 4xx signature/validation rejections.
- Emit a `webhook_delivery_retries_total{provider,reason}` metric and document env vars in `docs/webhook-signature-verification.md`.
- Acceptance: exhausting retries enqueues to `src/api/jobs.ts` DLQ exactly once; unit tests assert backoff schedule and no-retry on 4xx.

## Suggested execution

- Fork the repo and create a branch:
  - `git checkout -b feature/webhook-retry-backoff`
- Implement changes:
  - `src/webhookDelivery.ts`
  - Tests: `src/webhookDelivery.test.ts`
  - Docs: `docs/webhook-signature-verification.md`
  - Include TSDoc/NatSpec-style doc comments
  - Validate security assumptions (input validation, auth, signature verification, secret redaction, idempotency)

## Test and commit

- Run tests: `npm test`  (coverage: `npm run test:ci`)
- Cover edge cases
- Include test output and security notes in the PR

## Example commit message

```
feat(webhooks): add exponential backoff with jitter to delivery retries
```

## Guidelines

- Minimum 95% line coverage on new/changed code
- No secrets in repo; use `.env` + deployment secrets only
- Clear documentation
- Timeframe: 96 hours from assignment
++++++
---
title: "Implement HMAC timestamp tolerance and replay protection for inbound webhooks"
labels: ["type:security", "area:webhooks", "stack:typescript", "priority:high"]
type: Task
---

## Description

The webhook signature verification documented in `docs/webhook-signature-verification.md` validates the HMAC but does not bound message age, allowing replay of captured signed payloads. Add a configurable timestamp tolerance window and a short-lived nonce cache so previously seen signatures within the window are rejected.

## Requirements and context

- Verify a signed `timestamp` header is within a configurable tolerance (default 300s) using constant-time comparison.
- Maintain a replay cache keyed on signature/nonce in `src/db` (SQLite) with TTL eviction; reject duplicates.
- Reuse the secret redaction in `redact.ts` for any error logging; never log raw signatures or secrets.
- Acceptance: tests cover valid in-window, expired, future-skew, and replayed signatures; 401 with safe error from `src/errors/safeErrors.ts`.

## Suggested execution

- Fork the repo and create a branch:
  - `git checkout -b security/webhook-replay-protection`
- Implement changes:
  - `src/webhookDelivery.ts`
  - Tests: `src/webhookDelivery.test.ts`
  - Docs: `docs/webhook-signature-verification.md`
  - Include TSDoc/NatSpec-style doc comments
  - Validate security assumptions (input validation, auth, signature verification, secret redaction, idempotency)

## Test and commit

- Run tests: `npm test`  (coverage: `npm run test:ci`)
- Cover edge cases
- Include test output and security notes in the PR

## Example commit message

```
feat(webhooks): add HMAC timestamp tolerance and replay protection
```

## Guidelines

- Minimum 95% line coverage on new/changed code
- No secrets in repo; use `.env` + deployment secrets only
- Clear documentation
- Timeframe: 96 hours from assignment
++++++
---
title: "Add DLQ replay endpoint with idempotent re-delivery in src/api/jobs.ts"
labels: ["type:feature", "area:dlq", "stack:typescript", "priority:high"]
type: Task
---

## Description

The webhook DLQ in `src/api/jobs.ts` (tested by `src/api/jobs.dlq.test.ts`) captures failed deliveries but offers no operator path to replay them. Add an authenticated endpoint to selectively replay DLQ entries back through `WebhookDeliveryService`, guarded by event idempotency so replays cannot double-deliver.

## Requirements and context

- Expose `POST /jobs/dlq/:id/replay` and `POST /jobs/dlq/replay` (batch) behind admin auth.
- Replays must pass through the idempotency layer in `src/events/*` so an already-delivered event is a no-op.
- Record `webhook_dlq_replays_total` and outcome in `webhookMetrics.ts`; redact payload secrets via `redact.ts`.
- Acceptance: integration test replays a DLQ entry, asserts single delivery, and asserts idempotent no-op on duplicate replay.

## Suggested execution

- Fork the repo and create a branch:
  - `git checkout -b feature/dlq-replay-endpoint`
- Implement changes:
  - `src/api/jobs.ts`
  - Tests: `src/api/jobs.dlq.test.ts`
  - Docs: `docs/WEBHOOK-DLQ.md`
  - Include TSDoc/NatSpec-style doc comments
  - Validate security assumptions (input validation, auth, signature verification, secret redaction, idempotency)

## Test and commit

- Run tests: `npm test`  (coverage: `npm run test:ci`)
- Cover edge cases
- Include test output and security notes in the PR

## Example commit message

```
feat(dlq): add idempotent DLQ replay endpoint
```

## Guidelines

- Minimum 95% line coverage on new/changed code
- No secrets in repo; use `.env` + deployment secrets only
- Clear documentation
- Timeframe: 96 hours from assignment
++++++
---
title: "Add DLQ depth and age gauges to webhookMetrics with Prometheus exposure"
labels: ["type:feature", "area:observability", "area:dlq", "stack:typescript", "priority:medium"]
type: Task
---

## Description

`webhookMetrics.ts` tracks delivery attempts and latency but exposes no visibility into DLQ backlog health. Add gauges for current DLQ depth and oldest-entry age so operators can alert on growing webhook delivery failures driven from `src/api/jobs.ts`.

## Requirements and context

- Add `webhook_dlq_depth` and `webhook_dlq_oldest_age_seconds` gauges keyed by provider.
- Sample the DLQ store on a bounded interval without blocking the event loop; avoid label cardinality explosion (reuse `sanitizeProvider`).
- Surface metrics on the existing `prom-client` registry; document scrape and alert thresholds.
- Acceptance: tests assert gauge values track simulated DLQ contents and reset to zero when drained.

## Suggested execution

- Fork the repo and create a branch:
  - `git checkout -b feature/dlq-depth-metrics`
- Implement changes:
  - `src/webhookMetrics.ts`
  - Tests: `src/webhookDelivery.test.ts`
  - Docs: `docs/WEBHOOK-DLQ.md`
  - Include TSDoc/NatSpec-style doc comments
  - Validate security assumptions (input validation, auth, signature verification, secret redaction, idempotency)

## Test and commit

- Run tests: `npm test`  (coverage: `npm run test:ci`)
- Cover edge cases
- Include test output and security notes in the PR

## Example commit message

```
feat(observability): add DLQ depth and age gauges
```

## Guidelines

- Minimum 95% line coverage on new/changed code
- No secrets in repo; use `.env` + deployment secrets only
- Clear documentation
- Timeframe: 96 hours from assignment
++++++
---
title: "Enforce per-provider token-bucket rate limiting in rateLimit middleware"
labels: ["type:feature", "area:rate-limit", "stack:typescript", "priority:high"]
type: Task
---

## Description

The current rate limiting validated by `src/rateLimit.integration.test.ts` applies a global policy. Outbound webhook delivery to slow partners can starve others, so add a per-provider token-bucket limiter that paces deliveries from `WebhookDeliveryService` independently per provider.

## Requirements and context

- Implement a token-bucket limiter with per-provider capacity/refill configured via env and validated at boot.
- Integrate with `webhookMetrics.ts` to record throttled deliveries; redact provider secrets in logs.
- Ensure limiter is shared correctly across blue/green processes or documented as per-process.
- Acceptance: integration test proves provider A throttling does not block provider B, and burst beyond capacity is delayed not dropped.

## Suggested execution

- Fork the repo and create a branch:
  - `git checkout -b feature/per-provider-rate-limit`
- Implement changes:
  - `src/rateLimit.ts`
  - Tests: `src/rateLimit.integration.test.ts`
  - Docs: `docs/request-limits-implementation.md`
  - Include TSDoc/NatSpec-style doc comments
  - Validate security assumptions (input validation, auth, signature verification, secret redaction, idempotency)

## Test and commit

- Run tests: `npm test`  (coverage: `npm run test:ci`)
- Cover edge cases
- Include test output and security notes in the PR

## Example commit message

```
feat(rate-limit): add per-provider token-bucket limiter
```

## Guidelines

- Minimum 95% line coverage on new/changed code
- No secrets in repo; use `.env` + deployment secrets only
- Clear documentation
- Timeframe: 96 hours from assignment
++++++
---
title: "Return RFC 6585 429 responses with Retry-After from rateLimit middleware"
labels: ["type:enhancement", "area:rate-limit", "stack:typescript", "priority:medium"]
type: Task
---

## Description

When request limits are exceeded the API should return a standards-compliant 429 with a `Retry-After` header rather than a generic error. Align the `rateLimit` middleware with the safe-error policy in `src/errors/errorMessagePolicy`.

## Requirements and context

- Emit `429 Too Many Requests` with `Retry-After` and `X-RateLimit-*` headers reflecting remaining budget.
- Use `src/errors/safeErrors.ts` so no internal limiter state leaks to clients.
- Document headers and client backoff guidance in `docs/request-limits-implementation.md`.
- Acceptance: integration test asserts header values and that the body matches the safe-error contract.

## Suggested execution

- Fork the repo and create a branch:
  - `git checkout -b enhancement/rate-limit-429-headers`
- Implement changes:
  - `src/rateLimit.ts`
  - Tests: `src/rateLimit.integration.test.ts`
  - Docs: `docs/request-limits-implementation.md`
  - Include TSDoc/NatSpec-style doc comments
  - Validate security assumptions (input validation, auth, signature verification, secret redaction, idempotency)

## Test and commit

- Run tests: `npm test`  (coverage: `npm run test:ci`)
- Cover edge cases
- Include test output and security notes in the PR

## Example commit message

```
feat(rate-limit): return 429 with Retry-After headers
```

## Guidelines

- Minimum 95% line coverage on new/changed code
- No secrets in repo; use `.env` + deployment secrets only
- Clear documentation
- Timeframe: 96 hours from assignment
++++++
---
title: "Add streaming body-size enforcement to requestLimits to reject oversized payloads early"
labels: ["type:security", "area:rate-limit", "stack:typescript", "priority:high"]
type: Task
---

## Description

The request size limits covered by `src/requestLimits.integration.test.ts` should abort oversized request bodies during streaming rather than after buffering, preventing memory exhaustion from malicious large uploads to webhook ingest endpoints.

## Requirements and context

- Enforce `Content-Length` and streamed byte-count limits, destroying the stream once the threshold is crossed.
- Configurable max body size per route via env; validated at startup with clear failure.
- Return a safe `413 Payload Too Large` via `src/errors/safeErrors.ts`; never echo attacker-controlled content.
- Acceptance: tests cover oversized Content-Length, chunked encoding without length, and exactly-at-limit boundary.

## Suggested execution

- Fork the repo and create a branch:
  - `git checkout -b security/streaming-body-limits`
- Implement changes:
  - `src/requestLimits.ts`
  - Tests: `src/requestLimits.integration.test.ts`
  - Docs: `docs/request-limits-security.md`
  - Include TSDoc/NatSpec-style doc comments
  - Validate security assumptions (input validation, auth, signature verification, secret redaction, idempotency)

## Test and commit

- Run tests: `npm test`  (coverage: `npm run test:ci`)
- Cover edge cases
- Include test output and security notes in the PR

## Example commit message

```
feat(rate-limit): enforce streaming body-size limits
```

## Guidelines

- Minimum 95% line coverage on new/changed code
- No secrets in repo; use `.env` + deployment secrets only
- Clear documentation
- Timeframe: 96 hours from assignment
++++++
---
title: "Implement scheduled data retention purge job with audit trail"
labels: ["type:feature", "area:retention", "area:db", "stack:typescript", "priority:high"]
type: Task
---

## Description

`docs/DATA_RETENTION.md` defines retention windows but there is no enforced purge for expired events and webhook records in SQLite. Add a scheduled retention job that deletes records past their window and writes an audit record of what was purged.

## Requirements and context

- Run a bounded, batched purge over `src/db` tables (events, webhook deliveries, DLQ) respecting per-table retention env config.
- Wrap deletes in transactions with `migrations.ts`-compatible schema; never block delivery hot path.
- Emit purge counts to metrics and write a tamper-evident audit entry; redact any PII via `redact.ts`.
- Acceptance: tests seed expired and live rows and assert only expired rows are purged, with correct audit counts.

## Suggested execution

- Fork the repo and create a branch:
  - `git checkout -b feature/retention-purge-job`
- Implement changes:
  - `src/retention/purge.ts`
  - Tests: `src/retention/purge.test.ts`
  - Docs: `docs/DATA_RETENTION.md`
  - Include TSDoc/NatSpec-style doc comments
  - Validate security assumptions (input validation, auth, signature verification, secret redaction, idempotency)

## Test and commit

- Run tests: `npm test`  (coverage: `npm run test:ci`)
- Cover edge cases
- Include test output and security notes in the PR

## Example commit message

```
feat(retention): add scheduled batched purge job
```

## Guidelines

- Minimum 95% line coverage on new/changed code
- No secrets in repo; use `.env` + deployment secrets only
- Clear documentation
- Timeframe: 96 hours from assignment
++++++
---
title: "Add dry-run and reporting mode to data retention purge"
labels: ["type:enhancement", "area:retention", "stack:typescript", "priority:medium"]
type: Task
---

## Description

Operators need confidence before destructive retention runs. Add a dry-run mode to the retention purge that reports candidate row counts per table without deleting, aligned with the windows in `docs/DATA_RETENTION.md`.

## Requirements and context

- Support `--dry-run` / env flag producing a per-table report of rows that would be deleted.
- Reuse the same query logic as the real purge to guarantee parity; no schema drift.
- Output structured logs only (no raw PII), using `redact.ts`.
- Acceptance: tests assert dry-run deletes nothing and report counts equal actual purge counts on the same fixture.

## Suggested execution

- Fork the repo and create a branch:
  - `git checkout -b enhancement/retention-dry-run`
- Implement changes:
  - `src/retention/purge.ts`
  - Tests: `src/retention/purge.test.ts`
  - Docs: `docs/DATA_RETENTION.md`
  - Include TSDoc/NatSpec-style doc comments
  - Validate security assumptions (input validation, auth, signature verification, secret redaction, idempotency)

## Test and commit

- Run tests: `npm test`  (coverage: `npm run test:ci`)
- Cover edge cases
- Include test output and security notes in the PR

## Example commit message

```
feat(retention): add dry-run reporting mode
```

## Guidelines

- Minimum 95% line coverage on new/changed code
- No secrets in repo; use `.env` + deployment secrets only
- Clear documentation
- Timeframe: 96 hours from assignment
++++++
---
title: "Add pre-switch health gate to deploy.ts switch-green command"
labels: ["type:feature", "area:deploy", "stack:typescript", "priority:high"]
type: Task
---

## Description

`src/deploy.ts` exposes `switch-green` but routes traffic without verifying the green instance is healthy. Add a pre-switch gate that polls the green `health.ts` readiness endpoint and aborts the switch if it is not ready within a timeout.

## Requirements and context

- `switch-green` must poll green readiness (from `health.ts`) with bounded retries before flipping the router state.
- On failure, leave blue active and exit non-zero with a safe error; never partially switch.
- Document gate config and behavior; ensure compatibility with `deploy:status` reporting.
- Acceptance: `deploy.test.ts` covers healthy-switch, unhealthy-abort, and timeout cases.

## Suggested execution

- Fork the repo and create a branch:
  - `git checkout -b feature/deploy-health-gate`
- Implement changes:
  - `src/deploy.ts`
  - Tests: `src/deploy.test.ts`
  - Docs: `docs/backend`
  - Include TSDoc/NatSpec-style doc comments
  - Validate security assumptions (input validation, auth, signature verification, secret redaction, idempotency)

## Test and commit

- Run tests: `npm test`  (coverage: `npm run test:ci`)
- Cover edge cases
- Include test output and security notes in the PR

## Example commit message

```
feat(deploy): gate switch-green on green health readiness
```

## Guidelines

- Minimum 95% line coverage on new/changed code
- No secrets in repo; use `.env` + deployment secrets only
- Clear documentation
- Timeframe: 96 hours from assignment
++++++
---
title: "Add automatic rollback trigger on post-switch error-rate threshold in deploy.ts"
labels: ["type:feature", "area:deploy", "area:observability", "stack:typescript", "priority:medium"]
type: Task
---

## Description

After `switch-green`, regressions are only caught manually via `deploy:status`. Add an automatic rollback that watches error-rate/health metrics for a soak window after the switch and invokes `rollback` if a threshold is breached.

## Requirements and context

- Read error-rate from the metrics registry over a configurable soak window; if breached, invoke `deploy.ts rollback` automatically.
- Make thresholds and window env-configurable and validated; emit structured deploy-decision logs.
- Ensure the rollback path is idempotent and reflected by `deploy:status`.
- Acceptance: `deploy.test.ts` simulates healthy soak (no rollback) and breached soak (auto rollback).

## Suggested execution

- Fork the repo and create a branch:
  - `git checkout -b feature/deploy-auto-rollback`
- Implement changes:
  - `src/deploy.ts`
  - Tests: `src/deploy.test.ts`
  - Docs: `docs/backend`
  - Include TSDoc/NatSpec-style doc comments
  - Validate security assumptions (input validation, auth, signature verification, secret redaction, idempotency)

## Test and commit

- Run tests: `npm test`  (coverage: `npm run test:ci`)
- Cover edge cases
- Include test output and security notes in the PR

## Example commit message

```
feat(deploy): auto-rollback on post-switch error-rate breach
```

## Guidelines

- Minimum 95% line coverage on new/changed code
- No secrets in repo; use `.env` + deployment secrets only
- Clear documentation
- Timeframe: 96 hours from assignment
++++++
---
title: "Drain in-flight webhook deliveries during graceful shutdown in shutdown.ts"
labels: ["type:enhancement", "area:webhooks", "stack:typescript", "priority:high"]
type: Task
---

## Description

`src/shutdown.ts` handles termination but may cut off in-flight webhook deliveries from `WebhookDeliveryService`, causing avoidable DLQ entries during blue/green switches. Add a drain phase that lets active deliveries finish before exit.

## Requirements and context

- On SIGTERM, stop accepting new deliveries, wait for in-flight deliveries up to a configurable grace timeout, then exit.
- Coordinate with `deploy.ts` switch so draining the old color does not strand jobs; force-flush remaining to DLQ on timeout.
- Document grace timeout env var and interaction with the router.
- Acceptance: `shutdown.test.ts` asserts in-flight deliveries complete within grace and remainder go to DLQ on timeout.

## Suggested execution

- Fork the repo and create a branch:
  - `git checkout -b enhancement/shutdown-drain-webhooks`
- Implement changes:
  - `src/shutdown.ts`
  - Tests: `src/shutdown.test.ts`
  - Docs: `docs/WEBHOOK-DLQ.md`
  - Include TSDoc/NatSpec-style doc comments
  - Validate security assumptions (input validation, auth, signature verification, secret redaction, idempotency)

## Test and commit

- Run tests: `npm test`  (coverage: `npm run test:ci`)
- Cover edge cases
- Include test output and security notes in the PR

## Example commit message

```
feat(webhooks): drain in-flight deliveries on graceful shutdown
```

## Guidelines

- Minimum 95% line coverage on new/changed code
- No secrets in repo; use `.env` + deployment secrets only
- Clear documentation
- Timeframe: 96 hours from assignment
++++++
---
title: "Strengthen event idempotency keys with payload hashing in src/events"
labels: ["type:feature", "area:events", "stack:typescript", "priority:high"]
type: Task
---

## Description

Event ingestion idempotency (see `docs/EVENT_INGESTION_IDEMPOTENCY.md` and `src/events/types.ts`) should detect not only duplicate IDs but also conflicting payloads reusing the same ID. Add payload hashing so a reused idempotency key with a different body is rejected rather than silently accepted.

## Requirements and context

- Compute a stable canonical hash of the event payload and store it with the idempotency key in `src/db`.
- On duplicate key with matching hash, return the cached result; on mismatch, reject with a safe `409 Conflict`.
- Use constant-time comparison and redact payloads in logs via `redact.ts`.
- Acceptance: tests cover duplicate-identical (no-op), duplicate-conflicting (409), and first-write paths.

## Suggested execution

- Fork the repo and create a branch:
  - `git checkout -b feature/event-payload-hash-idempotency`
- Implement changes:
  - `src/events/idempotency.ts`
  - Tests: `src/events/idempotency.test.ts`
  - Docs: `docs/EVENT_INGESTION_IDEMPOTENCY.md`
  - Include TSDoc/NatSpec-style doc comments
  - Validate security assumptions (input validation, auth, signature verification, secret redaction, idempotency)

## Test and commit

- Run tests: `npm test`  (coverage: `npm run test:ci`)
- Cover edge cases
- Include test output and security notes in the PR

## Example commit message

```
feat(events): reject conflicting payloads under reused idempotency keys
```

## Guidelines

- Minimum 95% line coverage on new/changed code
- No secrets in repo; use `.env` + deployment secrets only
- Clear documentation
- Timeframe: 96 hours from assignment
++++++
---
title: "Add idempotency key TTL and expired-key handling to event ingestion"
labels: ["type:enhancement", "area:events", "area:db", "stack:typescript", "priority:medium"]
type: Task
---

## Description

The idempotency store described in `docs/EVENT_INGESTION_IDEMPOTENCY.md` grows unbounded. Add a TTL so keys expire and define behavior when an event arrives for an expired key, coordinated with the data retention windows.

## Requirements and context

- Add per-key TTL with eviction in `src/db`; expired keys are treated as new ingestions.
- Ensure eviction does not race with the retention purge; document the relationship in `docs/DATA_RETENTION.md`.
- Emit a metric for active idempotency keys and evictions.
- Acceptance: tests cover unexpired duplicate (no-op), expired key (reprocess), and eviction count correctness.

## Suggested execution

- Fork the repo and create a branch:
  - `git checkout -b enhancement/idempotency-key-ttl`
- Implement changes:
  - `src/events/idempotency.ts`
  - Tests: `src/events/idempotency.test.ts`
  - Docs: `docs/EVENT_INGESTION_IDEMPOTENCY.md`
  - Include TSDoc/NatSpec-style doc comments
  - Validate security assumptions (input validation, auth, signature verification, secret redaction, idempotency)

## Test and commit

- Run tests: `npm test`  (coverage: `npm run test:ci`)
- Cover edge cases
- Include test output and security notes in the PR

## Example commit message

```
feat(events): add TTL and expiry handling to idempotency store
```

## Guidelines

- Minimum 95% line coverage on new/changed code
- No secrets in repo; use `.env` + deployment secrets only
- Clear documentation
- Timeframe: 96 hours from assignment
++++++
---
title: "Add transactional migration runner with checksum verification in src/db/migrations.ts"
labels: ["type:feature", "area:db", "stack:typescript", "priority:high"]
type: Task
---

## Description

`src/db/migrations.ts` applies schema changes but does not verify that previously applied migrations are unchanged. Add checksum tracking so tampered or reordered migrations fail fast, and wrap each migration in a transaction for atomic apply.

## Requirements and context

- Store a per-migration checksum; on startup verify applied migrations match recorded checksums and abort on mismatch.
- Apply each pending migration in a single transaction; roll back fully on error.
- Document migration authoring rules in a new doc; integrate with `database.ts` open path.
- Acceptance: `migrations.test.ts` covers clean apply, checksum mismatch abort, and mid-migration failure rollback.

## Suggested execution

- Fork the repo and create a branch:
  - `git checkout -b feature/migration-checksums`
- Implement changes:
  - `src/db/migrations.ts`
  - Tests: `src/db/migrations.test.ts`
  - Docs: `docs/migrations.md`
  - Include TSDoc/NatSpec-style doc comments
  - Validate security assumptions (input validation, auth, signature verification, secret redaction, idempotency)

## Test and commit

- Run tests: `npm test`  (coverage: `npm run test:ci`)
- Cover edge cases
- Include test output and security notes in the PR

## Example commit message

```
feat(db): add transactional migrations with checksum verification
```

## Guidelines

- Minimum 95% line coverage on new/changed code
- No secrets in repo; use `.env` + deployment secrets only
- Clear documentation
- Timeframe: 96 hours from assignment
++++++
---
title: "Enable SQLite WAL mode and busy-timeout tuning in src/db/database.ts"
labels: ["type:enhancement", "area:db", "stack:typescript", "priority:medium"]
type: Task
---

## Description

The better-sqlite3 connection in `src/db/database.ts` should enable WAL journaling and a busy timeout to reduce writer contention between event ingestion and the retention purge. Make pragmas explicit and configurable.

## Requirements and context

- Set `journal_mode=WAL`, `synchronous=NORMAL`, and a configurable `busy_timeout` at connection open.
- Ensure pragmas are applied before any writes and are idempotent across blue/green processes.
- Document the durability/concurrency tradeoffs.
- Acceptance: `database.test.ts` asserts pragmas are applied and concurrent read/write does not deadlock under contention.

## Suggested execution

- Fork the repo and create a branch:
  - `git checkout -b enhancement/sqlite-wal-tuning`
- Implement changes:
  - `src/db/database.ts`
  - Tests: `src/db/database.test.ts`
  - Docs: `docs/migrations.md`
  - Include TSDoc/NatSpec-style doc comments
  - Validate security assumptions (input validation, auth, signature verification, secret redaction, idempotency)

## Test and commit

- Run tests: `npm test`  (coverage: `npm run test:ci`)
- Cover edge cases
- Include test output and security notes in the PR

## Example commit message

```
feat(db): enable WAL mode and busy-timeout tuning
```

## Guidelines

- Minimum 95% line coverage on new/changed code
- No secrets in repo; use `.env` + deployment secrets only
- Clear documentation
- Timeframe: 96 hours from assignment
++++++
---
title: "Validate and fail-fast on missing Soroban environment in sorobanEnv.ts"
labels: ["type:security", "area:stellar", "stack:typescript", "priority:high"]
type: Task
---

## Description

`src/sorobanEnv.ts` reads Soroban/Stellar configuration but should validate all required values (RPC URL, network passphrase, contract IDs) at startup and fail fast with redacted diagnostics rather than failing deep in escrow-related flows.

## Requirements and context

- Validate Soroban env with a schema (zod) at boot; missing/invalid values abort startup with a safe error.
- Never log secret keys; route diagnostics through `redact.ts`.
- Validate contract ID format consistent with `contractMetadata`; document every required variable.
- Acceptance: tests cover all-present, each-missing, and malformed-contract-id cases.

## Suggested execution

- Fork the repo and create a branch:
  - `git checkout -b security/soroban-env-validation`
- Implement changes:
  - `src/sorobanEnv.ts`
  - Tests: `src/sorobanEnv.test.ts`
  - Docs: `docs/backend`
  - Include TSDoc/NatSpec-style doc comments
  - Validate security assumptions (input validation, auth, signature verification, secret redaction, idempotency)

## Test and commit

- Run tests: `npm test`  (coverage: `npm run test:ci`)
- Cover edge cases
- Include test output and security notes in the PR

## Example commit message

```
feat(stellar): validate and fail-fast on Soroban env
```

## Guidelines

- Minimum 95% line coverage on new/changed code
- No secrets in repo; use `.env` + deployment secrets only
- Clear documentation
- Timeframe: 96 hours from assignment
++++++
---
title: "Verify Soroban escrow contract metadata against expected hash in contractMetadata"
labels: ["type:security", "area:stellar", "stack:typescript", "priority:high"]
type: Task
---

## Description

`contractMetadata` (with `src/contractMetadata.integration.test.ts`) loads on-chain contract details, but the backend should pin and verify expected contract metadata so a swapped or unexpected escrow contract is rejected before any webhook-driven settlement action.

## Requirements and context

- Pin expected contract hash/version per network; verify fetched metadata matches before use.
- On mismatch, refuse to operate and emit a safe error via `src/errors/safeErrors.ts`; alert via metrics.
- Source expected values from validated `sorobanEnv.ts`; document rotation procedure.
- Acceptance: integration test covers matching metadata (proceed) and mismatched metadata (reject).

## Suggested execution

- Fork the repo and create a branch:
  - `git checkout -b security/contract-metadata-pinning`
- Implement changes:
  - `src/contractMetadata.ts`
  - Tests: `src/contractMetadata.integration.test.ts`
  - Docs: `docs/backend`
  - Include TSDoc/NatSpec-style doc comments
  - Validate security assumptions (input validation, auth, signature verification, secret redaction, idempotency)

## Test and commit

- Run tests: `npm test`  (coverage: `npm run test:ci`)
- Cover edge cases
- Include test output and security notes in the PR

## Example commit message

```
feat(stellar): pin and verify escrow contract metadata
```

## Guidelines

- Minimum 95% line coverage on new/changed code
- No secrets in repo; use `.env` + deployment secrets only
- Clear documentation
- Timeframe: 96 hours from assignment
++++++
---
title: "Expand redact.ts to cover Stellar secret keys and webhook signing secrets"
labels: ["type:security", "area:security", "stack:typescript", "priority:high"]
type: Task
---

## Description

`src/redact.ts` redacts known secret patterns, but Stellar secret seeds (`S...`) and webhook HMAC signing secrets must be guaranteed redacted across all log paths including error objects from `WebhookDeliveryService` and `sorobanEnv.ts`.

## Requirements and context

- Add detection/redaction for Stellar secret seeds, signing secrets, and bearer tokens, including nested object and stringified error cases.
- Ensure redaction runs in the logger pipeline so no caller can bypass it.
- Acceptance: `redact.test.ts` asserts redaction of Stellar seeds, HMAC secrets, and tokens in nested structures and Error stacks, with no false-positive over-redaction of public keys.

## Suggested execution

- Fork the repo and create a branch:
  - `git checkout -b security/redact-stellar-secrets`
- Implement changes:
  - `src/redact.ts`
  - Tests: `src/redact.test.ts`
  - Docs: `docs/backend`
  - Include TSDoc/NatSpec-style doc comments
  - Validate security assumptions (input validation, auth, signature verification, secret redaction, idempotency)

## Test and commit

- Run tests: `npm test`  (coverage: `npm run test:ci`)
- Cover edge cases
- Include test output and security notes in the PR

## Example commit message

```
feat(security): redact Stellar seeds and webhook signing secrets
```

## Guidelines

- Minimum 95% line coverage on new/changed code
- No secrets in repo; use `.env` + deployment secrets only
- Clear documentation
- Timeframe: 96 hours from assignment
++++++
---
title: "Enforce safe-error message policy on all API routes via errorMessagePolicy"
labels: ["type:security", "area:errors", "stack:typescript", "priority:high"]
type: Task
---

## Description

`src/errors/errorMessagePolicy` and `safeErrors.ts` define safe client messages, but routes registered in `router.ts`/`app.ts` may still leak internal details on unhandled errors. Add a centralized error-handling middleware that maps all errors through the policy.

## Requirements and context

- Add a terminal Express error handler that converts any error into an `AppError`-shaped safe response.
- Internal details logged (redacted) but never returned; include a correlation ID in responses for support.
- Acceptance: `errorMessagePolicy.integration.test.ts` asserts unknown errors, `appError.ts` errors, and validation errors all return safe bodies with correct status codes.

## Suggested execution

- Fork the repo and create a branch:
  - `git checkout -b security/central-error-handler`
- Implement changes:
  - `src/errors/safeErrors.ts`
  - Tests: `src/errors/errorMessagePolicy.integration.test.ts`
  - Docs: `docs/API.md`
  - Include TSDoc/NatSpec-style doc comments
  - Validate security assumptions (input validation, auth, signature verification, secret redaction, idempotency)

## Test and commit

- Run tests: `npm test`  (coverage: `npm run test:ci`)
- Cover edge cases
- Include test output and security notes in the PR

## Example commit message

```
feat(errors): enforce safe-error policy via central handler
```

## Guidelines

- Minimum 95% line coverage on new/changed code
- No secrets in repo; use `.env` + deployment secrets only
- Clear documentation
- Timeframe: 96 hours from assignment
++++++
---
title: "Add correlation-ID propagation across requests, events, and webhook deliveries"
labels: ["type:enhancement", "area:observability", "stack:typescript", "priority:medium"]
type: Task
---

## Description

Tracing a request from API ingress through `src/events/*` to outbound `WebhookDeliveryService` is currently hard. Add a correlation ID generated in `app.ts` and propagated through event processing and webhook delivery logs and headers.

## Requirements and context

- Generate/accept an `X-Correlation-Id` in `app.ts`; attach to the pino logger context for the request lifecycle.
- Propagate the ID into event idempotency records and outbound webhook headers.
- Acceptance: integration test asserts the same correlation ID appears across ingress log, event record, and delivery attempt.

## Suggested execution

- Fork the repo and create a branch:
  - `git checkout -b enhancement/correlation-id-propagation`
- Implement changes:
  - `src/app.ts`
  - Tests: `src/app.integration.test.ts`
  - Docs: `docs/API.md`
  - Include TSDoc/NatSpec-style doc comments
  - Validate security assumptions (input validation, auth, signature verification, secret redaction, idempotency)

## Test and commit

- Run tests: `npm test`  (coverage: `npm run test:ci`)
- Cover edge cases
- Include test output and security notes in the PR

## Example commit message

```
feat(observability): propagate correlation IDs end-to-end
```

## Guidelines

- Minimum 95% line coverage on new/changed code
- No secrets in repo; use `.env` + deployment secrets only
- Clear documentation
- Timeframe: 96 hours from assignment
++++++
---
title: "Separate liveness and readiness probes with dependency checks in health.ts"
labels: ["type:enhancement", "area:observability", "stack:typescript", "priority:medium"]
type: Task
---

## Description

`src/health.ts` should distinguish liveness from readiness so the `deploy.ts` switch gate and orchestrator only route traffic when SQLite and the Soroman RPC dependency are reachable. Add readiness checks that reflect real dependency state.

## Requirements and context

- Add `/health/live` (process up) and `/health/ready` (DB open, Soroban RPC reachable, queue connected).
- Readiness must be cheap and time-bounded; failing dependency yields 503 with safe body.
- Coordinate with `deploy.ts` pre-switch gate and `shutdown.ts` drain (report not-ready during drain).
- Acceptance: `health.test.ts` covers all-ready, DB-down, and RPC-unreachable cases.

## Suggested execution

- Fork the repo and create a branch:
  - `git checkout -b enhancement/health-live-ready-split`
- Implement changes:
  - `src/health.ts`
  - Tests: `src/health.test.ts`
  - Docs: `docs/API.md`
  - Include TSDoc/NatSpec-style doc comments
  - Validate security assumptions (input validation, auth, signature verification, secret redaction, idempotency)

## Test and commit

- Run tests: `npm test`  (coverage: `npm run test:ci`)
- Cover edge cases
- Include test output and security notes in the PR

## Example commit message

```
feat(observability): split liveness and readiness probes
```

## Guidelines

- Minimum 95% line coverage on new/changed code
- No secrets in repo; use `.env` + deployment secrets only
- Clear documentation
- Timeframe: 96 hours from assignment
++++++
---
title: "Add integration tests for webhook DLQ overflow and poison-message handling"
labels: ["type:test", "area:dlq", "stack:typescript", "priority:high"]
type: Task
---

## Description

`src/api/jobs.dlq.test.ts` covers basic DLQ enqueue but lacks coverage for overflow behavior and poison messages that repeatedly fail. Add integration tests that exercise capacity limits and permanently-failing payloads.

## Requirements and context

- Test DLQ behavior at and beyond capacity (oldest-eviction vs reject policy, whichever is implemented).
- Test a poison message that fails every replay attempt and asserts it is not retried infinitely.
- Assert `webhookMetrics.ts` counters reflect DLQ enqueues and dropped messages.
- Acceptance: deterministic tests with no real network; coverage on DLQ branches >= 95%.

## Suggested execution

- Fork the repo and create a branch:
  - `git checkout -b test/dlq-overflow-poison`
- Implement changes:
  - `src/api/jobs.ts`
  - Tests: `src/api/jobs.dlq.test.ts`
  - Docs: `docs/WEBHOOK-DLQ.md`
  - Include TSDoc/NatSpec-style doc comments
  - Validate security assumptions (input validation, auth, signature verification, secret redaction, idempotency)

## Test and commit

- Run tests: `npm test`  (coverage: `npm run test:ci`)
- Cover edge cases
- Include test output and security notes in the PR

## Example commit message

```
test(dlq): cover overflow and poison-message handling
```

## Guidelines

- Minimum 95% line coverage on new/changed code
- No secrets in repo; use `.env` + deployment secrets only
- Clear documentation
- Timeframe: 96 hours from assignment
++++++
---
title: "Add property-based tests for HMAC signature verification edge cases"
labels: ["type:test", "area:webhooks", "stack:typescript", "priority:medium"]
type: Task
---

## Description

Webhook signature verification in `src/webhookDelivery.ts` needs adversarial coverage. Add property-based tests that fuzz signatures, headers, and bodies to ensure no malformed input bypasses verification or throws unhandled errors.

## Requirements and context

- Use generated inputs (random bytes, truncated signatures, wrong-length HMACs, mismatched encodings) to assert rejection.
- Confirm constant-time comparison behavior and that errors route through `safeErrors.ts`.
- Acceptance: fuzz suite runs deterministically with a fixed seed; zero accepted forgeries; branch coverage on verify path >= 95%.

## Suggested execution

- Fork the repo and create a branch:
  - `git checkout -b test/hmac-property-tests`
- Implement changes:
  - `src/webhookDelivery.ts`
  - Tests: `src/webhookDelivery.test.ts`
  - Docs: `docs/webhook-signature-verification.md`
  - Include TSDoc/NatSpec-style doc comments
  - Validate security assumptions (input validation, auth, signature verification, secret redaction, idempotency)

## Test and commit

- Run tests: `npm test`  (coverage: `npm run test:ci`)
- Cover edge cases
- Include test output and security notes in the PR

## Example commit message

```
test(webhooks): add property-based HMAC verification tests
```

## Guidelines

- Minimum 95% line coverage on new/changed code
- No secrets in repo; use `.env` + deployment secrets only
- Clear documentation
- Timeframe: 96 hours from assignment
++++++
---
title: "Add deploy.ts blue/green state-machine tests for switch, rollback, and status"
labels: ["type:test", "area:deploy", "stack:typescript", "priority:medium"]
type: Task
---

## Description

`src/deploy.test.ts` should fully cover the blue/green state transitions exposed by `deploy.ts` (`switch-green`, `rollback`, `status`) including invalid transitions and concurrent invocation safety.

## Requirements and context

- Cover transitions: blue->green, green->blue rollback, repeated switch (idempotent), and rollback when already blue.
- Assert `status` output accuracy after each transition and that concurrent commands do not corrupt state.
- Acceptance: deterministic tests with mocked health and timers; coverage on `deploy.ts` >= 95%.

## Suggested execution

- Fork the repo and create a branch:
  - `git checkout -b test/deploy-state-machine`
- Implement changes:
  - `src/deploy.ts`
  - Tests: `src/deploy.test.ts`
  - Docs: `docs/backend`
  - Include TSDoc/NatSpec-style doc comments
  - Validate security assumptions (input validation, auth, signature verification, secret redaction, idempotency)

## Test and commit

- Run tests: `npm test`  (coverage: `npm run test:ci`)
- Cover edge cases
- Include test output and security notes in the PR

## Example commit message

```
test(deploy): cover blue/green state transitions
```

## Guidelines

- Minimum 95% line coverage on new/changed code
- No secrets in repo; use `.env` + deployment secrets only
- Clear documentation
- Timeframe: 96 hours from assignment
++++++
---
title: "Add concurrency tests for event ingestion idempotency under parallel duplicates"
labels: ["type:test", "area:events", "stack:typescript", "priority:high"]
type: Task
---

## Description

The idempotency guarantees in `src/events/*` must hold under concurrent duplicate submissions. Add tests that fire parallel identical events and assert exactly one is processed with no race on the SQLite store.

## Requirements and context

- Simulate N concurrent identical ingestions; assert exactly one effect and N-1 deduplicated responses.
- Cover interleaving with the retention purge and TTL expiry windows.
- Acceptance: tests are deterministic and detect regressions if the unique constraint or transaction boundary is removed.

## Suggested execution

- Fork the repo and create a branch:
  - `git checkout -b test/idempotency-concurrency`
- Implement changes:
  - `src/events/idempotency.ts`
  - Tests: `src/events/idempotency.test.ts`
  - Docs: `docs/EVENT_INGESTION_IDEMPOTENCY.md`
  - Include TSDoc/NatSpec-style doc comments
  - Validate security assumptions (input validation, auth, signature verification, secret redaction, idempotency)

## Test and commit

- Run tests: `npm test`  (coverage: `npm run test:ci`)
- Cover edge cases
- Include test output and security notes in the PR

## Example commit message

```
test(events): cover concurrent duplicate idempotency
```

## Guidelines

- Minimum 95% line coverage on new/changed code
- No secrets in repo; use `.env` + deployment secrets only
- Clear documentation
- Timeframe: 96 hours from assignment
++++++
---
title: "Add boundary and chunked-encoding tests for requestLimits enforcement"
labels: ["type:test", "area:rate-limit", "stack:typescript", "priority:medium"]
type: Task
---

## Description

Expand `src/requestLimits.integration.test.ts` to cover exact-limit boundaries, chunked transfer encoding without `Content-Length`, and mismatched declared vs actual body size, ensuring `requestLimits` cannot be bypassed.

## Requirements and context

- Cover at-limit, one-byte-over, declared-small-but-actually-large, and missing-Content-Length chunked cases.
- Assert safe `413` responses and that the connection is terminated without buffering oversized bodies.
- Acceptance: deterministic integration tests; coverage on `requestLimits.ts` >= 95%.

## Suggested execution

- Fork the repo and create a branch:
  - `git checkout -b test/request-limits-boundaries`
- Implement changes:
  - `src/requestLimits.ts`
  - Tests: `src/requestLimits.integration.test.ts`
  - Docs: `docs/request-limits-security.md`
  - Include TSDoc/NatSpec-style doc comments
  - Validate security assumptions (input validation, auth, signature verification, secret redaction, idempotency)

## Test and commit

- Run tests: `npm test`  (coverage: `npm run test:ci`)
- Cover edge cases
- Include test output and security notes in the PR

## Example commit message

```
test(rate-limit): cover request-size boundary and chunked cases
```

## Guidelines

- Minimum 95% line coverage on new/changed code
- No secrets in repo; use `.env` + deployment secrets only
- Clear documentation
- Timeframe: 96 hours from assignment
++++++
---
title: "Add redact.ts regression tests for nested errors and Stellar seed false-positives"
labels: ["type:test", "area:security", "stack:typescript", "priority:medium"]
type: Task
---

## Description

Strengthen `src/redact.test.ts` to assert secrets are redacted within deeply nested objects, arrays, and Error stack traces, while public Stellar keys and contract IDs are NOT over-redacted.

## Requirements and context

- Cover nested/array/Error-stack redaction and round-trip through the pino logger.
- Assert no false positives on Stellar public keys (`G...`) and `contractMetadata` IDs.
- Acceptance: deterministic tests; coverage on `redact.ts` >= 95%; explicit cases for each secret pattern.

## Suggested execution

- Fork the repo and create a branch:
  - `git checkout -b test/redact-regression`
- Implement changes:
  - `src/redact.ts`
  - Tests: `src/redact.test.ts`
  - Docs: `docs/backend`
  - Include TSDoc/NatSpec-style doc comments
  - Validate security assumptions (input validation, auth, signature verification, secret redaction, idempotency)

## Test and commit

- Run tests: `npm test`  (coverage: `npm run test:ci`)
- Cover edge cases
- Include test output and security notes in the PR

## Example commit message

```
test(security): expand redaction regression coverage
```

## Guidelines

- Minimum 95% line coverage on new/changed code
- No secrets in repo; use `.env` + deployment secrets only
- Clear documentation
- Timeframe: 96 hours from assignment
++++++
---
title: "Add graceful-shutdown tests covering SIGTERM drain and forced timeout in shutdown.ts"
labels: ["type:test", "area:observability", "stack:typescript", "priority:medium"]
type: Task
---

## Description

Expand `src/shutdown.test.ts` to verify that `shutdown.ts` stops accepting connections, drains in-flight work, closes the SQLite handle, and forces exit on grace timeout without losing webhook deliveries to silent failure.

## Requirements and context

- Cover clean drain within grace, forced exit on timeout, and double-signal handling (idempotent shutdown).
- Assert readiness flips to not-ready and DB/queue handles close exactly once.
- Acceptance: deterministic tests with fake timers; coverage on `shutdown.ts` >= 95%.

## Suggested execution

- Fork the repo and create a branch:
  - `git checkout -b test/shutdown-drain`
- Implement changes:
  - `src/shutdown.ts`
  - Tests: `src/shutdown.test.ts`
  - Docs: `docs/backend`
  - Include TSDoc/NatSpec-style doc comments
  - Validate security assumptions (input validation, auth, signature verification, secret redaction, idempotency)

## Test and commit

- Run tests: `npm test`  (coverage: `npm run test:ci`)
- Cover edge cases
- Include test output and security notes in the PR

## Example commit message

```
test(observability): cover shutdown drain and forced timeout
```

## Guidelines

- Minimum 95% line coverage on new/changed code
- No secrets in repo; use `.env` + deployment secrets only
- Clear documentation
- Timeframe: 96 hours from assignment
++++++
---
title: "Add authenticated admin auth guard for DLQ and deploy operator endpoints"
labels: ["type:security", "area:security", "stack:typescript", "priority:high"]
type: Task
---

## Description

Operator surfaces such as the DLQ in `src/api/jobs.ts` and any deploy-status endpoints must require admin authentication. Add an auth guard with API-key/JWT verification so unauthenticated callers cannot inspect or replay webhook payloads.

## Requirements and context

- Verify API key or JWT (jsonwebtoken) with constant-time key comparison; reject with safe `401`/`403`.
- Apply to DLQ list/replay and deploy/status routes registered in `router.ts`/`app.ts`.
- Redact credentials in logs via `redact.ts`; document required env and key rotation.
- Acceptance: integration tests cover missing, invalid, and valid credentials for each protected route.

## Suggested execution

- Fork the repo and create a branch:
  - `git checkout -b security/admin-auth-guard`
- Implement changes:
  - `src/api/jobs.ts`
  - Tests: `src/api/jobs.dlq.test.ts`
  - Docs: `docs/api-keys.md`
  - Include TSDoc/NatSpec-style doc comments
  - Validate security assumptions (input validation, auth, signature verification, secret redaction, idempotency)

## Test and commit

- Run tests: `npm test`  (coverage: `npm run test:ci`)
- Cover edge cases
- Include test output and security notes in the PR

## Example commit message

```
feat(security): require admin auth on DLQ and deploy endpoints
```

## Guidelines

- Minimum 95% line coverage on new/changed code
- No secrets in repo; use `.env` + deployment secrets only
- Clear documentation
- Timeframe: 96 hours from assignment
++++++
---
title: "Add circuit breaker around outbound webhook delivery to failing providers"
labels: ["type:feature", "area:webhooks", "stack:typescript", "priority:medium"]
type: Task
---

## Description

`WebhookDeliveryService` keeps attempting deliveries to providers that are persistently down, wasting resources and filling the DLQ. Add a per-provider circuit breaker that opens after consecutive failures and short-circuits to the DLQ until a half-open probe succeeds.

## Requirements and context

- Track per-provider failure counts; open the breaker on threshold, half-open after cooldown, close on success.
- While open, route deliveries straight to DLQ and record `webhook_breaker_state` in `webhookMetrics.ts`.
- Make thresholds/cooldown env-configurable and validated; coordinate with retry backoff so they do not double-count.
- Acceptance: tests cover closed->open->half-open->closed transitions and breaker-open fast-path to DLQ.

## Suggested execution

- Fork the repo and create a branch:
  - `git checkout -b feature/webhook-circuit-breaker`
- Implement changes:
  - `src/webhookDelivery.ts`
  - Tests: `src/webhookDelivery.test.ts`
  - Docs: `docs/WEBHOOK-DLQ.md`
  - Include TSDoc/NatSpec-style doc comments
  - Validate security assumptions (input validation, auth, signature verification, secret redaction, idempotency)

## Test and commit

- Run tests: `npm test`  (coverage: `npm run test:ci`)
- Cover edge cases
- Include test output and security notes in the PR

## Example commit message

```
feat(webhooks): add per-provider circuit breaker
```

## Guidelines

- Minimum 95% line coverage on new/changed code
- No secrets in repo; use `.env` + deployment secrets only
- Clear documentation
- Timeframe: 96 hours from assignment
++++++
---
title: "Support secret rotation with overlapping HMAC keys for webhook signing"
labels: ["type:feature", "area:security", "area:webhooks", "stack:typescript", "priority:medium"]
type: Task
---

## Description

Rotating the webhook HMAC signing secret currently requires downtime. Add support for multiple active signing keys so verification accepts the previous and current secret during a rotation window, documented in `docs/webhook-signature-verification.md`.

## Requirements and context

- Accept an ordered list of signing secrets from env; sign with the primary, verify against any active key.
- Constant-time verification across keys; redact all secrets via `redact.ts`.
- Document rotation procedure and overlap window; emit a metric for which key matched.
- Acceptance: tests cover sign-with-new/verify-with-old, retire-old-key rejection, and empty/invalid key config failure.

## Suggested execution

- Fork the repo and create a branch:
  - `git checkout -b feature/hmac-key-rotation`
- Implement changes:
  - `src/webhookDelivery.ts`
  - Tests: `src/webhookDelivery.test.ts`
  - Docs: `docs/webhook-signature-verification.md`
  - Include TSDoc/NatSpec-style doc comments
  - Validate security assumptions (input validation, auth, signature verification, secret redaction, idempotency)

## Test and commit

- Run tests: `npm test`  (coverage: `npm run test:ci`)
- Cover edge cases
- Include test output and security notes in the PR

## Example commit message

```
feat(webhooks): support overlapping HMAC keys for rotation
```

## Guidelines

- Minimum 95% line coverage on new/changed code
- No secrets in repo; use `.env` + deployment secrets only
- Clear documentation
- Timeframe: 96 hours from assignment
++++++
---
title: "Document webhook delivery, retry, and DLQ lifecycle in WEBHOOK-DLQ.md"
labels: ["type:docs", "area:webhooks", "area:dlq", "stack:typescript", "priority:medium"]
type: Task
---

## Description

`docs/WEBHOOK-DLQ.md` should fully describe the end-to-end webhook lifecycle: signing, delivery via `WebhookDeliveryService`, retry/backoff, circuit breaker, DLQ enqueue, and replay. Operators need a clear runbook tied to `webhookMetrics.ts` signals.

## Requirements and context

- Document the full lifecycle with a state diagram and every relevant env var.
- Cross-reference `webhookMetrics.ts` metric names and alerting thresholds.
- Include a replay runbook referencing `src/api/jobs.ts` DLQ endpoints and required auth.
- Acceptance: doc reviewed for accuracy against code; `npm run test:docs` passes if examples touch the OpenAPI spec.

## Suggested execution

- Fork the repo and create a branch:
  - `git checkout -b docs/webhook-dlq-lifecycle`
- Implement changes:
  - `docs/WEBHOOK-DLQ.md`
  - Tests: `src/webhookDelivery.test.ts`
  - Docs: `docs/WEBHOOK-DLQ.md`
  - Include TSDoc/NatSpec-style doc comments
  - Validate security assumptions (input validation, auth, signature verification, secret redaction, idempotency)

## Test and commit

- Run tests: `npm test`  (coverage: `npm run test:ci`)
- Cover edge cases
- Include test output and security notes in the PR

## Example commit message

```
docs(webhooks): document delivery, retry, and DLQ lifecycle
```

## Guidelines

- Minimum 95% line coverage on new/changed code
- No secrets in repo; use `.env` + deployment secrets only
- Clear documentation
- Timeframe: 96 hours from assignment
++++++
---
title: "Document blue/green deploy runbook for deploy.ts switch-green and rollback"
labels: ["type:docs", "area:deploy", "stack:typescript", "priority:medium"]
type: Task
---

## Description

There is no operator runbook for the blue/green flow driven by `src/deploy.ts` and the `npm run deploy:*` scripts. Document the switch-green, rollback, and status procedures including health gating and the router on port 3000.

## Requirements and context

- Document `deploy:switch-green`, `deploy:rollback`, `deploy:status`, and the blue (3001)/green (3002)/router (3000) topology.
- Include health-gate behavior, auto-rollback thresholds, and how to interpret `deploy:status`.
- Cross-reference `health.ts` readiness and `shutdown.ts` drain timing.
- Acceptance: runbook validated against actual command output; reviewed by an operator.

## Suggested execution

- Fork the repo and create a branch:
  - `git checkout -b docs/blue-green-runbook`
- Implement changes:
  - `docs/deploy.md`
  - Tests: `src/deploy.test.ts`
  - Docs: `docs/deploy.md`
  - Include TSDoc/NatSpec-style doc comments
  - Validate security assumptions (input validation, auth, signature verification, secret redaction, idempotency)

## Test and commit

- Run tests: `npm test`  (coverage: `npm run test:ci`)
- Cover edge cases
- Include test output and security notes in the PR

## Example commit message

```
docs(deploy): add blue/green operator runbook
```

## Guidelines

- Minimum 95% line coverage on new/changed code
- No secrets in repo; use `.env` + deployment secrets only
- Clear documentation
- Timeframe: 96 hours from assignment
++++++
---
title: "Document required environment variables and secrets across all modules"
labels: ["type:docs", "area:security", "stack:typescript", "priority:medium"]
type: Task
---

## Description

Environment configuration is spread across `sorobanEnv.ts`, `rateLimit`, `requestLimits`, retention, and webhook signing without a single reference. Produce a consolidated env reference documenting every variable, default, and which are secrets that must never be committed.

## Requirements and context

- Enumerate all env vars (Soroban RPC/passphrase/contract IDs, HMAC secrets, rate/request limits, retention windows, deploy ports) with type, default, and required/optional.
- Clearly mark secrets handled by `redact.ts` and sourced only from `.env`/deployment secrets.
- Provide a `.env.example` aligned with the doc; do not include real values.
- Acceptance: doc matches code defaults; reviewer confirms no secret values are committed.

## Suggested execution

- Fork the repo and create a branch:
  - `git checkout -b docs/env-reference`
- Implement changes:
  - `docs/configuration.md`
  - Tests: `src/sorobanEnv.test.ts`
  - Docs: `docs/configuration.md`
  - Include TSDoc/NatSpec-style doc comments
  - Validate security assumptions (input validation, auth, signature verification, secret redaction, idempotency)

## Test and commit

- Run tests: `npm test`  (coverage: `npm run test:ci`)
- Cover edge cases
- Include test output and security notes in the PR

## Example commit message

```
docs(security): add consolidated env and secrets reference
```

## Guidelines

- Minimum 95% line coverage on new/changed code
- No secrets in repo; use `.env` + deployment secrets only
- Clear documentation
- Timeframe: 96 hours from assignment
