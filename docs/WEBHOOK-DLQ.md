# Webhook DLQ (Dead Letter Queue)

This document describes the webhook DLQ persistence implementation and the
graceful-shutdown drain phase that prevents avoidable DLQ entries during
blue/green deployment switches.

---

## Overview

Failed webhook deliveries are persisted to durable SQLite storage for later
inspection and replay.  The drain phase ensures that in-flight deliveries are
given a chance to complete naturally before the process exits; only deliveries
that cannot finish within the grace window are force-flushed to the DLQ.

---

## Components

### Storage (`src/queue/webhook-dlq.ts`)

- SQLite-backed persistent storage
- Deduplication via SHA-256 hash key (`webhookId` + payload)
- Unique constraint prevents duplicate entries
- `webhookSecret` is **never** returned in API responses or stored in plain text

### Retry Policy (`src/queue/webhook-retry-policy.ts`)

- Max 5 retry attempts
- Exponential backoff: 1 s → 2 s → 4 s → 8 s → 16 s
- 10 % jitter to prevent thundering herd
- Max delay cap: 30 s

### Delivery Timeout

Each outbound webhook HTTP attempt is capped by `WEBHOOK_DELIVERY_TIMEOUT_MS`.
The default is `10000` ms. Values are validated at startup and must be an
integer between `100` and `120000` ms. Timeout failures count as ordinary
transient delivery failures: the attempt increments `retryCount`, uses the
configured retry backoff, and moves to the DLQ when retries are exhausted.

### Admin Endpoints (`src/routes/admin.routes.ts`)

| Method | Endpoint                                      | Description            |
|--------|-----------------------------------------------|------------------------|
| GET    | /api/v1/admin/webhook-dlq                     | List DLQ entries       |
| GET    | /api/v1/admin/webhook-dlq/:id                 | Get single entry       |
| POST   | /api/v1/admin/webhook-dlq/:id/replay          | Replay one entry       |
| POST   | /api/v1/admin/webhooks/dlq/replay-all         | Bulk replay all pending|

---

## Bulk DLQ Replay (`replay-all`)

### Overview

Operators recovering from an outage can replay the entire pending backlog in a
single request.  The endpoint iterates all non-replayed DLQ entries in batches,
processing up to `concurrency` entries in parallel to prevent overwhelming
downstream webhook endpoints.

### Endpoint

```
POST /api/v1/admin/webhooks/dlq/replay-all
Authorization: Bearer <admin-token>
Content-Type: application/json

{
  "concurrency": 10   // optional, default 5, clamped to [1, 50]
}
```

### Response

```json
{
  "status": "success",
  "data": {
    "attempted": 42,
    "succeeded": 38,
    "failed": 2,
    "deduped": 2
  }
}
```

| Field       | Description                                                          |
|-------------|----------------------------------------------------------------------|
| `attempted` | Total entries processed (excludes already-replayed entries)         |
| `succeeded` | Entries that were successfully delivered                            |
| `failed`    | Entries that failed delivery                                        |
| `deduped`   | Entries skipped because an identical pending entry already exists   |

### Backpressure / Concurrency

Entries are processed in batches of `concurrency` using `Promise.allSettled`.
A single failed replay never aborts the rest of the batch — all settled results
are collected and counted.

```
entries: [1 2 3 4 5 6 7]   concurrency=3
batch 1: [1 2 3]  ← all run in parallel, wait for all to settle
batch 2: [4 5 6]  ← ...
batch 3: [7]
```

### Deduplication

Before each replay, `WebhookDLQStorage.checkDedupe()` checks whether an
identical payload (same `webhookId` + body hash) is already pending replay.
Duplicate entries are marked replayed and counted as `deduped` rather than
retried again.

### Error handling

Partial failures are tolerated — a single failing entry does not abort the
batch.  Each entry result is captured via `Promise.allSettled` and counted
in `succeeded`, `failed`, or `deduped`.  The endpoint always returns 200 with
the summary.

---

## Graceful-Shutdown Drain Phase

### Why it exists

Without a drain phase, a SIGTERM during a blue/green switch can interrupt
in-flight HTTP calls to webhook endpoints mid-flight.  The delivery is then
counted as a failure and written to the DLQ even though the remote server may
have already received the payload — causing spurious DLQ entries and potential
duplicate deliveries on replay.

### Lifecycle

```
SIGTERM received
      │
      ▼
1. HTTP server.close()          ← no new requests accepted from the network
      │
      ▼
2. webhookService.stopAccepting() ← gate closed; no new deliveries start
      │
      ├─ inFlightCount == 0 ──► log webhook_deliveries_drained, continue
      │
      └─ inFlightCount > 0
            │
            ├─ drain() resolves within WEBHOOK_DRAIN_TIMEOUT_MS
            │       └─► log webhook_deliveries_drained, continue
            │
            └─ timeout expires
                    ├─► log webhook_drain_timeout
                    ├─► flushToDLQ()   ← remaining deliveries written to DLQ
                    └─► log webhook_drain_flushed_to_dlq, continue
      │
      ▼
3. BullMQ workers close (force=false)
      │
      ▼
4. Downstream connections close (Redis, Postgres, …)
      │
      ▼
5. process.exit(0)
```

### Blue/green interaction

`deploy:switch-green` updates the router **before** sending SIGTERM to the old
color.  This means the old instance stops receiving new traffic before the drain
phase starts, so most in-flight deliveries will already be complete by the time
the grace timeout begins.  The timeout is therefore a safety net for the rare
case where a delivery is still in-flight at the moment the router switches.

### Implementing `DrainableWebhookService`

Any service passed to `registerShutdownHandlers` via `options.webhookService`
must satisfy the `DrainableWebhookService` interface exported from
`src/shutdown.ts`:

```ts
import { DrainableWebhookService } from './shutdown';

class WebhookDeliveryService implements DrainableWebhookService {
  private _inFlight = 0;
  private _accepting = true;

  get inFlightCount(): number {
    return this._inFlight;
  }

  /** Idempotent gate — call on SIGTERM before waiting. */
  stopAccepting(): void {
    this._accepting = false;
  }

  /** Resolves when all in-flight deliveries have settled. */
  async drain(): Promise<void> {
    // Wait until _inFlight reaches 0, e.g. via a Promise that resolves
    // when the last in-flight counter decrements to zero.
  }

  /**
   * Force-moves every remaining in-flight delivery to the DLQ.
   * Must be idempotent.  Must NOT include raw webhookSecret in the payload.
   */
  async flushToDLQ(): Promise<void> {
    // Cancel pending HTTP calls and write each to WebhookDLQStorage.
  }
}
```

---

## Capacity Management

### Overflow Policy: Oldest-Evict

When the DLQ reaches its maximum capacity (default: 10,000 entries), the system automatically evicts the oldest pending entry to make room for new failures.

**Behavior:**
- Default max capacity: 10,000 entries
- When at capacity, the oldest pending (not-yet-replayed) entry is evicted
- Replayed entries are not evicted (they are kept for historical reference)
- The eviction occurs before the new entry is added

**Rationale:**
- Ensures the DLQ doesn't grow unbounded
- Prioritizes newer failures which may be more actionable
- Replayed entries are preserved for audit and historical tracking

**Configuration:**
```typescript
const storage = new WebhookDLQStorage(':memory:', { 
  maxCapacity: 10000  // configurable
});
```

### Environment

| Variable | Description | Default |
|----------|-------------|---------|
| WEBHOOK_DLQ_PATH | SQLite DB path | `./data/webhook-dlq.db` |

## Poison Message Handling

A poison message is a webhook that consistently fails on every replay attempt, typically due to malformed data or an unrecoverable downstream issue.

### Behavior

- Default max replay attempts: 5
- Each failed replay increments the `replay_attempts` counter
- When `replay_attempts >= maxReplayAttempts`, the message is **permanently dropped**
- The entry is deleted from the database and cannot be recovered

**Rationale:**
- Prevents infinite retry loops
- Prevents DLQ pollution with unrecoverable messages
- Limits resource consumption on repeated failed attempts

**Configuration:**
```typescript
const storage = new WebhookDLQStorage(':memory:', { 
  maxReplayAttempts: 5  // configurable
});
```

### Tracking

The `WebhookDLQEntry` includes a `replayAttempts` field that tracks how many times an entry has been replayed:

```typescript
interface WebhookDLQEntry {
  // ... other fields
  replayAttempts: number;
}
```

## Circuit Breaker

`WebhookDeliveryService` maintains a **per-provider circuit breaker** that
prevents repeated HTTP calls to providers that are persistently down.  When a
provider's breaker is OPEN, deliveries are routed directly to the DLQ without
making a network request.

### State machine

```
CLOSED ──(failures ≥ threshold)──► OPEN
OPEN   ──(cooldown elapsed)    ──► HALF_OPEN
HALF_OPEN ──(probe succeeds)   ──► CLOSED
HALF_OPEN ──(probe fails)      ──► OPEN
```

| State      | Behaviour                                                                 |
|------------|---------------------------------------------------------------------------|
| `CLOSED`   | Normal delivery. Consecutive failures are counted.                        |
| `OPEN`     | Fast-path: delivery is skipped, payload is routed to DLQ immediately.     |
| `HALF_OPEN`| One probe attempt is allowed. Success → CLOSED, failure → OPEN.           |

### Retry / backoff coordination

The circuit breaker counts *consecutive* failures at the delivery layer.
Retry backoff (exponential with jitter, see `src/queue/webhook-retry-policy.ts`)
is applied by the queue layer *before* calling `deliver()` again.  Each call to
`deliver()` therefore represents one real attempt — the breaker and the retry
policy do not double-count.

The recommended `WEBHOOK_CB_TIMEOUT_MS` value should be **≥ the maximum retry
backoff delay** (default: 30 s) so the breaker does not re-open immediately on
the first probe after cooldown.  The default cooldown is 60 s.

### Configuration

All thresholds are read from environment variables and validated/clamped at
startup.  They are intentionally separate from the RPC circuit breaker
(`CB_*`) so webhook and RPC failure modes can be tuned independently.

| Variable | Default | Description |
|----------|---------|-------------|
| `WEBHOOK_CB_FAILURE_THRESHOLD` | `5` | Consecutive failures before opening (1–100) |
| `WEBHOOK_CB_SUCCESS_THRESHOLD` | `1` | Consecutive successes in HALF_OPEN before closing (1–20) |
| `WEBHOOK_CB_TIMEOUT_MS` | `60000` | Cooldown ms before probing (1 000–300 000) |

### Metrics

| Metric | Labels | Description |
|--------|--------|-------------|
| `webhook_breaker_state` | `provider` | Current state: 0=CLOSED, 1=OPEN, 2=HALF_OPEN |
| `webhook_delivery_attempts_total` | `status`, `provider`, `reason` | Includes `reason=circuit_open` for fast-path deliveries |

Use `webhook_breaker_state` in Grafana dashboards and alerting rules to detect
providers that are persistently down.

### Security notes

- Provider labels are sanitized to a finite allow-list (`stripe`, `github`,
  `slack`, `sendgrid`, `generic`) to prevent metric cardinality explosion.
- The `resetBreaker()` method is intended for admin use only; any API endpoint
  that exposes it must be protected behind an authenticated admin route.
- No PII or raw error messages are recorded in metrics — only the error code
  (e.g. `ECONNREFUSED`) is captured.

---

## Metrics

DLQ operations are tracked via Prometheus counters in `webhookMetrics.ts`:

| Metric | Labels | Description |
|--------|--------|-------------|
| `webhook_dlq_operations_total` | `operation` | Total DLQ operations |

**Operations tracked:**

| Operation | Description |
|-----------|-------------|
| `enqueue` | Entry added to DLQ |
| `drop_overflow` | Entry evicted due to capacity overflow |
| `drop_poison` | Entry dropped after exceeding max replay attempts |

## Security

- All endpoints require admin JWT role
- `webhookSecret` is never returned in API responses
- Replay requires a reason (min 5 chars) for audit
