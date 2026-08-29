# Data Retention & Lifecycle Management

This document details the data retention, archival, and purge processes within the Talenttrust-Backend repository. The retention engine ensures that our data lifecycle adheres to compliance standards, maintains tamper-evident audit trails, and executes operations safely.

## 1. The Data Lifecycle Model

The lifecycle of a record strictly follows three primary states: **Active → Archived → Purged**.

### Active State

When data is created, the `RetentionPolicyEngine` (`src/retention/policies.ts`) assigns an expiration date.
Retention policies are mapped to periods (durations in milliseconds):

- **30 Days**: `30 * 24 * 60 * 60 * 1000`
- **90 Days** (Default fallback): `90 * 24 * 60 * 60 * 1000`
- **180 Days** (6 Months): `180 * 24 * 60 * 60 * 1000`
- **365 Days** (1 Year): `365 * 24 * 60 * 60 * 1000`
- **730 Days** (2 Years): `730 * 24 * 60 * 60 * 1000`
- **Indefinite**: `Number.MAX_SAFE_INTEGER`

### Archival Selection

The system checks if a record has reached its expiration date (`now >= expiresAt`).
If expired, the `DataArchivalService` (`src/retention/archival.ts`) takes over:

- It generates an archival path format: `/archive/{storageType}/{entityType}/{year}/{month}/{dataId}`
- It determines if encryption is required. Data classified as `RESTRICTED` or `CONFIDENTIAL` is unconditionally encrypted, overriding any lax policy configurations.
- The record is marked as `isArchived: true`, tagged with an `archivedAt` timestamp, and passed to the appropriate storage backend.

### Purge / Deletion Window Enforcement

The purge engine (`src/retention/purge.ts`) evaluates whether archived records have exceeded their post-archival retention window (defaulting to 30 days after `archivedAt`).
Expired local active records (without policies) or expired cold storage archives are permanently purged using the `StorageManager` API. The purge script tracks processed IDs in a `seenArchiveIds` set to prevent double-counting or double-deleting records that share identical storage providers (e.g., `COLD_STORAGE` and `ENCRYPTED_ARCHIVE`).

## 2. Storage Backends & Compliance Audit Proofs

### Storage Backends

Our storage abstraction layer (`src/retention/storage.ts`) delegates data to different destinations via the `StorageManager`:

- **Storage Types**: `LOCAL`, `CLOUD`, `COLD_STORAGE`, and `ENCRYPTED_ARCHIVE`.
- **Implementations**:
  - `SqliteStorageProvider`: The primary persistent provider. It uses table names like `retention_local` or `retention_archive`. It features SQLite-backed storage that ensures atomicity, survivability across restarts, and paginated reading (capped at `1000` records to avoid memory bloat).
  - `InMemoryStorageProvider`: Used primarily for isolation during testing and development.

### Compliance Audit Proofs

To guarantee non-repudiation and regulatory accountability, the `ComplianceAuditLogger` (`src/retention/audit.ts`) records all state changes:

- For destructive actions—specifically `DELETE` and `ARCHIVE`—the system constructs a JSON payload containing the entity type, action, actor, timestamp, and details.
- This payload is signed via SHA-256 HMAC utilizing the environment secret `COMPLIANCE_AUDIT_SECRET`.
- There is no fallback secret. `COMPLIANCE_AUDIT_SECRET` must be configured and should be generated from a secure random source (minimum 32 characters).
- The resulting signature serves as a verifiable, tamper-evident cryptographic proof (`proof`) bound to the `ComplianceAuditLog`, allowing independent verification via `verifyProof(log)`.

## 3. Configuration & Safety Guarantees

### Environment Variables & Settings

- `COMPLIANCE_AUDIT_SECRET`: Required string used as the HMAC secret key for generating audit log proofs.
- `RETENTION_DRY_RUN`: If set to `true` (or run with the flag `--dry-run`), the purge process strictly calculates and outputs candidate counts per table without executing any `DELETE` operations.
- `RETENTION_OVERRIDES`: Optional JSON string that overrides the default retention period for individual entity types. The value must be a JSON object mapping `DataEntityType` names to `RetentionPeriod` values. Overrides are validated at startup; values below the per-entity legal minimum are rejected. Examples below.

#### RETENTION_OVERRIDES Format

```bash
# Extend contract retention to 2 years, transaction to 1 year,
# and audit logs to indefinite.
RETENTION_OVERRIDES='{"contract":"2y","transaction":"1y","audit_log":"indefinite"}'

# Shorten document retention to 30 days (minimum for document is 90d,
# so this will be clamped to 90d at startup).
RETENTION_OVERRIDES='{"document":"30d"}'
```

**Valid entity types:** `contract`, `user_profile`, `transaction`, `audit_log`, `document`, `message`

**Valid periods:** `30d`, `90d`, `6m`, `1y`, `2y`, `indefinite`

**Legal minimums per entity type:**

| Entity Type | Legal Minimum | Rationale |
|---|---|---|
| `contract` | `1y` | Contracts must be retained for at least one year for regulatory compliance. |
| `transaction` | `1y` | Financial transaction records require a minimum one-year retention. |
| `audit_log` | `2y` | Audit logs must be retained for at least two years for compliance review. |
| `user_profile` | `30d` | User profiles have a minimum 30-day retention for account recovery. |
| `document` | `90d` | Documents require a minimum 90-day retention. |
| `message` | `30d` | Messages have a minimum 30-day retention. |

If an override value is below the legal minimum, it is clamped to the minimum at startup. The engine logs the effective period for each entity type via `getResolvedPolicies()`.

#### Auditability

The `RetentionPolicyEngine.getResolvedPolicies()` method returns the full set of effective, resolved policies — one per entity type — with the period that would actually be used for expiration calculations and a `source` field indicating whether the period came from an override or the default:

```typescript
const engine = new RetentionPolicyEngine();
engine.applyOverrides({ contract: '2y' });

const resolved = engine.getResolvedPolicies();
// {
//   contract:     { period: '2y', source: 'override' },
//   transaction:  { period: '90d', source: 'default' },
//   audit_log:    { period: '90d', source: 'default' },
//   user_profile: { period: '90d', source: 'default' },
//   document:     { period: '90d', source: 'default' },
//   message:      { period: '90d', source: 'default' },
// }
```

### Safety & Idempotency

- **Idempotent Storage**: The SQLite provider utilizes an `INSERT OR REPLACE` strategy. Repeatedly storing a record with the same ID correctly overwrites it rather than throwing uniqueness constraints or creating duplicates. This allows for safe partial re-runs.
- **Dry-Run Integrity**: The dry-run purge mode shares the _exact same_ logic and database queries as the destructive execution branch. This guarantees that simulated outputs accurately reflect what will actually be deleted.
- **Redaction**: Purge and audit logs sanitize raw PII objects before logging out. Data payloads are stripped, replaced with `[REDACTED]`, and emails are masked.
- **Transaction Safety**: Bounded queries (`limit: 1000` per page) and SQLite statement reuse prevents resource exhaustion and out-of-memory errors when processing large backlogs of expired records.

## 4. Workflow Sequence Diagram

The following Mermaid diagram outlines the progression from an active state to eventual deletion, emphasizing the compliance audit tracking checkpoint.

### Relationship with Event Idempotency TTL

The `DataRetentionManager` operates independently from the **Event Idempotency TTL** mechanism (`src/events/idempotency.ts`). While the Data Retention module enforces long-term storage and compliance logic (e.g. archiving old contracts after years), the idempotency store employs short-lived TTLs (e.g. 24 hours) for deduplication tracking.

- The Idempotency TTL only governs the lifespan of duplicate event detection and its corresponding metrics (`event_idempotency_evictions_total`).
- **No Conflict**: The idempotency key eviction logic does not race against or conflict with the `purge.ts` engine, as idempotency entries are maintained in their own discrete store/table distinct from the local active data and cold storage archives.

## Usage Examples

    Active->>Policy: Check Expiration (now >= expiresAt)
    Policy-->>Archival: Trigger Archive (if expired)

    rect rgb(240, 248, 255)
        Note over Archival, ArchiveStore: Archival Selection & Storage
        Archival->>Archival: Evaluate Encryption (Classification)
        Archival->>ArchiveStore: store(archivedData)
    end

    Archival->>Audit: logAction(ARCHIVE)
    Audit->>Audit: Generate SHA-256 HMAC Proof

    Note over ArchiveStore, Purge: Post-Archival Window
    Purge->>ArchiveStore: Query (archivedAt + postArchivalDays <= now)

    rect rgb(255, 240, 245)
        Note over Purge, Audit: Deletion Enforcement
        Purge->>ArchiveStore: Delete Record
        Purge->>Audit: logAction(DELETE)
        Audit->>Audit: Generate SHA-256 HMAC Proof
    end

````

## 5. Repository Integration

To integrate this documentation with the root of the project, please add the following snippet to your main `README.md` under the appropriate section:

```markdown
## Data Retention & Compliance

This repository enforces automated data lifecycle management—archiving and purging records based on strict retention policies. All destructive actions generate a tamper-evident HMAC compliance proof.

For a complete breakdown of our data lifecycle model, storage backends, and audit generation, please see the [Data Retention Documentation](docs/DATA_RETENTION.md).
````
