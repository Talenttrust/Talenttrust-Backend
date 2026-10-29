# Disputes API

TalentTrust disputes are not managed through a dedicated `/api/v1/disputes` resource. They are surfaced through two existing infrastructure paths:

1. **Contract status transitions** — a contract moves to `status: "disputed"` via `PATCH /api/v1/contracts/:id`.
2. **Smart-contract event ingestion** — on-chain dispute lifecycle events (`dispute:initiated`, `dispute:resolved`) are indexed via `POST /api/v1/events`.

Both paths produce audit trail entries (`PAYMENT_DISPUTED`) and trigger multi-channel notifications (`DISPUTE_RAISED@) through the escrow hooks layer.

Evidence items can be attached to an open dispute by either party, listed for the resolver, and are sealed by a content digest once the dispute is resolved.

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
  - [Submit Dispute Evidence](#8-submit-dispute-evidence)
  - [List Dispute Evidence](#9-list-dispute-evidence)
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
| Submit dispute evidence | `POST` | `/api/v1/contracts/:id/dispute/evidence` | Bearer token (client/freelancer) |
| List dispute evidence | `GET` | `/api/v1/contracts/:id/dispute/evidence` | Bearer token |

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
-  `demo-user-token` — client/freelancer role, limited to create + read

Evidence submission is further restricted to the contract's client or freelancer (`submittedBy`). Any other party receives `403 forbidden`.

---

## Dispute Lifecycle

A contract moves through a well-defined state machine. The `disputed` state is reachable only from `active`:

```
draft → active → disputed → ((resolved back to active/completed via admin PATCH)
                 └─ active → completed (no dispute)
                 └── active → cancelled
```

The `active → disputed` transition fires the `DISPUTE_RAISED` escrow hook, which fans out an email notification and a web/in-app notification to both parties.

While a dispute is open (contract status `Disputed`), either party may submit up to 20 evidence items. When the dispute is resolved, the current evidence digest is stored on the dispute as `evidenceDigest` and no further evidence can be added.

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

**Side effects:**
- The dispute's current evidence digest is stored on the dispute as `evidenceDigest`, sealing the evidence record.
- Further evidence submissions return `409 dispute_closed`.

---

### 3. Read Dispute State

Returns the full contract record. Inspect the `status` field to determine if the contract is currently in dispute. When a dispute is present, the payload includes `dispute.evidenceCount`.

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
    "version": 3,
    "dispute": {
      "reason": "Deliverable does not match agreed specifications",
      "raisedBy": "user-freelancer-uuid",
      "openedAt": "2026-07-15T08:30:00.000Z",
      "evidenceCount": 3
    }
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
  -H  Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000" \
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
      "payload": {
        "reason": "Deliverable does not match agreed specifications",
        "raisedBy": "user-freelancer-uuid"
      }
    }
  }
}
```

**Response — 400 Bad Request (invalid):**

```json
{
  "status": "error",
  "error": "invalid_event",
  "message": "Event payload failed schema validation"
}
```

---

### 6. Query Dispute Audit Log

Retrieves audit trail entries related to disputes (e.g., `PAYMENT_DISPUTED`, `PAYMENT_RESOLVED`).

```
GET /api/v1/audit?type=PAYMENT_DISPUTED
```

**Auth:** Bearer token — `admin` or `auditor`.

**Query parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `type` | `string` | No | Filter by audit entry type (e.g., `PAYMENT_DISPUTED`) |
| `contractId` | `string` | No | Filter by contract UUID |
| `page` | `integer` | No | Page number (default 1) |
| `limit` | `integer` | No | Page size (default 20) |

**Response — 200 OK:**

```json
{
  "status": "success",
  "data": [
    {
      "id": "audit-uuid",
      "type": "PAYMENT_DISPUTED",
      "contractId": "c1a2b3d4-e5f6-7890-abcd-ef1234567890",
      "actor": "user-freelancer-uuid",
      "timestamp": "2026-07-15T08:30:00.000Z"
    }
  ],
  "meta": {
    "page": 1,
    "limit": 20,
    "total": 1
  }
}
```

---

### 7. Get Contract Event History

Lists all ingested blockchain events for a contract, including dispute lifecycle events.

```
GET /api/v1/contracts/:id/history
```

**Auth:** Bearer token — owner or `admin`.

**Path parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | `string` (UUID) | Yes | Contract UUID |

**Response — 200 OK:**

```json
{
  "status": "success",
  "data": [
    {
      "type": "dispute:initiated",
      "sequence": 1,
      "ledger": 4200000,
      "timestamp": "2026-07-15T08:30:00.000Z",
      "payload": {
        "reason": "Deliverable does not match agreed specifications",
        "raisedBy": "user-freelancer-uuid"
      }
    },
    {
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
  ]
}
```

---

### 8. Submit Dispute Evidence

Attaches a structured, content-hashed evidence item to an open dispute. Either the contract's client or freelancer may submit evidence, up to 20 items per party per dispute.

```
POST /api/v1/contracts/:id/dispute/evidence
```

**Auth:** Bearer token — contract client or freelancer.

**Path parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | `string` (UUID) | Yes | Contract UUID |

**Request body:**

```json
{
  "submittedBy": "user-client-uuid",
  "kind": "link",
  "url": "https://example.com/report.pdf"
}
```

| Field | Type | Required | Constraints |
|---|---|---|---|
| `submittedBy` | `string` | Yes | Must equal the contract's `clientId` or `freelancerId`. Otherwise `403 forbidden`. |
| `kind` | `string` | Yes | One of `"text"`, `"link"`, `"file_hash"`. |
| `text` | `string` | Conditional | Required for `kind: "text"`. Max 4000 chars. Trimmed; control characters except newline/tab rejected. |
| `url` | `string` | Conditional | Required for `kind: "link"`. Must be an `https://` URL. `http://` rejected. |
| `sha256` | `string` | Conditional | Required for `kind: "file_hash"`. 64 lowercase hex characters. |
| `fileName` | `string` | No | Optional file name for `kind: "file_hash"`. Max 200 chars. |

**Response — 201 Created:**

```json
{
  "status": "success",
  "data": {
    "id": "evidence-uuid",
    "contractId": "c1a2b3d4-e5f6-7890-abcd-ef1234567890",
    "submittedBy": "user-client-uuid",
    "kind": "link",
    "url": "https://example.com/report.pdf",
    "submittedAt": "2026-07-16T09:15:00.000Z"
  }
}
```

**Full example — link evidence:**

```bash
curl -X POST https://api.talenttrust.io/api/v1/contracts/c1a2b3d4-e5f6-7890-abcd-ef1234567890/dispute/evidence \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer demo-user-token" \
  -d '{
    "submittedBy": "user-client-uuid",
    "kind": "link",
    "url": "https://example.com/report.pdf"
  }'
```

**Full example — text evidence:**

```bash
curl -X POST https://api.talenttrust.io/api/v1/contracts/c1a2b3d4-e5f6-7890-abcd-ef1234567890/dispute/evidence \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer demo-user-token" \
  -d '{
    "submittedBy": "user-freelancer-uuid",
    "kind": "text",
    "text": "Delivered the final assets on 2026-07-14."
  }'
```

**Full example — file hash evidence:**

```bash
curl -X POST https://api.talenttrust.io/api/v1/contracts/c1a2b3d4-e5f6-7890-abcd-ef1234567890/dispute/evidence \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer demo-user-token" \
  -d '{
    "submittedBy": "user-client-uuid",
    "kind": "file_hash",
    "sha256": "9f86d4e8f7b2a1c3d56e7f80a1b2c3d4e5f67890abcdef1234567890",
    "fileName": "contract.pdf"
  }'
```

**Error responses:**

| Status | Error code | Cause |
|---|---|---|
| 403 | `forbidden` | `submittedBy` is not the contract's client or freelancer. |
| 404 | `not_found` | Contract does not exist. |
| 409 | `dispute_not_open` | Contract is not in `Disputed` status. |
| 409 | `dispute_closed` | Dispute has been resolved; evidence is sealed. |
| 409 | `evidence_limit_reached` | Party already submitted 20 items. |
| 400 | `invalid_evidence` | Missing/invalid kind-specific field, or control characters in text. |

---

### 9. List Dispute Evidence

Returns all evidence items for a dispute, ordered by `submittedAt`, along with a `digest` that is the SHA-256 hash over the canonical JSON of all items. This digest is stored on the dispute as `evidenceDigest` when the dispute is resolved, sealing the record.

```
GET /api/v1/contracts/:id/dispute/evidence
```

**Auth:** Bearer token — contract client, freelancer, or admin.

**Path parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | `string` (UUID) | Yes | Contract UUID |

**Response — 200 OK:**

```json
{
  "status": "success",
  "data": [
    {
      "id": "evidence-uuid-1",
      "contractId": "c1a2b3d4-e5f6-7890-abcd-ef1234567890",
      "submittedBy": "user-client-uuid",
      "kind": "link",
      "url": "https://example.com/report.pdf",
      "submittedAt": "2026-07-16T09:15:00.000Z"
    },
    {
      "id": "evidence-uuid-2",
      "contractId": "c1a2b3d4-e5f6-7890-abcd-ef1234567890",
      "submittedBy": "user-freelancer-uuid",
      "kind": "text",
      "text": "Delivered the final assets on 2026-07-14.",
      "submittedAt": "2026-07-16T10:00:00.000Z"
    }
  ],
  "digest": "3b4c5d6e7f80a1b2c3d4e5f67890abcdef1234567890abcdef1234567890abcd",
  "dispute": {
    "status": "disputed",
    "evidenceCount": 2,
    "evidenceDigest": null
  }
}
```

**Full example:**

```bash
curl -H "Authorization: Bearer demo-user-token" \
  "https://api.talenttrust.io/api/v1/contracts/c1a2b3d4-e5f6-7890-abcd-ef1234567890/dispute/evidence" | jq
```

**Error responses:**

| Status | Error code | Cause |
|---|---|---|
| 404 | `not_found` | Contract does not exist. |

---

## Error Codes

| Error Code | HTTP Status | Description |
|---|---|---|
| `invalid_event` | 400 | Event payload failed schema validation. |
| `invalid_evidence` | 400 | Evidence item failed kind-specific validation. |
| `forbidden` | 403 | Actor is not a party to the contract. |
| `not_found` | 404 | Contract or resource not found. |
| `dispute_not_open` | 409 | Contract is not in `Disputed` status. |
| `dispute_closed` | 409 | Dispute has been resolved; evidence is sealed. |
| `evidence_limit_reached` | 409 | Party already submitted the maximum (20) evidence items. |

---

## Notifications

Dispute lifecycle events trigger notifications through the escrow hooks layer:

| Event | Notification type | Recipients |
|---|---|---|
| `DISPUTE_RAISED` | `DISPUTE_RAISED` | Client + freelancer (email + web/in-app) |
| Dispute resolved | `DISPUTE_RESOLVED` | Client + freelancer (email + web/in-app) |

Evidence submission does not trigger a notification in this release; the resolver is expected to fetch the evidence list via `GET /api/v1/contracts/:id/dispute/evidence`.
