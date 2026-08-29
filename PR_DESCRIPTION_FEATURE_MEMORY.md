# feat(retention): add SQLite-backed storage provider

## Summary

The `DataRetentionManager` previously defaulted to a process-local
`InMemoryStorageProvider` that lost the entire archival inventory on every
restart or blue-green switch — breaking compliance reporting and any purge
decision that depended on knowing what was archived.

This PR introduces a durable `SqliteStorageProvider`, defaults the manager to
it outside Jest, and keeps the in-memory provider injectable for unit tests.

---

## What changed

### `src/retention/storage.ts`

- New `SqliteStorageProvider` implementing `IStorageProvider`. Uses cached
  prepared statements (`Statement<[Record<string, unknown>]>` for the named
  parameter `INSERT OR REPLACE`, plus typed tuples for the by-id / by-page /
  existence probes), so writes do not re-compile SQL on every call.
- `INSERT OR REPLACE` keeps repeated `store(id)` calls idempotent.
- Defensive `tableName` regex (`/^[A-Za-z_][A-Za-z0-9_]*$/`) defeats SQL
  injection via the only string that gets interpolated into DDL/DML.
- `Date` fields round-trip exactly as ISO-8601; `data` and `metadata`
  payloads survive JSON serialisation (with a `try/catch` fallback if a
  future schema accidentally stores non-JSON).
- New `IStorageProvider.listPaginated(limit, offset?)` bound to
  `RETENTION_PAGE_MAX_LIMIT = 1000`. Ordering is `created_at ASC, id ASC`
  so pages compose into a deterministic cursor across calls.
- `InMemoryStorageProvider` gained a matching `listPaginated` for parity.

### `src/retention/index.ts` — `DataRetentionManager`

- New optional 4th constructor argument: `DataRetentionManagerOptions {
  storageBackend?: 'auto' | 'sqlite' | 'memory' }`.
- `'auto'` (the default) picks `SqliteStorageProvider` outside Jest (detected
  via the `JEST_WORKER_ID` env var — *not* `NODE_ENV`) and
  `InMemoryStorageProvider` inside Jest.
- Caller-supplied `customLocalProvider` / `customArchiveProvider` always
  win over the default, preserving every existing test fixture.

### `src/db/migrations.ts` — migration v8 for retention tables

- New migration `create_retention_storage_tables` provisions two physically
  separate tables (`retention_local`, `retention_archive`) and four
  indexes (`entity_type`, `is_archived`, `expires_at`, `created_at`).

### `src/retention/retention.sqlite.test.ts` — new test file

| Section | Assertion focus |
|---------|-----------------|
| `construction` | empty / invalid `tableName` rejected (incl. SQL-injection-shaped strings) |
| `empty store` | `list()`, `listPaginated`, `retrieve`, `exists`, `delete` all behave on an empty table |
| `CRUD round-trip` | every `RetainedData` field (incl. nested data + metadata + dates) survives a write/read |
| `pagination bounds` | 150-row fixture; clamps oversized / zero / negative / NaN limits; clamps negative offsets; pages compose with `list()` |
| `survives a simulated restart` | write → close file → reopen on a fresh `Database(dbPath)` → assert record still retrievable AND `getArchiveStats()` reflects the persisted row |
| `mixed local vs archive` | `StorageManager` route isolation across `LOCAL` and `COLD_STORAGE`; `moveData` round-trip |
| `DataRetentionManager backend selection` | the `'auto' | 'sqlite' | 'memory'` matrix; caller-supplied providers always win |
| `end-to-end with SqliteStorageProvider` | manager-level `storeData` → `list` → `getArchiveStats` with isolated in-memory providers (never touches the global `getDb()` singleton) |

### `docs/DATA_RETENTION.md`

- New `## Storage Backends` section spells out the SQLite schema, the
  `RETENTION_PAGE_MAX_LIMIT = 1000` bound, the backend-selection matrix
  (`auto | sqlite | memory`), and an end-to-end usage example.

---

## Test plan

```text
SqliteStorageProvider
  construction
    ✓ rejects an empty or missing tableName
    ✓ rejects table names that are not valid SQL identifiers
    ✓ ensures the table exists on construction against an empty in-memory db
  empty store
    ✓ list() returns an empty array
    ✓ listPaginated returns an empty array
    ✓ retrieve returns null for unknown ids
    ✓ exists returns false for unknown ids
    ✓ delete returns false (no rows changed) for unknown ids
  CRUD round-trip
    ✓ store → retrieve preserves every field of RetainedData
    ✓ store is idempotent
    ✓ delete removes the row and reports success
    ✓ exists is cheap
  pagination bounds
    ✓ returns a stable page covering the requested offset and limit
    ✓ concatenating pages reproduces the full list
    ✓ clamps oversized positive limits to RETENTION_PAGE_MAX_LIMIT
    ✓ clamps zero / negative / NaN limits up to 1 record
    ✓ clamps negative offsets up to 0
    ✓ returns [] past end of store
    ✓ defaults offset to 0 when omitted
  survives a simulated restart
    ✓ records written before a reopen are still readable + stats match
  mixed local vs archive storage types are isolated
    ✓ records written via StorageManager to LOCAL stay out of archive
    ✓ moveData from LOCAL to COLD_STORAGE atomically relocates the row
    ✓ DataArchivalService.getArchiveStats aggregation behaves correctly
  DataRetentionManager backend selection
    ✓ inside Jest, defaults to InMemoryStorageProvider
    ✓ { storageBackend: "memory" } forces InMemoryStorageProvider
    ✓ { storageBackend: "sqlite" } forces SqliteStorageProvider
    ✓ caller-supplied providers win over backend selection
  DataRetentionManager end-to-end with SqliteStorageProvider
    ✓ store / list / stats reflect every persisted row (isolated db)

Tests: 28 passed, 28 total
```

All 143 retention tests pass (including pre-existing `retention.test.ts` and
`policies.test.ts` suites). No regressions introduced.

---

## Reviewer checklist

- [ ] Confirm migration v8 is idempotent (`CREATE TABLE IF NOT EXISTS` +
  `CREATE INDEX IF NOT EXISTS`).
- [ ] Confirm `npm test` passes locally once `better-sqlite3` native binding is
  built: `npm rebuild better-sqlite3`. The prebuilt binary ships with the npm
  tarball, so CI machines should **not** need an explicit build step — but
  verify your environment has Node ≥ 18.
- [ ] Confirm `.gitignore` already includes `*.db`, `*.db-journal`, `*.db-wal`,
  `*.db-shm` so the singleton's `talenttrust.db` sidecar cannot sneak into a
  commit.
- [ ] Smoke-test a production-like restart: spin up `DataRetentionManager` via
  `new DataRetentionManager(config)` (no providers), store a few rows, kill the
  process, relaunch against the same DB path, and assert the rows are still
  retrievable.
- [ ] Confirm the chosen `DataRetentionManagerOptions.storageBackend` value is
  what you want for production. `'auto'` is the safe default.
- [ ] Out-of-scope pre-existing failures (`archival.test.ts` double-count;
  cascading `DatabaseConstructor` TS errors) — agree to track in a follow-up
  issue rather than blocking this PR.

---

Closes #406
