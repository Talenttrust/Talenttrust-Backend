# Disputes Subsystem Operations Runbook

This runbook provides operational guidance for the TalentTrust disputes subsystem — configuration reference, common failure modes, alerting signals, and step-by-step recovery procedures. It is intended for operators, SREs, and on-call engineers who need to diagnose and resolve disputes-related issues in production.

---

**Metadata:**
- **Last Updated:** 2026-07-25
- **Owner:** TalentTrust Backend Team
- **Related Issue:** #745
- **Related Documentation:** [disputes.md](./disputes.md), [contracts-lifecycle.md](./contracts-lifecycle.md), [backend/authentication-authorization.md](./backend/authentication-authorization.md)

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture Summary](#architecture-summary)
3. [Configuration Reference](#configuration-reference)
4. [Dispute Lifecycle](#dispute-lifecycle)
5. [Common Failure Modes](#common-failure-modes)
6. [Alerts Reference](#alerts-reference)
7. [Diagnostic Commands](#diagnostic-commands)
8. [Recovery Procedures](#recovery-procedures)
9. [Security Notes](#security-notes)
10. [Cross-References](#cross-references)

---

## Overview

The disputes subsystem in TalentTrust handles contract disputes through two complementary mechanisms:

1. **Contract status transitions** — contracts transition to `status: "disputed"` via `PATCH /api/v1/contracts/:id`, triggering multi-channel notifications and audit trail entries.
2. **Smart-contract event ingestion** — on-chain dispute events (`dispute:initiated`, `dispute:resolved`) are indexed via `POST /api/v1/events` with idempotency guarantees.

**Business Context:**  
A dispute represents a disagreement between the client and freelancer regarding deliverable quality, payment, or contract terms. When a contract enters the `disputed` state, both parties are notified via email and web/in-app channels. Admins can resolve disputes by transitioning the contract to `active`, `completed`, or `cancelled`.

**Scope:**  
This runbook covers operational procedures for dispute state transitions, notification delivery failures, rate-limiting, and audit log queries. It does not cover contract creation, milestone management, or payment processing (see [contracts-lifecycle.md](./contracts-lifecycle.md) for those topics).

---

## Architecture Summary

The disputes subsystem is implemented across several layers rather than as a dedicated REST resource:

| Component | Path | Role |
|-----------|------|------|
| Disputes routes | `src/routes/disputes.routes.ts` | RBAC-protected stub API for CRUD operations (returns mock data) |
| Contracts controller | `src/controllers/contracts.controller.ts` | Handles contract PATCH requests for status transitions |
| Contracts service | `src/services/contracts.service.ts` | Business logic for contract updates with OCC version enforcement |
| Contracts repository | `src/repositories/contractRepository.ts` | SQLite persistence with atomic version-gated updates |
| Escrow hooks | `src/hooks/escrow.hooks.ts` | Dispatches `DISPUTE_RAISED` notifications to email and web channels |
| Notification service | `src/services/notification.service.ts` | Delivers notifications via SMTP and WebSocket/push |
| Rate limiter | `src/middleware/rateLimiter.ts` + `src/config/rateLimit.ts` | Per-client sliding-window rate limiting (disputes tier) |
| Event ingestion | `src/events/eventIngestionService.ts` | Idempotent processing of `dispute:initiated` and `dispute:resolved` events |
| Audit middleware | `src/audit/middleware.ts` | Writes `PAYMENT_DISPUTED` entries to tamper-evident audit log |
| Authorization | `src/middleware/authorization.ts` | Role-based access control (RBAC) enforcement |

### Data Flow — Initiate Dispute

```
1. Client/Freelancer: PATCH /api/v1/contracts/:id {"version": N, "status": "disputed"}
   ↓
2. requireAuth → validate JWT, attach req.user
   ↓
3. requirePermission('contracts', 'update', getContractOwnerId) → check RBAC + ownership
   ↓
4. ContractsController.updateContract()
   ↓
5. ContractsService.updateContract() → validate OCC version, enforce state transitions
   ↓
6. ContractRepository.updateWithVersion() → atomic SQL UPDATE WHERE version = N
   ↓
7. EscrowHooks.onStateTransition('active', 'disputed', payload)
   ↓
8. notificationService.sendEmail() + sendWebNotification() (concurrent via Promise.allSettled)
   ↓
9. Audit middleware → write PAYMENT_DISPUTED entry
   ↓
10. Return 200 OK with updated contract (version incremented to N+1)
```

### Data Flow — Smart-Contract Event

```
1. Indexer: POST /api/v1/events {"contractId": "...", "type": "dispute:initiated", ...}
   ↓
2. Idempotency check: dedupe key = contractId:eventType:idempotencyKey
   ↓
3. If duplicate → return 200 {"status": "duplicate"}
   ↓
4. Validate event payload against schema
   ↓
5. Persist event to smart_contract_events table
   ↓
6. Return 202 {"status": "accepted"}
```

---

## Configuration Reference

### Environment Variables

All disputes-related configuration is managed through environment variables validated at startup. Invalid values cause the process to exit with a clear error message.

| Environment Variable | Required | Default | Description | Valid Values | Defined In |
|---------------------|----------|---------|-------------|--------------|------------|
| `RL_DISPUTES_MAX` | No | `300` | Maximum requests per client per window (disputes tier) | Positive integer ≥ 1 | `src/config/rateLimit.ts` |
| `RL_DISPUTES_WINDOW_MS` | No | `60000` | Rate-limit sliding window duration in milliseconds | Positive integer ≥ 0 | `src/config/rateLimit.ts` |
| `RL_DISPUTES_ABUSE_THRESHOLD` | No | `5` | Number of violations before hard-block triggers | Positive integer ≥ 1 | `src/config/rateLimit.ts` |
| `RL_DISPUTES_BLOCK_WINDOW_MS` | No | `300000` | Violation observation window (5 minutes) | Positive integer ≥ 0 | `src/config/rateLimit.ts` |
| `RL_DISPUTES_BLOCK_DURATION_MS` | No | `600000` | Initial block duration (10 minutes) | Positive integer ≥ 0 | `src/config/rateLimit.ts` |
| `RL_DISPUTES_MAX_BLOCK_MS` | No | `86400000` | Maximum block duration (24 hours) | Positive integer ≥ 0 | `src/config/rateLimit.ts` |
| `IDEMPOTENCY_TTL_MS` | No | `3600000` | Event deduplication key TTL (1 hour) | Positive integer ≥ 0 | `src/config/env.schema.ts` |
| `JWT_SECRET` | **Yes** | — | HMAC-SHA256 signing key for JWT authentication | Min 8 characters | `src/config/env.schema.ts` |

**Rate Limit Tier Behavior:**  
The `disputes` tier uses a **shared per-client bucket** across all routes under `/api/v1/disputes`. A client that exhausts the limit on `POST /` cannot immediately call `GET /` until the window resets. This prevents abuse while allowing legitimate batch operations at ~5 req/s (300/60).

### Related Configuration

Disputes leverage the following subsystems, each with their own configuration:

- **Audit Log:** `COMPLIANCE_AUDIT_SECRET` (min 32 chars) — HMAC key for audit entry tamper-evidence
- **Notifications:** `WEBHOOK_DELIVERY_TIMEOUT_MS` (default 10000) — per-attempt timeout for webhook deliveries
- **Database:** `DB_PATH` (default `talenttrust.db`) — SQLite file path; use `:memory:` for ephemeral mode

---

## Dispute Lifecycle


Contracts move through a well-defined state machine enforced by the `ContractsService` and `ContractRepository`:

| State | Description | Valid Next States | Triggered By |
|-------|-------------|-------------------|--------------|
| `draft` | Contract created but not funded | `active`, `cancelled` | Client funds escrow |
| `active` | Escrow funded, work in progress | `completed`, `disputed`, `cancelled` | Milestone completion or dispute raised |
| `completed` | Work accepted, funds released | — (terminal) | Admin or smart contract |
| `disputed` | Disagreement raised | `active`, `completed`, `cancelled` | Client or freelancer PATCH, or `dispute:initiated` event |
| `cancelled` | Contract terminated | — (terminal) | Admin or client |

### State Transition Rules

The `active → disputed` transition is the primary dispute initiation path:

1. **Precondition:** Contract must be in `active` state. Attempting to transition from `draft` or any other state to `disputed` returns `409 conflict`.
2. **Authorization:** Requires `contracts:update` permission. Roles allowed: `admin`, `client` (ownOnly), `freelancer` (ownOnly).
3. **Optimistic Concurrency Control (OCC):** The request must include the current `version` field. The database update uses `UPDATE ... WHERE version = N`, atomically incrementing to `N+1`. Stale versions return `409 ERR_CONFLICT`.
4. **Side Effects:**
   - **Notification:** `EscrowHooks.onStateTransition('active', 'disputed', payload)` fires `DISPUTE_RAISED` event → concurrent email and web notification to `clientId` and `freelancerId`.
   - **Audit:** Middleware writes `PAYMENT_DISPUTED` entry with `previousStatus: "active"`, `newStatus: "disputed"`.

### Resolution Paths

Only `admin` role can transition a contract **out of** the `disputed` state:

| Transition | Meaning | Authorization |
|------------|---------|---------------|
| `disputed → active` | Dispute resolved, work resumes | `admin` only |
| `disputed → completed` | Dispute resolved, payment released | `admin` only |
| `disputed → cancelled` | Dispute resolved, contract terminated | `admin` only |

Attempting to resolve a dispute without `admin` role returns `403 forbidden`.

---

## Common Failure Modes

### 1. Rate Limit Exceeded (429)

**Symptom:**  
Client receives HTTP 429 with headers `X-RateLimit-Remaining: 0`, `Retry-After: <seconds>`, and body:
```json
{
  "error": {
    "code": "rate_limited",
    "message": "Too many requests. Please try again later.",
    "requestId": "req-abc123"
  }
}
```

**Cause:**  
The client has sent more than `RL_DISPUTES_MAX` (default 300) requests within the `RL_DISPUTES_WINDOW_MS` (default 60000 ms) sliding window. The rate limiter uses `X-Forwarded-For` (when behind a proxy) or `req.ip` to key per-client buckets.

**Detection:**  
- Log entry: `[rateLimiter] Client rate limit exceeded` with `ip`, `route`, `remaining: 0`
- Metric: `rate_limit_exceeded_total{tier="disputes"}` increments

**Resolution:**  
1. Wait for the window to roll off (`Retry-After` header indicates seconds remaining).
2. If the client is legitimate (e.g., batch import script), increase `RL_DISPUTES_MAX` temporarily or implement request batching on the client side.
3. If the client is abusive, check for hard-block via metric `rate_limit_blocked_total{tier="disputes"}`. Hard-block triggers after `RL_DISPUTES_ABUSE_THRESHOLD` (default 5) violations.

**Source Files:**  
- `src/middleware/rateLimiter.ts` — enforcement logic
- `src/config/rateLimit.ts` — tier configuration
- `src/lib/rateLimitStore.ts` — in-memory sliding-window store

---

### 2. Optimistic Concurrency Conflict (409 ERR_CONFLICT)

**Symptom:**  
```json
{
  "error": {
    "code": "ERR_CONFLICT",
    "message": "The resource has been modified by another request. Please read the latest version and try again.",
    "requestId": "req-xyz789"
  }
}
```

**Cause:**  
The client sent a `PATCH /api/v1/contracts/:id` with a stale `version` field. Another writer (concurrent request, admin action, or event ingestion) updated the contract first, incrementing the version. The database `UPDATE ... WHERE version = N` matched zero rows.

**Detection:**  
- Log entry: `[ContractsService] OCC conflict on contract update` with `contractId`, `expectedVersion`, `actualVersion`
- No specific metric (appears as general HTTP 409 in `http_requests_total`)

**Resolution:**  
**Client-side retry pattern:**
```bash
1. GET /api/v1/contracts/:id → read latest version N
2. PATCH /api/v1/contracts/:id {"version": N, "status": "disputed"}
3. On 409 → go to step 1 (read fresh version and retry)
```

**Operator Action:**  
If conflicts are frequent (>1% of PATCH requests), investigate:
- Concurrent writes from multiple clients
- Race between API updates and smart-contract event ingestion
- Check audit log for concurrent `CONTRACT_UPDATED` entries with the same `resourceId`

**Source Files:**  
- `src/services/contracts.service.ts` — OCC validation
- `src/repositories/contractRepository.ts` — atomic `updateWithVersion` SQL
- `src/errors/appError.ts` — `VersionConflictError` definition

---

### 3. Invalid State Transition (409 conflict)

**Symptom:**  
```json
{
  "error": {
    "code": "conflict",
    "message": "Cannot transition from 'draft' to 'disputed'. Contract must be in 'active' state.",
    "requestId": "req-def456"
  }
}
```

**Cause:**  
The client attempted an invalid state transition (e.g., `draft → disputed`). The `ContractsService` enforces a strict state machine — disputes can only be raised from the `active` state.

**Detection:**  
- Log entry: `[ContractsService] Invalid state transition` with `contractId`, `fromStatus`, `toStatus`
- No specific metric (appears as HTTP 409 in `http_requests_total`)

**Resolution:**  
1. Verify the contract's current status via `GET /api/v1/contracts/:id`.
2. If the contract is in `draft`, the client must first fund the escrow to transition to `active`.
3. If the contract is already `disputed`, `completed`, or `cancelled`, the transition is not allowed (or requires admin intervention).

**Source Files:**  
- `src/services/contracts.service.ts` — state transition validation (implicit in update logic)
- `src/repositories/contractRepository.ts` — database CHECK constraint validates status enum

---

### 4. Notification Channel Failure (Partial or Total)

**Symptom:**  
Contract transitions to `disputed` successfully (200 OK), but one or both notification channels fail. Operator observes:
- Log entry: `[EscrowHooks] One or more notification channels failed` (level `warn`) or `[EscrowHooks] All notification channels failed` (level `error`)
- Structured log includes `channels` array with per-channel `success: false` and `message` describing the failure

**Cause:**  
- **Email channel:** SMTP server unreachable, timeout, authentication failure, or invalid recipient address
- **Web/push channel:** WebSocket connection dropped, push notification service (FCM, APNs) unavailable, or invalid device token

**Detection:**  
- Log query: Search for `event: "DISPUTE_RAISED"` with `channels[].success: false`
- Metric: `notification_delivery_attempts_total{status="failure", channel="email|web"}`

**Resolution:**  
**Notification failures are non-blocking** — the contract state transition commits even if notifications fail. Recovery steps:

1. **Email channel failure:**
   - Check SMTP service health and credentials
   - Verify recipient email addresses in `users` table are valid
   - Re-send notification manually (no automated retry for historical events)

2. **Web/push channel failure:**
   - Verify WebSocket server is running and reachable
   - Check push service (FCM/APNs) credentials and quotas
   - Users can still see the dispute status in-app via `GET /api/v1/contracts/:id`

3. **Manual notification (if needed):**
   ```bash
   # Query affected contracts
   sqlite3 talenttrust.db "SELECT id, client_id, freelancer_id FROM contracts WHERE status = 'disputed' AND updated_at > datetime('now', '-1 hour');"
   
   # Send notification via admin script (if implemented) or contact users directly
   ```

**Source Files:**  
- `src/hooks/escrow.hooks.ts` — notification dispatch with `Promise.allSettled`
- `src/services/notification.service.ts` — email and web delivery logic

---

### 5. Authentication Failure (401)

**Symptom:**  
```json
{
  "error": {
    "code": "unauthorized",
    "message": "Invalid or expired token.",
    "requestId": "req-ghi789"
  }
}
```

**Cause:**  
The request is missing the `Authorization: Bearer <token>` header, the JWT is expired (`exp` claim), the signature is invalid, or the `JWT_SECRET` is misconfigured.

**Detection:**  
- Log entry: `[authorization] JWT verification failed` with `reason: "expired" | "invalid_signature" | "malformed"`
- Metric: `http_requests_total{status_code="401", route="/api/v1/disputes/*"}`

**Resolution:**  
1. **Client-side:** Ensure the access token is fresh (<15 min old). Use the refresh-token flow to obtain a new access token.
2. **Server-side:** Verify `JWT_SECRET` is set and consistent across all instances (blue/green, load balancer).
3. **Clock skew:** Check system clock synchronization via `ntpdate -q pool.ntp.org`. JWT `exp` validation is sensitive to time drift.

**Source Files:**  
- `src/middleware/authorization.ts` — `requireAuth` middleware
- `src/auth/jwtConfig.ts` — JWT verification options with algorithm pinning

---

### 6. Authorization Failure (403)

**Symptom:**  
```json
{
  "error": {
    "code": "forbidden",
    "message": "Insufficient permissions to perform this action.",
    "requestId": "req-jkl012"
  }
}
```

**Cause:**  
The authenticated user's role lacks the required permission, or an ownership check failed:
- **Role lacks permission:** E.g., `guest` role attempting `POST /api/v1/disputes` (requires `disputes:create`)
- **Ownership check failed:** E.g., `client` role attempting to update a contract owned by a different client (`ownOnly` enforcement)

**Detection:**  
- Log entry: `[authorization] Permission denied` with `user`, `resource`, `action`, `reason`
- Metric: `http_requests_total{status_code="403", route="/api/v1/disputes/*"}`

**Resolution:**  
1. **Verify role:** Decode the JWT and confirm the `role` claim matches the expected role for the action.
   ```bash
   node -e "console.log(require('jsonwebtoken').decode('<token>'))"
   ```
2. **Check RBAC matrix:** Confirm the action is permitted in `src/lib/authorization.ts` → `PERMISSION_MATRIX`.
3. **Ownership check:** For `ownOnly` permissions, verify the resource belongs to the authenticated user. Query the database:
   ```bash
   sqlite3 talenttrust.db "SELECT client_id, freelancer_id FROM contracts WHERE id = '<contract-id>';"
   ```

**Source Files:**  
- `src/middleware/authorization.ts` — `requirePermission` with ownership resolution
- `src/lib/authorization.ts` — `PERMISSION_MATRIX` and `isAuthorized` logic

---

### 7. Event Ingestion Duplicate (200 duplicate)

**Symptom:**  
`POST /api/v1/events` returns:
```json
{
  "status": "success",
  "data": {
    "status": "duplicate",
    "deduplicationKey": "c1a2b3d4:dispute:initiated:<idempotency-key>"
  }
}
```


**Cause:**  
The same event payload (identified by `contractId:eventType:idempotencyKey`) was submitted multiple times within the `IDEMPOTENCY_TTL_MS` window (default 1 hour). This is **expected behavior** for idempotent replay protection — not a failure.

**Detection:**  
- Log entry: `[eventIngestion] Duplicate event` with `deduplicationKey`
- Metric: `event_ingestion_total{status="duplicate"}`

**Resolution:**  
**No action required.** The idempotency mechanism guarantees safe replay — the duplicate submission did not modify state or trigger side effects. This is the correct outcome for retried requests or replayed event streams.

If the indexer is consistently replaying the same event, investigate:
- Cursor persistence in the indexer (ensure the cursor advances after successful ingestion)
- Event source replay logic (e.g., blockchain event re-org)

**Source Files:**  
- `src/events/idempotency.ts` — deduplication key generation and TTL enforcement
- `src/events/eventIngestionService.ts` — event processing with idempotency check

---

### 8. Database Write Failure (500 internal_error)

**Symptom:**  
```json
{
  "error": {
    "code": "internal_error",
    "message": "An unexpected error occurred. Please try again later.",
    "requestId": "req-mno345"
  }
}
```

**Cause:**  
SQLite write failed due to:
- Disk full (`SQLITE_FULL`)
- Database locked (`SQLITE_BUSY` — another process holds an exclusive lock)
- Disk I/O error (`SQLITE_IOERR`)
- Database file permissions issue

**Detection:**  
- Log entry: `[database] Write failed` with SQLite error code and message
- Metric: `database_errors_total{operation="update", table="contracts"}`

**Resolution:**  
1. **Check disk space:**
   ```bash
   df -h /path/to/talenttrust.db
   ```
2. **Check for long-running transactions:** SQLite uses file-level locking. A stalled transaction in another process can block writes.
   ```bash
   # List processes with open file handles to the database
   lsof /path/to/talenttrust.db
   ```
3. **Database integrity check:**
   ```bash
   sqlite3 talenttrust.db "PRAGMA integrity_check;"
   ```
4. **Restart the service** to release stale locks (graceful shutdown triggers WAL checkpoint).


**Source Files:**  
- `src/db/database.ts` — SQLite connection and error handling
- `src/repositories/contractRepository.ts` — write operations

---

## Alerts Reference

### Log-Based Alerts

Query structured logs for disputes-specific events. The logger emits newline-delimited JSON to `stdout` (or `stderr` for errors).

| Log Message Pattern | Level | Indicates | Recommended Action |
|---------------------|-------|-----------|---------------------|
| `event: "DISPUTE_RAISED"` + `channels[].success: false` | `warn` or `error` | Notification delivery failure | See [§5 - Failure Mode 4](#4-notification-channel-failure-partial-or-total) |
| `[ContractsService] OCC conflict` | `info` | High OCC conflict rate (>1% of PATCHes) | Investigate concurrent writes or race conditions |
| `[ContractsService] Invalid state transition` | `warn` | Client attempting invalid transition | Check client logic; may indicate API misuse |
| `[rateLimiter] Client rate limit exceeded` + `tier: "disputes"` | `warn` | Rate limit hit | Monitor for abuse; adjust `RL_DISPUTES_MAX` if legitimate traffic |
| `[rateLimiter] Client hard-blocked` + `tier: "disputes"` | `error` | Abuse threshold exceeded | Investigate client IP; may be a bot or DDoS attempt |
| `[database] Write failed` | `error` | Database write error | See [§5 - Failure Mode 8](#8-database-write-failure-500-internal_error) |

### Prometheus Metrics

The following metrics are exported at `GET /metrics`:

| Metric | Labels | Description | Alert Threshold |
|--------|--------|-------------|-----------------|
| `http_requests_total` | `status_code`, `route`, `method` | Total HTTP requests | `status_code="429"` sustained rate > 10 req/min → warning |
| `http_request_duration_seconds` | `route`, `status_code` | Request latency histogram | p99 > 2s → warning |
| `rate_limit_exceeded_total` | `tier` | Rate limit violations | `tier="disputes"` rate > 5 req/min → investigate |
| `rate_limit_blocked_total` | `tier` | Hard-blocks triggered | Any value > 0 → critical alert |
| `notification_delivery_attempts_total` | `status`, `channel` | Notification delivery attempts | `status="failure"` sustained rate > 5% → warning |
| `event_ingestion_total` | `status` | Event ingestion outcomes | `status="invalid"` rate > 1% → warning |
| `database_errors_total` | `operation`, `table` | Database operation errors | Any value > 0 → critical alert |

### Suggested Alerting Rules

```yaml
# Rate limit abuse (disputes tier)
- alert: DisputesRateLimitAbuse
  expr: rate(rate_limit_exceeded_total{tier="disputes"}[5m]) > 0.1
  for: 10m
  severity: warning
  annotations:
    summary: "High rate-limit violations on disputes endpoints"

# Hard-block triggered
- alert: DisputesRateLimitHardBlock
  expr: rate(rate_limit_blocked_total{tier="disputes"}[5m]) > 0
  for: 1m
  severity: critical
  annotations:
    summary: "Client hard-blocked on disputes endpoints (abuse threshold exceeded)"

# Notification delivery failures
- alert: DisputeNotificationFailureHigh
  expr: rate(notification_delivery_attempts_total{status="failure"}[10m]) > 0.05
  for: 15m
  severity: warning
  annotations:
    summary: "High notification delivery failure rate (>5% over 10 min)"

# OCC conflicts (proxy for concurrent write pressure)
- alert: DisputesOCCConflictsHigh
  expr: rate(http_requests_total{status_code="409",route=~"/api/v1/contracts/.*"}[5m]) > 0.01
  for: 10m
  severity: warning
  annotations:
    summary: "High OCC conflict rate on contracts (>1% of PATCH requests)"

# Database write errors
- alert: DatabaseWriteFailure
  expr: rate(database_errors_total{operation="update"}[5m]) > 0
  for: 1m
  severity: critical
  annotations:
    summary: "Database write failures detected"
```

---

## Diagnostic Commands

### Query Disputed Contracts

```bash
# List all contracts currently in disputed state
sqlite3 talenttrust.db "SELECT id, title, client_id, freelancer_id, version, created_at FROM contracts WHERE status = 'disputed' ORDER BY created_at DESC;"

# Count disputed contracts
sqlite3 talenttrust.db "SELECT COUNT(*) AS disputed_count FROM contracts WHERE status = 'disputed';"

# Find contracts transitioned to disputed in the last 24 hours
sqlite3 talenttrust.db "
SELECT id, title, status, version, created_at
FROM contracts
WHERE status = 'disputed'
  AND updated_at > datetime('now', '-1 day')
ORDER BY updated_at DESC;
"
```

### Query Audit Log for Disputes

```bash
# Find all PAYMENT_DISPUTED audit entries
sqlite3 talenttrust.db "SELECT id, timestamp, action, actor, resource_id, metadata FROM audit_log WHERE action = 'PAYMENT_DISPUTED' ORDER BY timestamp DESC LIMIT 20;"

# Find disputes by specific contract
sqlite3 talenttrust.db "
SELECT timestamp, action, actor, metadata
FROM audit_log
WHERE action = 'PAYMENT_DISPUTED'
  AND resource_id = '<contract-id>'
ORDER BY timestamp DESC;
"
```

### Query Event Ingestion History

```bash
# Find dispute-related smart-contract events
curl -s -H "Authorization: Bearer <admin-token>" \
  "http://localhost:3001/api/v1/contracts/<contract-id>/history" | jq '.data[] | select(.type | contains("dispute"))'

# Or query the database directly
sqlite3 talenttrust.db "
SELECT eventId, contractId, eventType, timestamp, payload
FROM smart_contract_events
WHERE contractId = '<contract-id>'
  AND eventType IN ('dispute:initiated', 'dispute:resolved')
ORDER BY timestamp DESC;
"
```

### Check Rate Limit State

```bash
# Query rate limit store (in-memory, accessible via admin endpoint if exposed)
# Alternatively, check metrics:
curl -s http://localhost:3001/metrics | grep 'rate_limit_exceeded_total{tier="disputes"}'
curl -s http://localhost:3001/metrics | grep 'rate_limit_blocked_total{tier="disputes"}'
```

### Check Notification Delivery Status

```bash
# Query notification metrics
curl -s http://localhost:3001/metrics | grep 'notification_delivery_attempts_total{channel="email"}'
curl -s http://localhost:3001/metrics | grep 'notification_delivery_attempts_total{channel="web"}'

# Search logs for failed notifications
# (assumes logs are aggregated in a central logging system like Splunk, Datadog, or ELK)
# Example Datadog query:
# service:talenttrust-backend level:warn event:DISPUTE_RAISED channels.success:false
```

### Database Health Check

```bash
# Check database file size and integrity
ls -lh talenttrust.db
sqlite3 talenttrust.db "PRAGMA integrity_check;"

# Check for locked transactions
sqlite3 talenttrust.db "PRAGMA wal_checkpoint(PASSIVE);"

# Verify contracts table schema
sqlite3 talenttrust.db ".schema contracts"
```

---

## Recovery Procedures

### Procedure 1: Resolve OCC Conflict Loop

**When to use:** Clients are stuck in an OCC conflict retry loop (receiving 409 repeatedly).

**Preconditions:** Contract exists and is in a valid state.

**Steps:**

1. **Identify the contract:**
   ```bash
   sqlite3 talenttrust.db "SELECT id, version, status, updated_at FROM contracts WHERE id = '<contract-id>';"
   ```
2. **Check for stuck transactions:** If `version` is incrementing rapidly but state is not changing, a background process may be updating the contract.
3. **Manual intervention (admin-only):**
   ```bash
   # Force a state transition with admin JWT (bypasses ownership check)
   curl -X PATCH http://localhost:3001/api/v1/contracts/<contract-id> \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer <admin-token>" \
     -d '{"version": <current-version>, "status": "disputed"}'
   ```
4. **Verify resolution:**
   ```bash
   sqlite3 talenttrust.db "SELECT version, status FROM contracts WHERE id = '<contract-id>';"
   ```

**Expected Outcome:** Contract transitions to `disputed` with version incremented by 1.

**Rollback:** If the manual transition was incorrect, use admin PATCH to revert to the previous state (requires knowledge of the desired state).

---

### Procedure 2: Recover from Rate Limit Hard-Block

**When to use:** A legitimate client has been hard-blocked (abuse threshold exceeded).

**Preconditions:** Confirm the client is not malicious (check recent request patterns and logs).

**Steps:**

1. **Identify the blocked client:**
   ```bash
   # Search logs for hard-block events
   grep "Client hard-blocked" /var/log/talenttrust-backend/*.log | grep "tier: disputes"
   ```
2. **Clear the block (requires code change):** The current `RateLimitStore` implementation does not expose a manual unblock API. Recovery options:
   - **Wait for block duration to expire** (`RL_DISPUTES_BLOCK_DURATION_MS`, default 10 minutes)
   - **Restart the service** to clear the in-memory store (all rate-limit state is ephemeral)
   - **Add unblock endpoint** (future enhancement)

3. **Prevent recurrence:**
   - If the client needs higher throughput, increase `RL_DISPUTES_MAX` or `RL_DISPUTES_WINDOW_MS`
   - If the client is batching requests, implement exponential backoff and respect `Retry-After` headers

**Expected Outcome:** Client regains access after block duration expires or service restart.

**Rollback:** N/A (block is a safety mechanism).

---

### Procedure 3: Manually Trigger Notifications for Failed Deliveries

**When to use:** Notifications failed during dispute initiation, and users need to be informed.

**Preconditions:** Contract is in `disputed` state, but notification logs show delivery failures.

**Steps:**

1. **Identify affected contracts:**
   ```bash
   sqlite3 talenttrust.db "
   SELECT id, client_id, freelancer_id, title
   FROM contracts
   WHERE status = 'disputed'
     AND updated_at > datetime('now', '-1 hour')
   ORDER BY updated_at DESC;
   "
   ```

2. **Query user emails:**
   ```bash
   sqlite3 talenttrust.db "
   SELECT id, email FROM users WHERE id IN (
     SELECT client_id FROM contracts WHERE id = '<contract-id>'
     UNION
     SELECT freelancer_id FROM contracts WHERE id = '<contract-id>'
   );
   "
   ```

3. **Resend notifications (if automation exists):**
   - If the codebase includes a manual notification trigger endpoint, call it:
     ```bash
     curl -X POST http://localhost:3001/api/v1/admin/notifications/resend \
       -H "Content-Type: application/json" \
       -H "Authorization: Bearer <admin-token>" \
       -d '{"contractId": "<contract-id>", "event": "DISPUTE_RAISED"}'
     ```
   - **If no endpoint exists**, send notifications manually via email/SMS or contact users directly.

4. **Verify delivery:**
   - Check email delivery logs or notification service dashboards
   - Query notification repository (if implemented):
     ```bash
     sqlite3 talenttrust.db "SELECT * FROM notifications WHERE user_id IN ('<client-id>', '<freelancer-id>') ORDER BY created_at DESC LIMIT 10;"
     ```

**Expected Outcome:** Users receive notifications and are aware of the dispute status.

**Rollback:** N/A (notifications are idempotent).

---

### Procedure 4: Resolve Invalid State Transition

**When to use:** Client reports 409 conflict with message "Cannot transition from X to Y".

**Preconditions:** Contract exists and is in state X.

**Steps:**

1. **Verify current state:**
   ```bash
   sqlite3 talenttrust.db "SELECT id, status, version FROM contracts WHERE id = '<contract-id>';"
   ```

2. **Determine valid path:**
   - If `draft` → transition to `active` first (fund escrow), then to `disputed`
   - If `completed` or `cancelled` → dispute cannot be raised (terminal state)
   - If already `disputed` → resolution requires admin action

3. **Client remediation:**
   - Return guidance to client: "Contract must be in 'active' state to raise a dispute. Current state: '<current-state>'."
   - If the contract is stuck in an invalid state due to a bug, use admin PATCH to correct it.

**Expected Outcome:** Client follows the correct state transition path.

**Rollback:** N/A (validation is correct by design).

---

### Procedure 5: Database Recovery from Disk Full

**When to use:** Database writes fail with `SQLITE_FULL` error.

**Preconditions:** Disk space exhausted.

**Steps:**

1. **Check disk usage:**
   ```bash
   df -h /path/to/talenttrust.db
   ```

2. **Free disk space:**
   - Archive old logs: `tar -czf logs-$(date +%Y%m%d).tar.gz /var/log/talenttrust-backend/*.log && rm /var/log/talenttrust-backend/*.log.1`
   - Purge expired retention data (if retention subsystem is active)
   - Move database backups to external storage

3. **Restart the service:**
   ```bash
   npm run deploy:restart:blue
   npm run deploy:restart:green
   ```

4. **Verify recovery:**
   ```bash
   # Test a write operation
   curl -X POST http://localhost:3001/api/v1/disputes \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer <admin-token>" \
     -d '{"contractId": "<test-contract-id>", "reason": "disk recovery test"}'
   ```

**Expected Outcome:** Writes succeed, disk usage stabilized.

**Rollback:** If cleanup caused issues, restore from backups.

---

### Procedure 6: Audit Log Query for Compliance

**When to use:** Compliance team or auditors request a report of all disputes within a time range.

**Preconditions:** Audit middleware is enabled and writing `PAYMENT_DISPUTED` entries.

**Steps:**

1. **Export audit log:**
   ```bash
   # NDJSON format (default)
   curl -H "Authorization: Bearer <admin-or-auditor-token>" \
     "http://localhost:3001/api/v1/audit/export?action=PAYMENT_DISPUTED&from=2026-01-01T00:00:00.000Z&to=2026-12-31T23:59:59.999Z" \
     > disputes_audit_2026.ndjson

   # CSV format
   curl -H "Authorization: Bearer <admin-or-auditor-token>" \
     -H "Accept: text/csv" \
     "http://localhost:3001/api/v1/audit/export?action=PAYMENT_DISPUTED&from=2026-01-01T00:00:00.000Z&to=2026-12-31T23:59:59.999Z" \
     > disputes_audit_2026.csv
   ```

2. **Validate export:**
   ```bash
   # Count entries
   wc -l disputes_audit_2026.ndjson

   # Verify no PII leakage (redaction should mask email addresses)
   grep -E '[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}' disputes_audit_2026.csv
   # Expected: Masked format like "a***e@example.com"
   ```

3. **Deliver to auditors** via secure channel (encrypted email, secure file share).

**Expected Outcome:** Auditors receive a tamper-evident, time-bounded export of all dispute events.

**Rollback:** N/A (read-only operation).

---

## Security Notes

### PII Handling


- **Logs:** Email addresses, user IDs, and contract IDs must **never** appear in `message` strings at `info` or `warn` level. They may be logged at `debug` level as structured fields (already redacted by the logger's built-in sanitizer).
- **Audit Log:** Email addresses in audit `metadata` are partially masked before export (`a***e@example.com`). Raw values are never returned via the REST API.
- **Database Queries:** Example queries in this runbook use placeholders like `<contract-id>`. Operators must sanitize query results before sharing externally.

### Notification Signing

- Email notifications include a `disputeId` or `contractId` but **do not** include sensitive contract terms or financial details in the email body.
- Web/push notifications should use opaque identifiers and require the user to authenticate before viewing full dispute details in-app.

### RBAC Enforcement

- **Admin-only resolution:** Only the `admin` role can transition contracts **out of** the `disputed` state. This prevents unauthorized dispute closure.
- **Ownership checks:** Non-admin roles (`client`, `freelancer`) can only initiate disputes on contracts they own (`clientId` or `freelancerId` matches `req.user.id`).

### Audit Trail Integrity

- The audit log uses a tamper-evident hash chain: each entry includes `previousHash` (SHA-256 of the prior entry) and `hash` (SHA-256 of current entry fields + `previousHash`).
- Modification of any historical entry breaks the chain, detectable via `GET /api/v1/audit/integrity`.
- Operators must **never** manually edit audit entries in the database. Use the integrity check endpoint after any database maintenance.

### Rate Limiting as DoS Mitigation

- The `disputes` rate-limit tier (300 req/min per client) prevents abuse while allowing legitimate batch operations.
- Hard-block triggers after `RL_DISPUTES_ABUSE_THRESHOLD` (default 5) violations, escalating block duration exponentially up to `RL_DISPUTES_MAX_BLOCK_MS` (24 hours).
- In production, ensure `trust proxy` is configured in Express so `req.ip` reflects the real client IP (not the load balancer).

---

## Cross-References

### Related Documentation

- **[docs/disputes.md](./disputes.md)** — Full API reference for disputes endpoints, event ingestion, and audit log queries
- **[docs/contracts-lifecycle.md](./contracts-lifecycle.md)** — Contract state machine, OCC semantics, and bounds enforcement
- **[docs/backend/authentication-authorization.md](./backend/authentication-authorization.md)** — RBAC role matrix and permission enforcement
- **[docs/EVENT_INGESTION_IDEMPOTENCY.md](./EVENT_INGESTION_IDEMPOTENCY.md)** — Idempotency TTL, deduplication keys, and replay semantics
- **[docs/backend/audit-log.md](./backend/audit-log.md)** — Audit trail architecture, tamper-evidence, and export API
- **[docs/backend/notifications.md](./backend/notifications.md)** — Notification channel architecture and delivery guarantees
- **[docs/email-notifications.md](./email-notifications.md)** — Email transport configuration and template rendering
- **[docs/backend/error-handling.md](./backend/error-handling.md)** — Standard error envelope and status-code policy

### Source Code References


| Component | File Path | Purpose |
|-----------|-----------|---------|
| Disputes routes | `src/routes/disputes.routes.ts` | RBAC-protected REST API (stub implementation) |
| Contracts controller | `src/controllers/contracts.controller.ts` | HTTP handler for contract PATCH requests |
| Contracts service | `src/services/contracts.service.ts` | Business logic with OCC enforcement |
| Contracts repository | `src/repositories/contractRepository.ts` | SQLite persistence with atomic updates |
| Escrow hooks | `src/hooks/escrow.hooks.ts` | State transition → notification dispatch |
| Notification service | `src/services/notification.service.ts` | Multi-channel delivery (email + web) |
| Event ingestion | `src/events/eventIngestionService.ts` | Idempotent smart-contract event processing |
| Idempotency store | `src/db/idempotencyStore.ts` | TTL-based deduplication key storage |
| Authorization middleware | `src/middleware/authorization.ts` | JWT validation and RBAC enforcement |
| Rate limiter | `src/middleware/rateLimiter.ts` | Sliding-window per-client rate limiting |
| Rate limit config | `src/config/rateLimit.ts` | Disputes tier configuration |
| Logger | `src/logger.ts` | Structured JSON logging with PII redaction |
| Database migrations | `src/db/migrations.ts` | Schema versioning (contracts table in migration v1) |
| Audit middleware | `src/audit/middleware.ts` | Tamper-evident audit trail writer |

### Architecture Decision Records (ADRs)

If your project maintains ADRs, link relevant decisions here:
- ADR-XXX: Contract state machine and dispute lifecycle (if exists)
- ADR-XXX: Idempotency guarantees for event ingestion (if exists)
- ADR-XXX: RBAC model and permission matrix (if exists)

---

## How to Keep This Runbook Accurate

This runbook must be updated whenever the disputes subsystem changes. Maintainers are responsible for keeping the following sections in sync with code:

| Section | Update Trigger | Verification Method |
|---------|----------------|---------------------|
| Configuration Reference | New env var added or default changed | Verify against `src/config/rateLimit.ts`, `src/config/env.schema.ts` |
| Dispute Lifecycle | New status added or transition rule changed | Verify against `src/db/migrations.ts` (CHECK constraint), `src/services/contracts.service.ts` |
| Common Failure Modes | New error code or failure path introduced | Review test suite, integration tests, and error handling code |
| Alerts Reference | New metric added or alert threshold changed | Verify against `src/observability/metrics-service.ts`, Prometheus scrape config |
| Diagnostic Commands | Database schema changed | Verify queries against `sqlite3 talenttrust.db ".schema"` |
| Recovery Procedures | New admin endpoint or operational tool added | Verify against `src/routes/admin.routes.ts` |
| Security Notes | Auth model or RBAC rules changed | Verify against `src/lib/authorization.ts` → `PERMISSION_MATRIX` |

**Update checklist:**
1. Read the relevant source files identified above.
2. Verify every configuration key, metric name, log message, and SQL query in the runbook against the current codebase.
3. Update the **Last Updated** date and **Version** in the metadata block at the top.
4. Add a changelog entry if the runbook structure changes significantly.

**Review cadence:**  
Review this runbook during the following events:
- Every major release (quarterly)
- After any disputes-related incident or postmortem
- When onboarding new SRE or operations team members

---

**End of Runbook**

