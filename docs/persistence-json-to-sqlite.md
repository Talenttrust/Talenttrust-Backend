# Persistence migration: JSON file to SQLite

`src/database/index.ts` historically persisted everything to a single JSON
document at `data/database.json`, while the rest of the codebase had already
moved to the SQLite connection layer in `src/db/database.ts` +
`src/db/betterSqlite3.ts`. This document records what moved, what deliberately
did not, and why.

## What moved

| Collection | Storage before | Storage now |
| --- | --- | --- |
| `contract_metadata` | `data/database.json` | SQLite table `contract_metadata` |
| `api_keys` | `data/database.json` | SQLite table `api_keys` |
| `contracts` | `data/database.json` | **unchanged** (still JSON) |
| `users` | `data/database.json` | **unchanged** (still JSON) |

Every public method on `DatabaseService` keeps its exact signature and return
type. Callers require no changes.

## Why `contracts` and `users` did not move

This is the schema drift referenced in the issue, and it is not just a naming
mismatch. The two layers define **incompatible types under the same names**:

| | `src/database/schema.ts` | `src/db/types.ts` |
| --- | --- | --- |
| `Contract` | `id`, `created_by`, timestamps | `id`, `title`, `clientId`, `freelancerId`, `amount`, `status`, `version` |
| `User` | `id`, `email`, `role: 'user' \| 'admin'` | `id`, `username`, `email`, `role: 'client' \| 'freelancer' \| 'both'` |

The SQLite `users` and `contracts` tables are owned by the `src/db/types.ts`
model — migration v7 gives `users` a `username`, `password_hash` and
`refresh_token_hash`, none of which the JSON `User` has, and several are
`NOT NULL`. Inserting JSON-shaped rows into those tables would either fail
outright or write records that the auth service then misreads.

Reconciling the two models is a product decision (which `User` is canonical?),
not a mechanical refactor, so it is deliberately out of scope here. The two
collections that have **no** SQLite counterpart migrate cleanly and are done.

## Schema ownership

The new tables are created by `SqliteMetadataStore.initSchema()` using
`CREATE TABLE IF NOT EXISTS`, rather than by adding an entry to
`src/db/migrations.ts`.

This matches the pattern already established in this repository by
`src/audit/sqliteRepository.ts`, `src/events/idempotencyStore.ts`,
`src/queue/webhook-dlq.ts` and `src/retention/storage.ts`, all of which own
their own idempotent bootstrap. It also avoids mutating the checksummed
migration registry, whose applied-checksum verification would reject an edit to
any existing entry.

Neither table declares a `FOREIGN KEY` on `created_by`. Those ids still refer to
JSON-backed users, and `src/db/database.ts` sets `foreign_keys = ON` globally,
so a real constraint would reject every insert until users are migrated too.

## Importing existing data

`SqliteMetadataStore.importFromJson()` performs a one-shot backfill:

```ts
import { getMetadataStore } from './src/database/sqliteStore';

const raw = JSON.parse(fs.readFileSync('data/database.json', 'utf-8'));
const { metadata, apiKeys } = getMetadataStore().importFromJson(raw);
```

It runs in a single transaction and uses `INSERT OR IGNORE` keyed on the primary
key, so it is safe to run repeatedly: existing rows are never duplicated and
never overwritten. It returns the number of rows actually inserted, so a second
run reports `0`.

## Behaviour preserved

- **Ordering.** `getContractMetadataByContractId` previously sorted newest-first
  with `id` ascending as a tie-break; the SQL uses
  `ORDER BY created_at DESC, id ASC` to match exactly.
- **Cursor pagination.** `listApiKeysPage` sorts `created_at DESC, id DESC` and
  compares `(created_at, id)` against the decoded cursor, identical to the old
  in-memory filter. Timestamps are stored as ISO-8601 `TEXT`, so lexicographic
  comparison and chronological comparison agree.
- **Soft deletes.** `deleted_at IS NULL` replaces the `!record.deleted_at`
  checks; `includeDeleted` still opts back in.
- **Limit clamping.** Bounds are applied in `DatabaseService` before reaching
  SQL, so the clamping rules are unchanged.

## Configuration

The store uses the shared connection from `getDb()`, so it honours the existing
`DB_PATH` and `DB_BUSY_TIMEOUT` environment variables. Tests pass `':memory:'`
for an isolated database.
