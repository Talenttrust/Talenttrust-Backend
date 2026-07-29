# Disputes Data Retention

This document describes the data retention policy, storage behavior, and PII handling for the Disputes subsystem in the Talenttrust-Backend system.

## 1. What's Stored

Disputes are surfaced through two primary paths, each with its own storage:

### 1.1 Dedicated Dispute Records

Disputes are stored as in-memory records (via `src/services/disputes.service.ts` — `DisputeRecord` / `disputeStore`). In production these would be in a relational database. Each record stores:

| Field | Type | Description |
|-------|------|-------------|
| `id` | UUID | Unique dispute identifier |
| `contractId` | UUID | Reference to the disputed contract |
| `status` | enum | `open`, `under_review`, `resolved`, `escalated` |
| `resolution` | string | Optional resolution notes |
| `reason` | string | Optional reason for the dispute (free text) |
| `raisedBy` | string | User ID of the party who raised the dispute |
| `createdAt` | ISO-8601 | Record creation timestamp |
| `updatedAt` | ISO-8601 | Last update timestamp |
| `deletedAt` | ISO-8601 | Set when soft-deleted; null while active |

*Source: [`src/services/disputes.service.ts`](../src/services/disputes.service.ts) — `DisputeRecord` interface and `disputeStore`*

### 1.2 Contract Status Transitions

Disputes can also be raised via `PATCH /api/v1/contracts/:id` by setting `status: "disputed"`. This stores the disputed status directly on the contract record in the `contracts` database table:

| Field | Description |
|-------|-------------|
| `status` | Set to `"disputed"` on the contract record |
| `version` | Incremented (OCC) |
| `updated_at` | Updated to transition timestamp |

The contract record itself is governed by the [contracts data retention policy](./contracts-retention.md).

*Source: [`src/controllers/contracts.controller.ts`](../src/controllers/contracts.controller.ts), [`src/repositories/contractRepository.ts`](../src/repositories/contractRepository.ts)*

### 1.3 Smart-Contract Dispute Events

On-chain dispute events (`dispute:initiated`, `dispute:resolved`) are ingested via `POST /api/v1/events` and stored in the `smart_contract_events` table:

| Field | Type | Description |
|-------|------|-------------|
| `eventId` | UUID | Unique event identifier |
| `contractId` | UUID | Related contract |
| `eventType` | enum | `dispute:initiated` or `dispute:resolved` |
| `sequence` | integer | Monotonically increasing per-contract |
| `ledger` | integer | Stellar/Soroban ledger sequence |
| `timestamp` | ISO-8601 | Event timestamp |
| `payload` | JSON | Structured metadata (reason, resolution, amounts) |

*Source: [`src/events/eventIngestionService.ts`](../src/events/eventIngestionService.ts), [`src/shared/eventEnvelopeValidation.ts`](../src/shared/eventEnvelopeValidation.ts)*

### 1.4 Idempotency Keys (Transient)

Event ingestion tracks deduplication keys keyed by `contractId:eventType:idempotencyKey`. These are transient and governed by the Event Idempotency TTL mechanism (default 1 hour, configurable via `IDEMPOTENCY_TTL_MS`).

*Source: [`src/events/idempotency.ts`](../src/events/idempotency.ts), [`src/events/idempotencyStore.ts`](../src/events/idempotencyStore.ts)*

### 1.5 Audit Trail Entries

Each dispute state transition writes a `PAYMENT_DISPUTED` audit entry to the tamper-evident audit log. The audit trail retains metadata such as actor ID, resource ID, previous/new status, IP address, and correlation ID.

*Source: [`src/audit/middleware.ts`](../src/audit/middleware.ts), [`src/audit/sqliteRepository.ts`](../src/audit/sqliteRepository.ts)*

## 2. Retention Windows and Purge Behavior

Disputes have **two separate retention contexts**:

### 2.1 Soft-Delete Retention Window (Dedicated Dispute Records)

Dedicated dispute records support soft-delete. When a dispute is deleted via `DELETE /api/v1/disputes/:id`, the record is not immediately removed — instead, `deletedAt` is set to the current timestamp.

| Concern | Behaviour |
|---------|-----------|
| **Default window** | 30 days |
| **Configuration** | `DISPUTES_SOFT_DELETE_RETENTION_DAYS` environment variable |
| **During window** | Restore is possible via `POST /api/v1/disputes/:id/restore` (clears `deletedAt`) |
| **After window** | Restore returns `410 soft_delete_retention_expired` |
| **Purge** | `runDisputesSoftDeletePurge()` hard-deletes records past the retention window |
| **Automated sweep** | No automated cron; the purge function is designed for maintenance / scheduled job invocation |

The purge function (`DisputesService.purgeExpiredDisputes()`) iterates the in-memory store and removes any record where `deletedAt` is set and the retention window has fully elapsed:

```
purgeEligible = deletedAt !== null && (deletedAt + retentionDays * 24h) < now
```

*Source: [`src/services/disputes.service.ts`](../src/services/disputes.service.ts) — `purgeExpiredDisputes()`, `restoreDispute()`, `getRetentionDays()`*
*Source: [`src/utils/softDelete.ts`](../src/utils/softDelete.ts) — `parseRetentionDays()`, `isPastRetentionWindow()`, `SoftDeleteRetentionError`*

### 2.2 Contract Status (Contracts Table)

Contracts that enter the `disputed` status are governed by the [contracts data retention policy](./contracts-retention.md). The `contracts` table retains disputed contracts indefinitely in the main operational database. There is no automated purge for contract records.

*Source: [`docs/contracts-retention.md`](./contracts-retention.md)*

### 2.3 Smart-Contract Events (Event Ingestion)

Smart-contract dispute events in the `smart_contract_events` table follow the general event storage retention behavior:

- **Event retention**: Governed by the `DataRetentionManager` (`src/retention/index.ts`) if the retention subsystem is active. Events may be archived and eventually purged according to configured retention policies.
- **Idempotency keys**: Transient — evicted after `IDEMPOTENCY_TTL_MS` (default 1 hour) via periodic sweep.

### 2.4 Audit Trail Entries

Audit log entries for disputes (`PAYMENT_DISPUTED`) are retained permanently. The audit log is an append-only, cryptographically verifiable ledger with no automated purge mechanism. See the [audit data retention policy](./audit-retention.md) for details.

### 2.5 Automated Retention Subsystem

The `DataEntityType` enum in `src/retention/types.ts` does **not** include a `DISPUTE` entity type. Dispute records are therefore **not** tracked in the automated retention engine (`DataRetentionManager`), archival service, or purge pipeline. Retention is managed exclusively through the soft-delete mechanism described in §2.1.

Available entity types: `contract`, `user_profile`, `transaction`, `audit_log`, `document`, `message`

*Source: [`src/retention/types.ts`](../src/retention/types.ts) — `DataEntityType` enum*
*Source: [`src/retention/policies.ts`](../src/retention/policies.ts) — `LEGAL_MINIMUMS`, `DEFAULT_PERIODS`*

## 3. PII Handling

### 3.1 Dedicated Dispute Records

The dispute record's `reason` and `resolution` fields accept free text and **could** contain Personally Identifiable Information (PII) if users include names, email addresses, or other personal data in their dispute descriptions.

- No automated PII redaction or masking is performed on the `reason` or `resolution` fields at the service layer.
- The `raisedBy` field stores an internal user UUID, which is not inherently PII but can be linked to a user profile containing PII.

### 3.2 Contract Status

When a dispute is raised via contract status transition, the contract `title` field relies on user input and could theoretically contain unstructured PII. See the [contracts retention PII notes](./contracts-retention.md#3-pii-handling) for details.

### 3.3 Smart-Contract Events

Event `payload` fields (`reason`, `resolution`, `clientRefundAmount`, `freelancerReleaseAmount`) are stored as JSON. These may contain financial data and user identifiers:

- **Reason / resolution text**: Could contain PII (user names, descriptions).
- **User identifiers**: `raisedBy`, `resolvedBy` fields store user UUIDs.
- **Financial data**: `clientRefundAmount` and `freelancerReleaseAmount` store monetary values.

### 3.4 Audit Log Entries

Audit entries for `PAYMENT_DISPUTED` go through the standard audit redaction pipeline (`src/audit/redact.ts`):

- **Headers**: `authorization`, `cookie`, `x-api-key`, and similar sensitive headers are fully replaced with `[REDACTED]`.
- **Body keys**: Keys containing `password`, `secret`, `token`, `credential`, `apikey`, `api_key`, or `private` are redacted.
- **Email masking**: Email addresses found in metadata are partially masked (e.g., `alice@example.com` → `ali***@example.com`).

*Source: [`src/audit/redact.ts`](../src/audit/redact.ts), [`docs/audit-retention.md`](./audit-retention.md#pii-handling--redaction)*

## 4. Summary Table

| Data Store | Retention Window | Purge Mechanism | PII Exposure |
|------------|-----------------|-----------------|--------------|
| Dispute records (in-memory / DB) | 30 days soft-delete (configurable) | `runDisputesSoftDeletePurge()` (manual cron) | `reason`/`resolution` free text; `raisedBy` UUID |
| Contract status (`contracts` table) | Indefinite | None automated | Contract `title` (free text) |
| Smart-contract events | Dependent on retention subsystem | Archival + purge if active | Event payload (reason, amounts, user IDs) |
| Idempotency keys | 1 hour (configurable) | Periodic sweep | None (hashed key only) |
| Audit trail (`PAYMENT_DISPUTED`) | Permanent | None (append-only ledger) | Redacted via audit pipeline |

## 5. Related Documentation

- [Contracts Data Retention](./contracts-retention.md) — retention policy for contract records, including disputed contracts
- [Audit Data Retention & Purge Policy](./audit-retention.md) — permanent retention and cryptographic chain for audit entries
- [Data Retention & Lifecycle Management](./DATA_RETENTION.md) — system-wide retention engine, archival, and purge lifecycle
- [Disputes API](./disputes.md) — API reference for dispute endpoints with soft-delete and restore details
- [Disputes Subsystem Operations Runbook](./runbook-disputes.md) — operational guidance, failure modes, and recovery procedures
