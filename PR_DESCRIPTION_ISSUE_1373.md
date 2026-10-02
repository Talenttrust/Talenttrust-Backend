# Make failure recovery deterministic in `src/audit/sqliteRepository.ts`

Closes #1373

## Summary

The durable SQLite audit repository previously treated every write failure the
same way: the error propagated to the caller and the repository stayed broken
for the lifetime of the object. A transient lock (`SQLITE_BUSY`), or a schema
that had been dropped / partially migrated, meant audit writes silently failed
until the process was restarted — and restarting was the *only* recovery path.
`verifyIntegrity()` could also throw on a single unreadable row, so the very
monitoring job meant to detect corruption could itself crash.

This PR makes failure recovery **deterministic and self-healing** for the
failure classes the repository can safely handle, while keeping every
deterministic error surfaced and every write atomic:

- **Bounded retry** for transient serialization conflicts
  (`SQLITE_BUSY` / `SQLITE_LOCKED`), with a fixed backoff and no random jitter.
- **One-shot schema self-repair** on `no such table` / `no such column` /
  `no such index`, on the *same* instance.
- **Non-throwing `verifyIntegrity()`** — an unparseable row is reported, not
  thrown.
- **Observable recovery** through the existing structured logger, without ever
  logging entry payloads or metadata.
- **Non-retryable errors still fail fast** — a retry loop never masks a real
  bug or weakens a safeguard.

## Problem

| Gap | Consequence |
| --- | --- |
| No retry on transient lock contention | A momentary `SQLITE_BUSY` from a concurrent writer failed the audit write outright. |
| Schema loss was unrecoverable in-process | After a `DROP` or partial migration, every subsequent `append()` failed until the process restarted. |
| `verifyIntegrity()` threw on corrupt data | One malformed `metadata_json` row crashed the integrity monitor instead of reporting corruption. |
| No recovery observability | Operators could not tell a recovered transient failure from a permanent one. |

## Solution

All changes live in `src/audit/sqliteRepository.ts` (plus tests and docs). The
public `AuditLogRepository` contract is unchanged; `append()` still returns a
frozen `AuditEntry` synchronously.

### 1. Atomic write, retried as a unit

The previous-hash read and the `INSERT` already ran inside one
`better-sqlite3` transaction. Recovery now retries **the whole transaction**,
not the bare `INSERT`, so each attempt re-reads the chain tail. A retry can
therefore never fork the hash chain or link to a stale predecessor.

### 2. Bounded, deterministic retry for transient conflicts

`isSerializationError()` recognises numeric extended codes
(`5` BUSY, `6` LOCKED, `262` LOCKED_SHAREDCACHE, `517` BUSY_SNAPSHOT) and
lock-contention messages. Only these are retried, up to
`MAX_WRITE_ATTEMPTS = 3`, with a fixed backoff. After the budget is exhausted
the last error is rethrown and no partial row survives (verified by test).

### 3. One-shot schema self-repair

`isMissingSchemaError()` detects absent tables/columns/indexes. The first such
failure triggers exactly one idempotent `initSchema()` repair and one retry.
If the repair itself fails (e.g. a read-only volume), the **original**
root-cause error is rethrown. Callers that prefer fail-fast can opt out with
`new SqliteAuditRepository(db, { autoRepairSchema: false })`; the existing
single-argument construction is unchanged.

### 4. Non-retryable errors fail fast

Constraint violations, disk-full, permission errors and malformed input are
never retried — the test suite asserts exactly one attempt for a disk-full
failure so a retry loop can never mask a real bug.

### 5. Integrity checks never throw

`verifyIntegrity()` wraps row decoding. An unparseable row produces a
deterministic
`{ valid: false, firstCorruptedIndex, firstCorruptedId, checkedAt }` report,
so the monitoring job always returns an actionable result.

### 6. Connection hardening

On construction the connection is configured with `busy_timeout = 5000`,
`journal_mode = WAL` and `synchronous = NORMAL`, so lock contention waits
instead of failing immediately. Pragma failures are non-fatal and logged at
`warn` (e.g. on a read-only or in-memory connection).

### 7. Observable, non-sensitive logging

Recovery and failure paths log through the existing structured logger
(`createLogger({ service: 'sqlite-audit-repository' })`) with the operation
name, attempt number and error code only. Entry payloads and metadata are never
logged, and the logger additionally redacts sensitive keys.

## Acceptance-criteria mapping

| Criterion (issue #1373) | Where |
| --- | --- |
| Deterministic for valid / invalid / duplicate / boundary inputs | `runWriteWithRecovery`, `isSerializationError`, `isMissingSchemaError`, error-classification tests |
| Authorization / validation / state-transition invariants enforced | Public interface unchanged; append still enforces the hash chain and DB constraints; transaction rollback preserved |
| Retries / partial failure / concurrency cannot produce unsafe state | Bounded retry of the whole transaction; no-partial-row rollback test; chain-linear-after-retry test; retry-budget-exhaustion test |
| Focused success / rejection / boundary / regression tests | 9 new recovery tests + 4 error-classification tests + 1 corrupt-row integrity test (56 total in the file, all passing) |
| Existing callers remain compatible | Single-arg constructor preserved; `append()` signature unchanged; optional `autoRepairSchema` opt-out |
| Logs / metrics / user-visible errors diagnosable without sensitive data | Structured `warn`/`info`/`error` logs; payloads/metadata never logged |

## Failure-mode handling

| Failure | Behaviour |
| --- | --- |
| `SQLITE_BUSY` / `SQLITE_LOCKED` | Retried (max 3, fixed backoff); transaction re-reads chain tail; warn logged per attempt |
| Missing table/column/index | One `initSchema()` repair + one retry on the same instance; warn logged |
| Repair fails (read-only volume) | Original error rethrown; error logged |
| Disk-full / constraint / other | Thrown on first attempt; no retry |
| Corrupt `metadata_json` during `verifyIntegrity()` | Deterministic `{ valid: false }` report; error logged |
| Concurrent writers | Synchronous better-sqlite3 + WAL + `busy_timeout`; retried transaction keeps the chain linear |

## Tests & evidence

`npx jest src/audit/sqliteRepository.test.ts` → **56 passed / 56**.

New/updated coverage:

- schema self-repair on the same instance (plus recovery log assertion)
- explicit `autoRepairSchema: false` fail-fast path
- repair-failure passthrough (original error preserved)
- non-retry of a deterministic disk-full failure (exactly one attempt)
- transient serialization retry keeps the hash chain linear (`previousHash` still points at the pre-existing tail)
- bounded retry budget exhaustion leaves **zero** rows
- transactional rollback leaves no partial row (retained)
- error classification for numeric codes, lock messages, and missing-schema text
- `verifyIntegrity()` reports corruption of a malformed row instead of throwing

Focused lint (`eslint src/audit/sqliteRepository.ts src/audit/sqliteRepository.test.ts`) is clean.

> **Pre-existing failures (not introduced by this PR):** `src/audit/downloadTokenService.test.ts`
> and `src/repository/sqliteEventAuditRepository.test.ts` fail on unmodified
> `main` with `no such table: audit_download_tokens` (21 failures). The
> typecheck/lint errors in `src/contracts/cursor.repository.ts`,
> `src/middleware/payoutIdempotency.ts` and `src/contracts/indexer.integration.test.ts`
> are also pre-existing. Verified by stashing this PR's changes and re-running.

## Compatibility

- No public interface or return-type changes.
- No new dependencies.
- Schema bootstrap remains additive (`CREATE TABLE/INDEX IF NOT EXISTS`).
- Recovery is opt-out via constructor options; default behaviour is the
  deterministic recovery described above.

## Documentation

- `docs/backend/audit-log.md` — new “Failure Recovery (SQLite backend)” section
  with the invariant table and operational notes; updated test-suite row.
- `docs/runbook-audit.md` — new recovery log rows and an “Automatic recovery”
  subsection under write-failure triage.

## Non-goals

- No typo/formatting/cosmetic changes.
- No unrelated refactors or dependency upgrades.
- No removal or weakening of validation or safeguards.
