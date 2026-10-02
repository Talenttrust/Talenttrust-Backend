# Disputes API

TalentTrust disputes are not managed through a dedicated `/api/v1/disputes` resource. They are surfaced through two existing infrastructure paths:

1. **Contract status transitions** — a contract moves to `status: "disputed"` via `PATCH /api/v1/contracts/:id`.
2. **Smart-contract event ingestion** — on-chain dispute lifecycle events (`dispute:initiated`, `dispute:resolved`) are indexed via `POST /api/v1/events`.

Both paths produce audit trail entries (`PAYMENT_DISPUTED`) and trigger multi-channel notifications (`DISPUTE_RAISED`) through the escrow hooks layer.

---

## Table of Contents

- [Overview](#overview)
- [Access Control](#access-control)
- [Dispute Lifecycle](#dispute-lifecycle)
- [Endpoints](#endpoints)
  - [Initiate a Dispute](#1-initiate-a-dispute)
  - [Resolve a Dispute](#2-resolve-a-dispute)
  - [Read Dispute State](#3-read-dispute-state)
  - [Ingest a Smart-Contract Dispute Event](#4-ingest-a-smart-contract-dispute-event)
  - [Validate a Dispute Event (Dry-Run)](#5-validate-a-dispute-event-dry-run)
  - [Query Dispute Audit Log](#6-query-dispute-audit-log)
  - [Get Contract Event History](#7-get-contract-event-history)
- [Error Codes](#error-codes)
- [Notifications](#notifications)

---

## Overview

| Operation | Method | Path | Auth |
|---|---|---|---|
| Initiate dispute | `PATCH` | `/api/v1/contracts/:id` | Bearer token (client/freelancer/admin) |
| Resolve dispute | `PATCH` | `/api/v1/contracts/:id` | Bearer token (admin) |
| Read dispute state | `GET` | `/api/v1/contracts/:id` | Bearer token |
| Ingest smart-contract event | `POST` | `/api/v1/events` | Bearer token |
| Validate event (dry-run) | `POST` | `/api/v1/events/validate` | Bearer token |
| Query audit log for disputes | `GET` | `/api/v1/audit` | Bearer token (admin/auditor) |
| Contract event history | `GET` | `/api/v1/contracts/:id/history` | Bearer token |

---

## Access Control

Authentication uses a `Bearer <token>` header. The RBAC `disputes` resource governs permissions:

| Role | Allowed Actions |
|---|---|
| `admin` | create, read, update, delete |
| `freelancer` | create, read |
| `client` | create, read |
| `auditor` | read (via audit log only) |
| `guest` | — (no access) |

> **Note:** "create" in this context means transitioning a contract to `status: "disputed"`. "update" / "delete" are admin-only escalation and resolution actions.

Demo tokens for local testing:
- `demo-admin-token` — admin role, full access
- `demo-user-token` — client/freelancer role, limited to create + read

---

## Dispute Lifecycle

A contract moves through a well-defined state machine. The `disputed` state is reachable only from `active`:

```
draft → active → disputed → (resolved back to active/completed via admin PATCH)
                 └── active → completed (no dispute)
                 └── active → cancelled
```

The `active → disputed` transition fires the `DISPUTE_RAISED` escrow hook, which fans out an email notification and a web/in-app notification to both parties.

---

## Endpoints

### 1. Initiate a Dispute

Transitions a contract from `active` to `disputed`. This is the primary mechanism for raising a dispute.

```
PATCH /api/v1/contracts/:id
```

**Auth:** Bearer token — `client`, `freelancer`, or `admin` owning the contract.

**Path parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | `string` (UUID) | Yes | Contract UUID |

**Request body:**

```json
{
  "version": 2,
  "status": "disputed"
}
```

| Field | Type | Required | Constraints |
|---|---|---|---|
| `version` | `integer` | Yes | Must match the contract's current OCC version (non-negative integer). |
| `status` | `"disputed"` | Yes | The target status. All other fields are optional partial updates. |

Additional updatable fields (`title`, `description`, `budget`, `deadline`, `terms`, `milestones`) may be included in the same PATCH to update contract details at the time of dispute.

**Response — 200 OK:**

```json
{
  "status": "success",
  "data": {
    "id": "c1a2b3d4-e5f6-7890-abcd-ef1234567890",
    "title": "Logo Design",
    "clientId": "user-client-uuid",
    "freelancerId": "user-freelancer-uuid",
    "amount": 5000000,
    "status": "disputed",
    "createdAt": "2026-07-01T10:00:00.000Z",
    "version": 3
  }
}
```

**Full example:**

```bash
curl -X PATCH https://api.talenttrust.io/api/v1/contracts/c1a2b3d4-e5f6-7890-abcd-ef1234567890 \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer demo-user-token" \
  -d '{
    "version": 2,
    "status": "disputed"
  }'
```

**Side effects:**
- Contract `version` is incremented by 1.
- `DISPUTE_RAISED` (`KeyEscrowEvent`) fires → email + web notification to both parties.
- `PAYMENT_DISPUTED` audit entry is written (when the audit middleware is active).

---

### 2. Resolve a Dispute

Transitions a contract from `disputed` back to `active` or forward to `completed` or `cancelled`. Only `admin` role can change status away from `disputed`.

```
PATCH /api/v1/contracts/:id
```

**Auth:** Bearer token — `admin` only for resolving a dispute.

**Request body:**

```json
{
  "version": 3,
  "status": "completed"
}
```

| Field | Type | Required | Valid values |
|---|---|---|---|
| `version` | `integer` | Yes | Current OCC version of the contract |
| `status` | `string` | Yes | `"active"`, `"completed"`, or `"cancelled"` |

**Response — 200 OK:**

```json
{
  "status": "success",
  "data": {
    "id": "c1a2b3d4-e5f6-7890-abcd-ef1234567890",
    "title": "Logo Design",
    "clientId": "user-client-uuid",
    "freelancerId": "user-freelancer-uuid",
    "amount": 5000000,
    "status": "completed",
    "createdAt": "2026-07-01T10:00:00.000Z",
    "version": 4
  }
}
```

**Full example:**

```bash
curl -X PATCH https://api.talenttrust.io/api/v1/contracts/c1a2b3d4-e5f6-7890-abcd-ef1234567890 \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer demo-admin-token" \
  -d '{
    "version": 3,
    "status": "completed"
  }'
```

---

### 3. Read Dispute State

Returns the full contract record. Inspect the `status` field to determine if the contract is currently in dispute.

```
GET /api/v1/contracts/:id
```

**Auth:** Bearer token — owner (`clientId` match) or `admin`.

**Path parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | `string` (UUID) | Yes | Contract UUID |

**Response — 200 OK:**

```json
{
  "status": "success",
  "data": {
    "id": "c1a2b3d4-e5f6-7890-abcd-ef1234567890",
    "title": "Logo Design",
    "clientId": "user-client-uuid",
    "freelancerId": "user-freelancer-uuid",
    "amount": 5000000,
    "status": "disputed",
    "createdAt": "2026-07-01T10:00:00.000Z",
    "version": 3
  }
}
```

**Filter contracts by status (list all disputed):**

```
GET /api/v1/contracts?status=disputed
```

```bash
curl -H "Authorization: Bearer demo-admin-token" \
  "https://api.talenttrust.io/api/v1/contracts?status=disputed&page=1&limit=20"
```

---

### 4. Ingest a Smart-Contract Dispute Event

Processes on-chain dispute lifecycle events emitted by the Soroban escrow contract. The two dispute-relevant event types are `dispute:initiated` and `dispute:resolved`.

```
POST /api/v1/events
```

**Auth:** Bearer token.

**Headers:**

| Header | Required | Description |
|---|---|---|
| `Content-Type` | Yes | `application/json` |
| `Idempotency-Key` | Recommended | Unique key (UUID or hash) to prevent duplicate processing. Replays within TTL return the cached outcome. |

**Request body — `dispute:initiated`:**

```json
{
  "contractId": "c1a2b3d4-e5f6-7890-abcd-ef1234567890",
  "type": "dispute:initiated",
  "sequence": 1,
  "ledger": 4200000,
  "timestamp": "2026-07-15T08:30:00.000Z",
  "payload": {
    "reason": "Deliverable does not match agreed specifications",
    "raisedBy": "user-freelancer-uuid"
  }
}
```

**Request body — `dispute:resolved`:**

```json
{
  "contractId": "c1a2b3d4-e5f6-7890-abcd-ef1234567890",
  "type": "dispute:resolved",
  "sequence": 2,
  "ledger": 4201500,
  "timestamp": "2026-07-18T14:00:00.000Z",
  "payload": {
    "resolution": "partial_refund",
    "resolvedBy": "admin-user-uuid",
    "clientRefundAmount": 2000000,
    "freelancerReleaseAmount": 3000000
  }
}
```

**Event payload schema:**

| Field | Type | Required | Description |
|---|---|---|---|
| `contractId` | `string` | Yes | UUID of the related contract |
| `type` | `string` | Yes | `"dispute:initiated"` or `"dispute:resolved"` |
| `sequence` | `integer` | Yes | Monotonically increasing per-contract sequence number |
| `ledger` | `integer` | Yes | Stellar/Soroban ledger sequence number |
| `timestamp` | `string` (ISO-8601) | Yes | Event timestamp |
| `payload` | `object` | Yes | Arbitrary structured metadata about the event |

**Response — 202 Accepted (new event):**

```json
{
  "status": "success",
  "data": {
    "status": "accepted",
    "deduplicationKey": "c1a2b3d4-e5f6-7890-abcd-ef1234567890:dispute:initiated:idempotency-key-value"
  }
}
```

**Response — 200 OK (duplicate / replay):**

```json
{
  "status": "success",
  "data": {
    "status": "duplicate",
    "deduplicationKey": "c1a2b3d4-e5f6-7890-abcd-ef1234567890:dispute:initiated:idempotency-key-value"
  }
}
```

**Full example — initiate dispute event:**

```bash
curl -X POST https://api.talenttrust.io/api/v1/events \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer demo-admin-token" \
  -H "Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000" \
  -d '{
    "contractId": "c1a2b3d4-e5f6-7890-abcd-ef1234567890",
    "type": "dispute:initiated",
    "sequence": 1,
    "ledger": 4200000,
    "timestamp": "2026-07-15T08:30:00.000Z",
    "payload": {
      "reason": "Deliverable does not match agreed specifications",
      "raisedBy": "user-freelancer-uuid"
    }
  }'
```

**Deduplication:** Events are keyed by `contractId:eventType:idempotencyKey`. Replaying the same key within the idempotency TTL (default 1 hour, configurable via `IDEMPOTENCY_TTL_MS`) returns `duplicate` with `200`. After the TTL expires the key is eligible for eviction and fresh processing.

---

### 5. Validate a Dispute Event (Dry-Run)

Validates the event payload against the schema without persisting or processing it. Useful for preflight checks.

```
POST /api/v1/events/validate
```

**Auth:** Bearer token.

**Request body:** Same structure as `POST /api/v1/events`.

**Response — 200 OK (valid):**

```json
{
  "status": "success",
  "data": {
    "valid": true,
    "event": {
      "contractId": "c1a2b3d4-e5f6-7890-abcd-ef1234567890",
      "type": "dispute:initiated",
      "sequence": 1,
      "ledger": 4200000,
      "timestamp": "2026-07-15T08:30:00.000Z",
      "payload": { "reason": "..." }
    }
  }
}
```

**Response — 400 Bad Request (invalid):**

```json
{
  "status": "error",
  "error": {
    "code": "invalid_event_payload",
    "message": "Event type 'dispute:unknown' is not a recognised event type",
    "requestId": "req-abc123"
  }
}
```

**Full example:**

```bash
curl -X POST https://api.talenttrust.io/api/v1/events/validate \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer demo-user-token" \
  -d '{
    "contractId": "c1a2b3d4-e5f6-7890-abcd-ef1234567890",
    "type": "dispute:initiated",
    "sequence": 1,
    "ledger": 4200000,
    "timestamp": "2026-07-15T08:30:00.000Z",
    "payload": { "reason": "Deliverable mismatch" }
  }'
```

---

### 6. Query Dispute Audit Log

Returns the immutable audit trail filtered to `PAYMENT_DISPUTED` events. Requires `admin` or `auditor` role.

```
GET /api/v1/audit
```

**Auth:** Bearer token — `admin` or `auditor`.

**Query parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `action` | `string` | No | Filter by action. Use `PAYMENT_DISPUTED` to scope to disputes. |
| `resource` | `string` | No | Resource type, e.g. `contract`. |
| `resourceId` | `string` | No | Specific contract UUID. |
| `from` | ISO-8601 | No | Start of time range (inclusive). |
| `to` | ISO-8601 | No | End of time range (inclusive). |
| `severity` | `string` | No | `INFO`, `WARNING`, or `CRITICAL`. |
| `actor` | `string` | No | Filter by the user ID who triggered the event. |
| `limit` | `integer` | No | Max results per page. |
| `offset` | `integer` | No | Pagination offset. |

**Response — 200 OK:**

```json
{
  "status": "success",
  "data": [
    {
      "id": "audit-entry-uuid",
      "timestamp": "2026-07-15T08:31:00.000Z",
      "action": "PAYMENT_DISPUTED",
      "severity": "WARNING",
      "actor": "user-freelancer-uuid",
      "resource": "contract",
      "resourceId": "c1a2b3d4-e5f6-7890-abcd-ef1234567890",
      "metadata": {
        "previousStatus": "active",
        "newStatus": "disputed"
      },
      "ipAddress": "203.0.113.42",
      "correlationId": "corr-xyz789",
      "hash": "sha256hexdigest...",
      "previousHash": "sha256hexdigest..."
    }
  ]
}
```

**Full example — all disputes for a specific contract:**

```bash
curl -H "Authorization: Bearer demo-admin-token" \
  "https://api.talenttrust.io/api/v1/audit?action=PAYMENT_DISPUTED&resourceId=c1a2b3d4-e5f6-7890-abcd-ef1234567890"
```

**Export as NDJSON/CSV (for compliance):**

```bash
# NDJSON (default)
curl -H "Authorization: Bearer demo-admin-token" \
  "https://api.talenttrust.io/api/v1/audit/export?action=PAYMENT_DISPUTED"

# CSV
curl -H "Authorization: Bearer demo-admin-token" \
  "https://api.talenttrust.io/api/v1/audit/export?action=PAYMENT_DISPUTED" \
  -H "Accept: text/csv"
```

See [docs/backend/audit-log.md](./backend/audit-log.md) for full audit API documentation.

---

### 7. Get Contract Event History

Returns the complete indexed event history for a contract, including dispute events.

```
GET /api/v1/contracts/:contractId/history
```

**Auth:** Bearer token.

**Path parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `contractId` | `string` | Yes | UUID of the contract |

**Response — 200 OK:**

```json
{
  "status": "success",
  "data": [
    {
      "contractId": "c1a2b3d4-e5f6-7890-abcd-ef1234567890",
      "type": "escrow:created",
      "sequence": 0,
      "ledger": 4190000,
      "timestamp": "2026-07-01T10:00:00.000Z",
      "payload": {}
    },
    {
      "contractId": "c1a2b3d4-e5f6-7890-abcd-ef1234567890",
      "type": "dispute:initiated",
      "sequence": 1,
      "ledger": 4200000,
      "timestamp": "2026-07-15T08:30:00.000Z",
      "payload": { "reason": "Deliverable mismatch" }
    },
    {
      "contractId": "c1a2b3d4-e5f6-7890-abcd-ef1234567890",
      "type": "dispute:resolved",
      "sequence": 2,
      "ledger": 4201500,
      "timestamp": "2026-07-18T14:00:00.000Z",
      "payload": { "resolution": "partial_refund" }
    }
  ]
}
```

**Full example:**

```bash
curl -H "Authorization: Bearer demo-user-token" \
  "https://api.talenttrust.io/api/v1/contracts/c1a2b3d4-e5f6-7890-abcd-ef1234567890/history"
```

---

## Error Codes

All errors follow the standard error envelope:

```json
{
  "error": {
    "code": "machine_readable_code",
    "message": "safe human-readable message",
    "requestId": "request-correlation-id"
  }
}
```

Errors you may encounter when working with disputes:

| HTTP | Code | When it occurs |
|---|---|---|
| `400` | `validation_error` | Request body or query params failed schema validation (e.g., missing `version`, invalid `status` value). |
| `400` | `invalid_json` | Request body is malformed JSON. |
| `400` | `invalid_event_payload` | Event payload failed contract-event schema validation. |
| `400` | `ERR_MISSING_VERSION` | `PATCH /contracts/:id` was sent without the `version` field. |
| `400` | `ERR_INVALID_VERSION` | `version` is not a non-negative integer. |
| `401` | `unauthorized` | No `Authorization` header or token is expired/invalid. |
| `403` | `forbidden` | Authenticated user's role does not permit the action (e.g., `guest` attempting to write). |
| `404` | `not_found` | Contract ID does not exist. |
| `409` | `conflict` | Business-rule conflict (e.g., attempting to transition from `draft` directly to `disputed`). |
| `409` | `ERR_CONFLICT` | Optimistic concurrency version conflict — another update modified the contract first. Read the latest version and retry. |
| `422` | `contract_bounds_error` | A `budget` or milestone total in the PATCH exceeds policy limits. |
| `429` | `rate_limited` | Too many requests in the allowed window. |
| `500` | `internal_error` | Unexpected server error. |
| `503` | `dependency_unavailable` | A required upstream service (database, Soroban RPC) is temporarily unavailable. |

### OCC Conflict Retry Pattern

When you receive `ERR_CONFLICT` (409), the correct recovery flow is:

```
1. GET /api/v1/contracts/:id            → read latest version N
2. PATCH /api/v1/contracts/:id          → send { version: N, status: "disputed" }
3. On 409 ERR_CONFLICT → go to step 1
```

---

## Notifications

When a contract transitions to `disputed`, the `EscrowHooks.onStateTransition` method fires the `DISPUTE_RAISED` event (`KeyEscrowEvent`). This fans out notifications concurrently to all supported channels:

| Channel | Transport | Event |
|---|---|---|
| Email | SMTP | `DISPUTE_RAISED` |
| Web / In-App | WebSocket / push | `DISPUTE_RAISED` |

Both channels are attempted concurrently via `Promise.allSettled`. A failure in one channel does not prevent the other from delivering.

Log fields emitted on the `DISPUTE_RAISED` dispatch:

```json
{
  "level": "info",
  "event": "DISPUTE_RAISED",
  "contractId": "c1a2b3d4-e5f6-7890-abcd-ef1234567890",
  "userId": "user-freelancer-uuid"
}
```

See [docs/backend/notifications.md](./backend/notifications.md) and [docs/email-notifications.md](./email-notifications.md) for full notification channel documentation.

---

## Soft-delete, restore, and purge

Disputes support soft-delete so deletes are reversible within a retention window.

| Concern | Behaviour |
|---------|-----------|
| Soft-delete | `DELETE /api/v1/disputes/:id` sets `deletedAt` (record is kept) |
| Default reads | `GET /api/v1/disputes` and `GET /api/v1/disputes/:id` exclude soft-deleted rows (`?includeDeleted=true` on list to include) |
| Restore | `POST /api/v1/disputes/:id/restore` clears `deletedAt` if still inside the retention window; otherwise `410 soft_delete_retention_expired` |
| Retention | `DISPUTES_SOFT_DELETE_RETENTION_DAYS` (default **30**) |
| Purge | `runDisputesSoftDeletePurge()` hard-deletes soft-deleted rows past the window (maintenance / cron) |

Sources: [`src/services/disputes.service.ts`](../src/services/disputes.service.ts), [`src/routes/disputes.routes.ts`](../src/routes/disputes.routes.ts), [`src/utils/softDelete.ts`](../src/utils/softDelete.ts)

---

## Related Documentation

- [Contract Lifecycle & Bounds](./contracts-lifecycle.md) — full state machine diagram and OCC semantics
- [Audit Log](./backend/audit-log.md) — querying and exporting the tamper-evident audit trail
- [Authentication & Authorization](./backend/authentication-authorization.md) — RBAC role matrix
- [Event Ingestion Idempotency](./EVENT_INGESTION_IDEMPOTENCY.md) — deduplication TTL and replay semantics
- [Error Handling](./backend/error-handling.md) — standard error envelope and status-code policy
- [Backend Notifications](./backend/notifications.md) — notification channel architecture
