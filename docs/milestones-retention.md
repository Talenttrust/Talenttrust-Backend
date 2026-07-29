# Milestones Data Retention

This document describes what the milestones subsystem stores, how long it keeps
that data, how purging works, and how PII is handled.

**Scope:** `Talenttrust/Talenttrust-Backend` only.

**Cross-references:**
[`src/services/milestones.service.ts`](../src/services/milestones.service.ts) ·
[`src/controllers/milestones.softdelete.controller.ts`](../src/controllers/milestones.softdelete.controller.ts) ·
[`src/utils/softDelete.ts`](../src/utils/softDelete.ts) ·
[`src/modules/milestones/dto/milestone.dto.ts`](../src/modules/milestones/dto/milestone.dto.ts) ·
[`src/modules/contracts/milestonesAudit.ts`](../src/modules/contracts/milestonesAudit.ts) ·
[`src/retention/types.ts`](../src/retention/types.ts)

---

## Table of Contents

- [What Milestones Stores](#what-milestones-stores)
  - [MilestoneRecord — persisted shape](#milestonerecord--persisted-shape)
  - [Storage backend](#storage-backend)
  - [Contract-level milestones (validation-only path)](#contract-level-milestones-validation-only-path)
- [Retention Windows](#retention-windows)
  - [Soft-delete retention](#soft-delete-retention)
  - [Configuration](#configuration)
- [Purge Behaviour](#purge-behaviour)
  - [What gets purged](#what-gets-purged)
  - [How to trigger a purge](#how-to-trigger-a-purge)
  - [No automatic scheduler](#no-automatic-scheduler)
- [Retention Engine Integration](#retention-engine-integration)
- [PII Handling](#pii-handling)
  - [Stored record fields](#stored-record-fields)
  - [Audit log snapshots](#audit-log-snapshots)
- [Data Lifecycle Diagram](#data-lifecycle-diagram)

---

## What Milestones Stores

### MilestoneRecord — persisted shape

Every milestone created through
`POST /api/v1/contracts/:id/milestones` is kept as a
[`MilestoneRecord`](../src/services/milestones.service.ts#L20-L32):

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | `string` (UUID v4) | Yes | Auto-generated via `randomUUID()`. |
| `contractId` | `string` | Yes | UUID of the parent contract. |
| `title` | `string` | Yes | Human-readable label (1–100 chars per contract DTO validation). |
| `description` | `string` | No | Free-text detail; defaults to `''` when omitted. |
| `amount` | `number` | Yes | Payment amount in stroops (positive integer). |
| `deadline` | `string` | No | Optional ISO-8601 datetime string. |
| `completed` | `boolean` | No | Completion flag; defaults to `false`. |
| `createdAt` | `Date` | Yes | Timestamp set at creation time. |
| `updatedAt` | `Date` | Yes | Timestamp updated on every write (soft-delete / restore). |
| `deletedAt` | `Date \| null` | No | `null` while active; ISO timestamp once soft-deleted. |

> **Source:** [`src/services/milestones.service.ts:20–32`](../src/services/milestones.service.ts#L20-L32),
> [`src/modules/milestones/dto/milestone.dto.ts:75–99`](../src/modules/milestones/dto/milestone.dto.ts#L75-L99)

### Storage backend

Milestones created via the standalone endpoints are kept in a **module-level
in-memory `Map`** called `milestoneStore`:

```typescript
// src/services/milestones.service.ts:63
const milestoneStore = new Map<string, MilestoneRecord>();
```

> **Implication:** The store does **not** survive process restarts. There is no
> SQLite or relational table backing standalone milestone records in the current
> implementation. A production deployment that requires durability must migrate
> `milestoneStore` to a persistent store (e.g. a dedicated `milestones` SQLite
> table) before relying on this subsystem.

### Contract-level milestones (validation-only path)

Milestone arrays supplied in `POST /api/v1/contracts` and
`PATCH /api/v1/contracts/:id` bodies are **validated but not persisted**:

- Bounds checks (max 20 milestones, total amount ≤ `MAX_CONTRACT_AMOUNT_STROOPS`
  and ≤ contract `budget`) are enforced by
  [`MilestonesService.validateMilestonesAgainstBudget()`](../src/services/milestones.service.ts#L94).
- After validation the milestone array is **discarded** — it is not written to
  the `contracts` SQLite table (see [`ContractRow`](../src/repositories/contractRepository.ts)
  for the actual persisted schema, which has no `milestones` column).
- The audit log is used as the authoritative history of contract-level milestone
  state; each write's "after" snapshot becomes the next write's "before" (see
  [`src/modules/contracts/milestonesAudit.ts`](../src/modules/contracts/milestonesAudit.ts#L1-L30)).

> **Source:** [`src/modules/contracts/milestonesAudit.ts:7–20`](../src/modules/contracts/milestonesAudit.ts#L7-L20),
> [`src/services/milestones.service.ts:80–113`](../src/services/milestones.service.ts#L80-L113)

---

## Retention Windows

### Soft-delete retention

Milestones support **reversible soft-deletion**:

1. `DELETE /api/v1/contracts/:id/milestones/:milestoneId` — sets `deletedAt` on
   the record without removing it from the store.
2. Default list/get reads **exclude** soft-deleted rows
   (`?includeDeleted=true` opts back in).
3. `POST /api/v1/contracts/:id/milestones/:milestoneId/restore` — clears
   `deletedAt` **only if** the record is still inside the retention window.
   Past the window the endpoint returns `410 soft_delete_retention_expired`.

The retention window is expressed in **calendar days** and is read at
call-time from the environment:

| Variable | Default | Effective range | Parsed by |
|---|---|---|---|
| `MILESTONES_SOFT_DELETE_RETENTION_DAYS` | **30 days** | Any positive integer | [`parseRetentionDays()`](../src/utils/softDelete.ts#L16-L28) |

The window is measured from `deletedAt` to the moment the restore (or purge
check) is executed:

```
expiryMs = deletedAt.getTime() + retentionDays × 24 × 60 × 60 × 1000
restorable while: now.getTime() <= expiryMs
```

> **Source:** [`src/utils/softDelete.ts:9–55`](../src/utils/softDelete.ts#L9-L55),
> [`src/services/milestones.service.ts:13–14`](../src/services/milestones.service.ts#L13-L14),
> [`src/services/milestones.service.ts:72–73`](../src/services/milestones.service.ts#L72-L73)

### Configuration

```bash
# Keep soft-deleted milestones restorable for 60 days (overrides the 30-day default)
MILESTONES_SOFT_DELETE_RETENTION_DAYS=60

# Restore default (or omit the variable entirely)
MILESTONES_SOFT_DELETE_RETENTION_DAYS=30
```

**Accepted values:** any positive integer string. Empty, absent, non-positive,
or non-numeric values all fall back to the **30-day default**
(see [`parseRetentionDays()`](../src/utils/softDelete.ts#L16-L28)).

---

## Purge Behaviour

### What gets purged

A purge hard-deletes (`milestoneStore.delete(id)`) every soft-deleted record
whose `deletedAt` is **strictly past** the configured retention window:

```
isPastWindow = now.getTime() > deletedAt.getTime() + retentionDays × 86_400_000
```

Active milestones (`deletedAt === null`) are **never** touched by a purge run.
Records soft-deleted **within** the window are left in place so they remain
restorable.

> **Source:** [`src/services/milestones.service.ts:240–254`](../src/services/milestones.service.ts#L240-L254),
> [`src/utils/softDelete.ts:61–67`](../src/utils/softDelete.ts#L61-L67)

### How to trigger a purge

The public maintenance entry point is:

```typescript
// src/controllers/milestones.softdelete.controller.ts:110–112
export function runMilestonesSoftDeletePurge(now: Date = new Date()): number {
  return milestonesService.purgeExpired(now);
}
```

Call `runMilestonesSoftDeletePurge()` from a cron job or maintenance script.
It returns the count of records hard-deleted in that run.

| Scenario | Result |
|---|---|
| No soft-deleted records exist | Returns `0`, no writes |
| Soft-deleted record within window | Skipped (still restorable) |
| Soft-deleted record past window | Hard-deleted from `milestoneStore`, counted |
| Active record | Always skipped |

### No automatic scheduler

> **Important:** There is currently **no cron job, queue processor, or
> background interval** that calls `runMilestonesSoftDeletePurge()`. Soft-deleted
> milestones that pass the retention window accumulate in memory until a
> process restart (which clears the in-memory store entirely) or until an
> operator explicitly invokes the purge entry point.
>
> If a persistent store is introduced, a scheduler must also be wired up.
>
> **Source:** `grep -r "runMilestonesSoftDeletePurge" src/` returns only the
> definition and its tests; no caller in production application code exists.

---

## Retention Engine Integration

The generic `DataRetentionManager` / archival pipeline defined in
[`src/retention/`](../src/retention/) is **not** used by the milestones
subsystem:

| Entity | `DataEntityType` constant defined? | Wired into `DataRetentionManager`? |
|---|---|---|
| `contract` | ✅ [`types.ts:64`](../src/retention/types.ts#L64) | ❌ Not in production paths |
| Milestones (standalone) | ❌ No dedicated constant | ❌ |

The milestones subsystem manages its own lifecycle entirely through
`MilestonesService` + `softDelete.ts` helpers. The retention engine's archival,
cold-storage, and HMAC audit-proof features do **not** apply to milestone data.

---

## PII Handling

### Stored record fields

The `MilestoneRecord` does **not** store traditional PII such as names, email
addresses, or physical locations.

| Field | PII risk | Notes |
|---|---|---|
| `id` | None | Auto-generated UUID |
| `contractId` | Indirect | Links to a contract; the contract itself may reference user UUIDs (`clientId`, `freelancerId`) |
| `title` | Low / potential | Free-text; a user could inadvertently include a name (e.g. `"Review by Alice"`). No masking is applied at write time. |
| `description` | Low / potential | Free-text, same caveat as `title`. No masking applied. |
| `amount` | None | Numeric value in stroops |
| `deadline` | None | ISO-8601 datetime string |
| `completed` | None | Boolean flag |
| `createdAt` / `updatedAt` | None | System-generated timestamps |
| `deletedAt` | None | System-generated timestamp |

> **Recommendation:** If milestone titles or descriptions are expected to
> contain user-provided names or contact details, apply redaction at the
> service layer (see [`src/audit/redact.ts`](../src/audit/redact.ts) for the
> existing `maskEmail` / `redactBody` utilities) before storing.

### Audit log snapshots

When a contract-level milestone array is written, the audit subsystem records a
bounded [`MilestonesSnapshot`](../src/modules/contracts/milestonesAudit.ts#L49-L55)
in the audit log:

- `description` fields are **intentionally omitted** from audit snapshots (only
  structural facts — `title`, `amount`, `completed`, `deadline` — are recorded).
- All included fields are passed through
  [`redactBody()`](../src/audit/redact.ts) before being stored, which masks
  any secret-shaped values (API keys, tokens, emails).
- Audit snapshots are capped at **50 items** (`MAX_SUMMARY_ITEMS`) per entry to
  prevent unbounded log growth.

> **Source:** [`src/modules/contracts/milestonesAudit.ts:97–132`](../src/modules/contracts/milestonesAudit.ts#L97-L132)

---

## Data Lifecycle Diagram

```
POST /api/v1/contracts/:id/milestones
          │
          ▼
  MilestonesService.create()
  ┌─────────────────────────────────────┐
  │  milestoneStore.set(id, record)     │  ← in-memory only; lost on restart
  │  record.deletedAt = null            │
  └─────────────────────────────────────┘
          │   active (deletedAt = null)
          │
DELETE /api/v1/contracts/:id/milestones/:milestoneId
          │
          ▼
  MilestonesService.softDelete()
  ┌──────────────────────────────────────┐
  │  record.deletedAt = now              │  ← still in store; hidden from default reads
  └──────────────────────────────────────┘
          │   soft-deleted
          │
          ├── within MILESTONES_SOFT_DELETE_RETENTION_DAYS (default 30 d)
          │         │
          │   POST …/restore
          │         │
          │         ▼
          │   record.deletedAt = null  ← restored to active
          │
          └── past retention window
                    │
             runMilestonesSoftDeletePurge()  ← must be called by operator / cron
                    │
                    ▼
             milestoneStore.delete(id)  ← hard-deleted; unrecoverable
```

---

## See Also

- [`docs/milestones.md`](./milestones.md) — API contract, field validation, feature flags, and OCC
- [`docs/milestones-flow.md`](./milestones-flow.md) — request/response flow diagrams
- [`docs/DATA_RETENTION.md`](./DATA_RETENTION.md) — generic retention engine (archival, purge, HMAC audit proofs)
- [`docs/audit-retention.md`](./audit-retention.md) — audit log retention policy
- [`docs/contracts-retention.md`](./contracts-retention.md) — contracts retention policy
