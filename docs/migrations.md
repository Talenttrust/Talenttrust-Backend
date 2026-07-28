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
