# Queue Processor Catalog

Comprehensive reference for every background queue in the TalentTrust Backend
system. Covers queue names, processor files, job payloads, concurrency, retry
semantics, and an operator runbook for draining and replaying queues.

---

## Architecture Overview

All background work flows through **BullMQ** (Redis-backed), orchestrated by
the [`QueueManager`](../src/queue/queue-manager.ts) singleton. Each queue maps
1:1 to a `JobType` enum member and a dedicated processor function registered in
[`src/queue/processors/index.ts`](../src/queue/processors/index.ts).

Retry policies are managed centrally by the
[`RetryPolicyManager`](../src/queue/retry-manager.ts), which merges built-in
defaults with environment-variable overrides and enforces safety bounds.

```
                     ┌──────────────────────┐
                     │     QueueManager      │
                     │  (singleton)          │
                     └──────┬───────────────┘
                            │
        ┌───────────────────┼───────────────────────┐
        │                   │                       │
   ┌────▼─────┐       ┌────▼─────┐           ┌─────▼──────┐
   │  Queue   │       │  Worker  │           │QueueEvents │
   │ (BullMQ) │       │ (BullMQ) │           │ (BullMQ)   │
   └────┬─────┘       └────┬─────┘           └─────┬──────┘
        │                  │                       │
        │          ┌───────▼────────┐              │
        │          │   Processor    │              │
        │          │ (per job type) │              │
        │          └───────┬────────┘              │
        │                  │                       │
        │          ┌───────▼────────┐              │
        │          │ RetryPolicyMgr │              │
        │          └───────┬────────┘              │
        │                  │                       │
        ▼                  ▼                       ▼
   ┌─────────────────────────────────────────────────┐
   │                    Redis                        │
   │          (job data, state, events)              │
   └─────────────────────────────────────────────────┘
```

---

## Queue Catalog

### 1. Email Notification

| Field | Value |
|---|---|
| **Queue name** | `email-notification` |
| **JobType enum** | `JobType.EMAIL_NOTIFICATION` |
| **Processor file** | [`src/queue/processors/email-processor.ts`](../src/queue/processors/email-processor.ts) |
| **Concurrency** | `QUEUE_CONCURRENCY` (default **5**) |

#### Payload: `EmailNotificationPayload`

```ts
interface EmailNotificationPayload {
  to: string;               // Recipient email address
  subject: string;          // Email subject line
  body: string;             // Plain-text body
  templateId?: string;      // Optional template identifier
  correlationId?: string;   // Distributed tracing
  requestId?: string;       // Request-scoped tracing
}
```

#### Retry Policy

| Parameter | Value |
|---|---|
| **Max attempts** | 5 |
| **Backoff type** | exponential |
| **Initial delay** | 1,000 ms |
| **Multiplier** | 2× |
| **Jitter** | 10% |

#### Exhausted Behaviour

After 5 failed attempts, the job moves to the BullMQ **failed** state in
Redis. It is **not** routed to the Webhook DLQ (that DLQ is for webhook
delivery failures only — see [§ Webhook DLQ](#webhook-dlq)). Failed email
jobs can be listed via `QueueManager.getFailedJobs()` and replayed via
`QueueManager.reprocessFailedJob()`.

---

### 2. Contract Processing

| Field | Value |
|---|---|
| **Queue name** | `contract-processing` |
| **JobType enum** | `JobType.CONTRACT_PROCESSING` |
| **Processor file** | [`src/queue/processors/contract-processor.ts`](../src/queue/processors/contract-processor.ts) |
| **Concurrency** | `QUEUE_CONCURRENCY` (default **5**) |

#### Payload: `ContractProcessingPayload`

```ts
interface ContractProcessingPayload {
  contractId: string;                  // ≥10 characters
  action: 'create' | 'update' | 'finalize';
  metadata?: Record<string, unknown>;
  correlationId?: string;
  requestId?: string;
}
```

#### Retry Policy

| Parameter | Value |
|---|---|
| **Max attempts** | 3 |
| **Backoff type** | exponential |
| **Initial delay** | 2,000 ms |
| **Multiplier** | 2× |
| **Jitter** | 20% |

---

### 3. Reputation Update

| Field | Value |
|---|---|
| **Queue name** | `reputation-update` |
| **JobType enum** | `JobType.REPUTATION_UPDATE` |
| **Processor file** | [`src/queue/processors/reputation-processor.ts`](../src/queue/processors/reputation-processor.ts) |
| **Concurrency** | `QUEUE_CONCURRENCY` (default **5**) |

#### Payload: `ReputationUpdatePayload`

```ts
interface ReputationUpdatePayload {
  userId: string;          // ≥5 characters
  contractId: string;      // Associated contract
  rating: number;          // 1–5
  feedback?: string;
  correlationId?: string;
  requestId?: string;
}
```

#### Retry Policy

| Parameter | Value |
|---|---|
| **Max attempts** | 2 |
| **Backoff type** | fixed |
| **Delay** | 5,000 ms |

---

### 4. Reputation Recompute

| Field | Value |
|---|---|
| **Queue name** | `reputation-recompute` |
| **JobType enum** | `JobType.REPUTATION_RECOMPUTE` |
| **Processor file** | [`src/queue/processors/reputation-recompute-processor.ts`](../src/queue/processors/reputation-recompute-processor.ts) |
| **Concurrency** | `QUEUE_CONCURRENCY` (default **5**) |

#### Payload: `ReputationRecomputePayload`

```ts
interface ReputationRecomputePayload {
  batchSize?: number;                // Subjects per page (default 100)
  forceRecompute?: boolean;          // Skip 24h freshness check
  resumeFromCheckpoint?: boolean;    // Resume from last checkpoint
  correlationId?: string;
  requestId?: string;
}
```

#### Checkpointing

The recompute processor persists progress via
[`reputationCheckpointStore`](../src/models/reputation-checkpoint.store.ts).
On restart with `resumeFromCheckpoint: true`, it picks up from the last
processed subject ID. Each subject that faults is logged and skipped — a
single failure does not abort the batch.

#### Retry Policy

| Parameter | Value |
|---|---|
| **Max attempts** | 3 |
| **Backoff type** | exponential |
| **Initial delay** | 2,000 ms |
| **Multiplier** | 2× |
| **Jitter** | 20% |

---

### 5. Blockchain Sync

| Field | Value |
|---|---|
| **Queue name** | `blockchain-sync` |
| **JobType enum** | `JobType.BLOCKCHAIN_SYNC` |
| **Processor file** | [`src/queue/processors/blockchain-processor.ts`](../src/queue/processors/blockchain-processor.ts) |
| **Concurrency** | `QUEUE_CONCURRENCY` (default **5**) |

#### Payload: `BlockchainSyncPayload`

```ts
interface BlockchainSyncPayload {
  network: 'stellar' | 'soroban';
  startBlock?: number;       // Omit to resume from last cursor
  endBlock?: number;         // Omit for current chain head
  correlationId?: string;
  requestId?: string;
}
```

#### Retry Policy

| Parameter | Value |
|---|---|
| **Max attempts** | 8 |
| **Backoff type** | exponential |
| **Initial delay** | 5,000 ms |
| **Multiplier** | 1.5× |
| **Jitter** | 30% |

---

## Webhook DLQ

> **File:** [`src/queue/webhook-dlq.ts`](../src/queue/webhook-dlq.ts)

The Webhook Dead Letter Queue is a **separate** subsystem from the BullMQ
job queues above. It is backed by **SQLite** (not Redis) and stores failed
webhook delivery attempts for later inspection and replay.

| Property | Value |
|---|---|
| **Storage** | SQLite (`data/webhook-dlq.db` or `WEBHOOK_DLQ_PATH`) |
| **Max capacity** | 10,000 entries |
| **Overflow policy** | oldest-evict (removes oldest pending entry) |
| **Max replay attempts** | 5 |
| **Poison message handling** | Permanently dropped after reaching max replay attempts |

### Webhook Retry Policy

| Parameter | Value |
|---|---|
| **Max retries** | 5 |
| **Initial delay** | 1,000 ms |
| **Max delay** | 30,000 ms |
| **Multiplier** | 2× |
| **Jitter** | 10% |

### Deduplication

Each DLQ entry is keyed by a SHA-256 hash of `webhookId + JSON.stringify(payload)`.
Duplicate entries are rejected with a `DUPLICATE_ENTRY` error.

---

## Cross-Queue Configuration

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `REDIS_HOST` | `localhost` | Redis hostname |
| `REDIS_PORT` | `6379` | Redis port |
| `REDIS_PASSWORD` | *(none)* | Redis auth password |
| `QUEUE_CONCURRENCY` | `5` | Jobs processed concurrently per worker (1–100) |
| `QUEUE_DEFAULT_ATTEMPTS` | `3` | Default retry attempts (0–10) |
| `QUEUE_BACKOFF_DELAY` | `2000` | Default backoff delay in ms (1–60000) |
| `QUEUE_REMOVE_ON_COMPLETE` | `100` | Keep N completed jobs (or `true`/`false`) |
| `QUEUE_REMOVE_ON_FAIL` | `1000` | Keep N failed jobs (or `true`/`false`) |

### Per-Job-Type Timeout Overrides

| Variable | Default |
|---|---|
| `QUEUE_JOB_TIMEOUT_MS` | `30000` |
| `QUEUE_JOB_TIMEOUT_EMAIL_NOTIFICATION_MS` | `QUEUE_JOB_TIMEOUT_MS` |
| `QUEUE_JOB_TIMEOUT_CONTRACT_PROCESSING_MS` | `QUEUE_JOB_TIMEOUT_MS` |
| `QUEUE_JOB_TIMEOUT_REPUTATION_UPDATE_MS` | `QUEUE_JOB_TIMEOUT_MS` |
| `QUEUE_JOB_TIMEOUT_REPUTATION_RECOMPUTE_MS` | `QUEUE_JOB_TIMEOUT_MS` |
| `QUEUE_JOB_TIMEOUT_BLOCKCHAIN_SYNC_MS` | `QUEUE_JOB_TIMEOUT_MS` |

### Retry Policy Overrides

Override any retry parameter per job type:

```
RETRY_POLICY_{JOB_TYPE}_{PROPERTY}=value
```

Examples:

```bash
RETRY_POLICY_EMAIL_NOTIFICATION_ATTEMPTS=7
RETRY_POLICY_BLOCKCHAIN_SYNC_DELAY=8000
RETRY_POLICY_CONTRACT_PROCESSING_MULTIPLIER=3
RETRY_POLICY_REPUTATION_UPDATE_JITTER=0.15
```

Safety bounds are enforced:

| Property | Min | Max |
|---|---|---|
| `ATTEMPTS` | 1 | 10 |
| `DELAY` | 1 ms | 300,000 ms (5 min) |
| `MULTIPLIER` | 1 | 10 |
| `JITTER` | 0 | 1 |

Incoherent combinations (e.g., `MULTIPLIER` on a `fixed` backoff) are
detected and corrected with a structured log warning.

---

## Operator Runbook

### Check Queue Health

```typescript
// Programmatic
const health = await QueueManager.getInstance().getHealth();
// Returns QueueHealthInfo[] with waiting/active/completed/failed/delayed counts

// Or check the health probe
// GET /health → probes[].name === 'queue'
```

### View Failed Jobs

```typescript
const failed = await QueueManager.getInstance().getFailedJobs({
  jobType: JobType.EMAIL_NOTIFICATION,  // optional filter
  limit: 25,                             // 1–100, default 50
  offset: 0,
});
```

### Determine If a Queue Is Stuck

A queue may be stuck if:

1. **`failed` count is growing** — jobs are exhausting retries. Check
   `getRecentFailures()` for the latest errors.
2. **`active` count > 0 with no completions** — a processor may be hung.
   Check for timeout errors in structured logs (`JobTimeoutError`).
3. **`delayed` count is high** — jobs are backing off or scheduled. Normal
   during retry storms but monitor the trend.
4. **`waiting` count is growing** — the producer is outpacing the consumer.
   Consider increasing `QUEUE_CONCURRENCY`.

### Drain a Queue (Pause Consumption)

```typescript
const qm = QueueManager.getInstance();

// 1. Stop accepting new jobs
qm.stopAccepting();

// 2. Wait for active jobs to complete
await qm.drain();

// 3. Persist any checkpointable state
await qm.checkpoint();

// 4. Close workers and connections
await qm.close();
```

The shutdown sequence in `src/shutdown.ts` orchestrates these steps
automatically for the entire process.

### Replay Failed Jobs

```typescript
// Replay a single failed job (deduplicated by replay key)
const result = await QueueManager.getInstance().reprocessFailedJob(
  JobType.CONTRACT_PROCESSING,
  'failed-job-id-here',
);
// result.replayJobId — the new job's ID
// result.deduplicated — true if a replay was already in flight
```

### Replay a Whole Failed Queue

```typescript
const qm = QueueManager.getInstance();
const failedJobs = await qm.getFailedJobs({
  jobType: JobType.EMAIL_NOTIFICATION,
  limit: 100,
});

for (const entry of failedJobs) {
  const result = await qm.reprocessFailedJob(entry.jobType, entry.jobId);
  console.log(`Replayed ${entry.jobId} → ${result.replayJobId} (deduped: ${result.deduplicated})`);
}
```

### Inspect the Webhook DLQ

```typescript
const dlq = getWebhookDLQStorage();

// List pending entries
const entries = dlq.listEntries({ limit: 50, offset: 0 });

// Check deduplication
const { exists, entryId } = dlq.checkDedupe(webhookId, payload);

// Get stats
const stats = await dlq.getStats();
// { total, pending, replayed }

// Replay a DLQ entry (mark as replayed, increment attempts)
dlq.incrementReplayAttempts(entryId);
// Returns { success, attempts, maxExceeded }
// If maxExceeded: entry is permanently dropped as poison message
```

### Reset to Default Retry Policies

```typescript
const rpm = RetryPolicyManager.getInstance();
rpm.resetToDefault(JobType.EMAIL_NOTIFICATION);
```

### View Current Retry Policy Stats

```typescript
const stats = RetryPolicyManager.getInstance().getStatistics();
// {
//   totalPolicies: 5,
//   customPolicies: 2,
//   policiesByType: { ... }  // per-type: attempts, backoffType, hasCustomPolicy
// }
```

---

## Job Processing Lifecycle

```
  addJob()
     │
     ▼
 ┌───────┐    ┌────────┐    ┌───────────┐    ┌──────────┐
 │waiting│───▶│ active │───▶│ completed │───▶│ removed  │
 └───────┘    └───┬────┘    └───────────┘    │(kept N)  │
                  │                          └──────────┘
                  │ (error)
                  ▼
            ┌─────────┐
            │ failed  │──── retries remain? ───▶ delayed ──▶ active
            └────┬────┘
                 │ (exhausted)
                 ▼
          ┌──────────────┐
          │ failed (final)│  ← getFailedJobs() / reprocessFailedJob()
          └──────────────┘
```

- **Timeout:** The `QueueManager` wraps each processor in a per-job-type
  timeout. On timeout, an `AbortSignal` is sent; the attempt is failed.
- **Deduplication:** Optional `dedupeKey` prevents duplicate enqueue while
  a job is waiting/active/delayed.
- **Replay:** Failed jobs can be replayed. Replay jobs carry a
  `replay:{jobType}:{originalJobId}` deduplication key to prevent double-replay.

---

## Logging Convention

All processors MUST use the structured logger from `src/logger.ts`:

```ts
const log = createLogger({
  processor: '<name>',
  ...(payload.correlationId && { correlationId: payload.correlationId }),
  ...(payload.requestId && { requestId: payload.requestId }),
});
```

- **Info/warn:** No PII in message strings.
- **Debug:** PII allowed as structured fields.
- **Errors:** Log a `warn` before throwing to preserve correlation context.

---

## Files Reference

| File | Purpose |
|---|---|
| `src/queue/types.ts` | Job type enum, payload interfaces, result types |
| `src/queue/config.ts` | Redis config, concurrency, timeouts, env validation |
| `src/queue/retry-policy.ts` | Default retry policies per job type, override loader |
| `src/queue/retry-manager.ts` | Policy validation, merging, BullMQ job options |
| `src/queue/queue-manager.ts` | Singleton orchestrating queues, workers, lifecycle |
| `src/queue/processors/index.ts` | Processor registry mapping JobType → handler |
| `src/queue/processors/email-processor.ts` | Email delivery through pluggable transport |
| `src/queue/processors/email.transport.ts` | SMTP/SES/SendGrid/Console email transports |
| `src/queue/processors/contract-processor.ts` | Contract create/update/finalize operations |
| `src/queue/processors/reputation-processor.ts` | Rating validation and score calculation |
| `src/queue/processors/reputation-recompute-processor.ts` | Paginated score recompute with checkpoints |
| `src/queue/processors/blockchain-processor.ts` | Ledger-range blockchain event sync |
| `src/queue/webhook-dlq.ts` | SQLite-backed DLQ for webhook delivery failures |
| `src/queue/webhook-retry-policy.ts` | Exponential backoff for webhook delivery retries |
| `src/queue/index.ts` | Public module exports |
