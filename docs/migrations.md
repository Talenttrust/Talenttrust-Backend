// Database Migration Authoring

// This document provides a concise guide for contributors on how the migration
// runner works, how migrations are discovered and applied, and how to add a new
// migration safely.

// ### Migration discovery & execution
// The application imports `runMigrations` from `src/db/migrations.ts` and calls it
// during startup (see `src/db/database.ts`). `runMigrations` receives the list of
// migrations defined in the constant `MIGRATIONS`. The order of this array is the
// canonical migration order – each entry has a `version` (starting at 1) and a
// `name`. The runner validates that the sequence is contiguous and that the
// `version` of each entry matches its position.

// When the SQLite database is opened, `runMigrations`:
// 1. Ensures the `schema_version` table exists (creating it if necessary).
// 2. Loads any previously applied migrations from `schema_version`.
// 3. Verifies the checksum of each applied migration matches the current code.
//    If a checksum or name mismatch is detected the process aborts – this
//    protects against accidental edits of already‑deployed migrations.
// 4. Applies any pending migrations in order. Each migration runs inside a
//    single SQLite transaction together with an insert into `schema_version`
//    (containing version, name, checksum, and timestamp). If the migration
//    throws, the transaction rolls back and the migration is not recorded.

// ### Adding a new migration
// 1. Create a new file `src/db/migrations/<VERSION>_<NAME>.ts` (optional) or
//    directly add an entry to the `MIGRATIONS` array in `src/db/migrations.ts`.
// 2. Increment the version number by one (e.g., if the latest version is 2, the
//    new migration should have `version: 3`). Do **not** reuse an existing version
//    or rename an existing migration – migrations are immutable once merged.
// 3. Choose a short, kebab‑cased `name` that describes the change (e.g.
//    "add_user_profile_table").
// 4. Implement the `up` function – it receives a `better-sqlite3` database
//    instance. Keep the migration deterministic: no network calls, no environment
//    variables, no user input, and no secrets.
// 5. Run the test suite (`npm test`) – the migration runner will automatically be
//    exercised against an in‑memory SQLite database. The test `src/db/migrations.test.ts`
//    confirms that the new version is applied and that checksums are recorded.
// 6. Commit the changes. The CI will run the migration tests against a fresh DB
//    to ensure the migration is forward‑compatible.

// ### Where the SQLite file lives
// - In production the file is located at the path defined by the `DB_PATH`
//   environment variable, defaulting to `talenttrust.db` in the project root.
// - During unit tests the database is opened with the special path `":memory:"`
//   which creates an isolated, in‑memory SQLite instance that is discarded after
//   each test suite (`closeDb` is called).

// ### Idempotency guarantees
// The `schema_version` table records a checksum for each applied migration.
// Re‑running the application reads this table, verifies the recorded checksum
// against the current migration definition, and skips migrations whose version
// is already present. This means that applying the same codebase multiple times is
// safe – migrations are only executed once.

// ### Security notes
// - Migration code is part of the application source and never receives external
//   input, so SQL injection is not a concern.
// - The migration runner aborts on any checksum mismatch, preventing silent
//   drift between code and database schema.
// - Do not store secrets in migration SQL – keep them in application code or a
//   secret manager.

// For a complete reference see the source files:
// - `src/db/migrations.ts` – migration definitions and `runMigrations`.
// - `src/db/database.ts` – database singleton that invokes `runMigrations` on
//   startup.
// - `src/db/migrations.test.ts` – test suite exercising the runner.
//
// **Step‑by‑step recipe to add a migration**
// 1. Add a new entry to the `MIGRATIONS` array with the next sequential `version`.
// 2. Write the SQL statements inside the `up` function.
// 3. Run `npm test` locally – the migration runner will apply the migration to an
//    in‑memory DB and verify checksum handling.
// 4. Commit and open a pull request.
//
// This documentation ensures new contributors can safely extend the database
// schema without risking data loss or migration drift.
//

`src/db/database.ts` opens SQLite and immediately calls `runMigrations()` before
the application serves requests. The migration runner records every applied
migration in `schema_version` with its version, name, checksum, and timestamp.

## Rules

- Append new migrations to `MIGRATIONS` in `src/db/migrations.ts`.
- Use contiguous versions starting at `1`; do not reorder migrations.
- Never edit the `name` or `up` body of a migration after it has been merged or
  applied. Add a new migration instead.
- Keep migrations deterministic and free of secrets, environment-specific data,
  network calls, or user input.
- Write migrations so they are safe to run once in production and easy to test
  against an empty SQLite database.

## Checksum Verification

On startup, the runner verifies that every applied migration still matches the
recorded checksum. If a migration is missing, renamed, reordered, or edited, the
process fails fast instead of applying more schema changes on an untrusted
history.

Older databases whose `schema_version` table lacks checksums are upgraded by
adding the checksum column and backfilling checksums for known applied
migrations. After that, any mismatch aborts startup.

## Transaction Behavior

Each pending migration runs inside a single SQLite transaction together with its
`schema_version` insert. If the migration throws, all DDL/DML from that migration
is rolled back and the migration is not recorded.

## Security Notes

- Migration SQL is static application code, not request input.
- Application authentication, signature verification, and authorization happen
  outside the migration layer.
- Do not log secrets from migrations; schema changes should not contain secret
  values.
- Idempotency is provided by the `schema_version` table and checksum checks.

## DatabaseService — JSON → SQLite migration (issue #643)

### Background

Prior to this change, `src/database/index.ts` persisted all `DatabaseService`
data to `data/database.json` via full-file reads and writes.  This had two
critical problems:

1. **No concurrency control** — parallel writes would race and silently
   overwrite each other's changes.
2. **Schema drift** — the TypeScript interfaces in `src/database/schema.ts` were
   not enforced at the storage layer, so bad data could accumulate undetected.

`DatabaseService` is now backed by the shared SQLite connection (via
`src/db/database.ts`) using the same prepared-statement API the rest of the
codebase uses.

### New tables (migrations 13 – 16)

| Version | Table | Purpose |
|---------|-------|---------|
| 13 | `contract_metadata` | Key/value metadata for contracts (replaces the JSON array) |
| 14 | `db_contracts` | Lightweight contract containers owned by DatabaseService |
| 15 | `db_users` | User records owned by DatabaseService (email + role) |
| 16 | `api_keys` | API key storage with hash, selector, scope, and active flag |

`db_contracts` and `db_users` are intentionally separate from the richer
`contracts` and `users` tables (used by the escrow workflow and auth layer
respectively) to avoid colliding schema requirements.

### One-shot import from an existing data/database.json

If you have a production `data/database.json` file that was written by the old
`DatabaseService`, you can import it with the following one-time script.  Run
it once against your database **before** deploying the new code.

```ts
// scripts/import-json-db.ts
import { readFileSync } from 'fs';
import path from 'path';
import { getDb, closeDb } from '../src/db/database';

interface OldDatabase {
  contract_metadata: Array<{
    id: string; contract_id: string; key: string; value: string;
    data_type: string; is_sensitive: boolean; created_by: string;
    updated_by?: string; created_at: string; updated_at: string;
    deleted_at?: string;
  }>;
  contracts: Array<{
    id: string; created_by: string; created_at: string;
    updated_at: string; deleted_at?: string;
  }>;
  users: Array<{
    id: string; email: string; role: string;
    created_at: string; updated_at: string;
  }>;
  api_keys: Array<{
    id: string; name: string; key_hash: string; key_selector?: string;
    scope: string[]; created_by: string; created_at: string;
    updated_at: string; expires_at?: string; last_used_at?: string;
    is_active: boolean;
  }>;
}

const jsonPath = path.join(__dirname, '../data/database.json');
const old = JSON.parse(readFileSync(jsonPath, 'utf-8')) as OldDatabase;
const db = getDb();

const insertMeta = db.prepare(`
  INSERT OR IGNORE INTO contract_metadata
    (id, contract_id, key, value, data_type, is_sensitive,
     created_by, updated_by, created_at, updated_at, deleted_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const insertContract = db.prepare(`
  INSERT OR IGNORE INTO db_contracts
    (id, created_by, created_at, updated_at, deleted_at)
  VALUES (?, ?, ?, ?, ?)
`);
const insertUser = db.prepare(`
  INSERT OR IGNORE INTO db_users
    (id, email, role, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?)
`);
const insertKey = db.prepare(`
  INSERT OR IGNORE INTO api_keys
    (id, name, key_hash, key_selector, scope, created_by,
     created_at, updated_at, expires_at, last_used_at, is_active)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const run = db.transaction(() => {
  for (const r of old.contract_metadata) {
    insertMeta.run(r.id, r.contract_id, r.key, r.value, r.data_type,
      r.is_sensitive ? 1 : 0, r.created_by, r.updated_by ?? null,
      r.created_at, r.updated_at, r.deleted_at ?? null);
  }
  for (const c of old.contracts) {
    insertContract.run(c.id, c.created_by, c.created_at, c.updated_at, c.deleted_at ?? null);
  }
  for (const u of old.users) {
    insertUser.run(u.id, u.email, u.role, u.created_at, u.updated_at);
  }
  for (const k of old.api_keys) {
    insertKey.run(k.id, k.name, k.key_hash, k.key_selector ?? null,
      JSON.stringify(k.scope), k.created_by, k.created_at, k.updated_at,
      k.expires_at ?? null, k.last_used_at ?? null, k.is_active ? 1 : 0);
  }
});

run();
closeDb();
console.log('Import complete.');
```

Run with:

```bash
DB_PATH=talenttrust.db npx ts-node scripts/import-json-db.ts
```

`INSERT OR IGNORE` makes the import **idempotent** — running it twice will not
create duplicates.

### Verifying the import

```bash
sqlite3 talenttrust.db "SELECT COUNT(*) FROM contract_metadata;"
sqlite3 talenttrust.db "SELECT COUNT(*) FROM db_contracts;"
sqlite3 talenttrust.db "SELECT COUNT(*) FROM db_users;"
sqlite3 talenttrust.db "SELECT COUNT(*) FROM api_keys;"
```

Compare the counts with the array lengths in `data/database.json` to confirm
all rows were imported.

### Reverting (emergency only)

The new tables (`contract_metadata`, `db_contracts`, `db_users`, `api_keys`)
are additive — they do not modify or drop existing tables.  If you need to
roll back to the JSON implementation while keeping existing data:

1. Deploy the previous code commit.
2. Export current SQLite data back to JSON using the inverse of the import script.
3. Write the resulting JSON to `data/database.json`.

Migrations 13 – 16 will remain in `schema_version` and will be skipped on
future startups (they are idempotent), so rolling forward again is safe.
