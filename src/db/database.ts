/**
 * database.ts — SQLite singleton for TalentTrust.
 *
 * Opens (or creates) a SQLite database at the path specified by the DB_PATH
 * environment variable (default: talenttrust.db).  Pass ':memory:' during
 * tests to use an ephemeral, isolated in-memory database.
 *
 * Runs schema migrations synchronously on first open so applied migration
 * checksums are verified and tables are guaranteed to exist before the
 * application serves any requests.
 *
 * Security notes:
 *  - All SQL statements in repositories use prepared statements / parameter
 *    binding — no string interpolation — preventing SQL injection.
 *  - The database file should be excluded from version control (.gitignore).
 *  - In production, restrict filesystem permissions on the DB file (chmod 600).
 */

import Database, { type Database as DatabaseInstance } from "./betterSqlite3";

import path from "path";
import { runMigrations } from "./migrations";

let instance: DatabaseInstance | null = null;
let instancePath: string | null = null;

/**
 * Returns the shared database instance, creating it on first call.
 *
 * @param dbPath - Optional path override (used by tests to pass ':memory:').
 *                 If omitted, falls back to DB_PATH env var or 'talenttrust.db'.
 *
 * @remarks
 * When an explicit `dbPath` is supplied that differs from the currently open
 * database, the existing instance is closed and replaced. This keeps tests that
 * request an isolated `:memory:` database from being handed a stale, shared
 * file-backed instance left open by an earlier suite. Production callers invoke
 * `getDb()` with no argument, so they always reuse the single shared instance.
 */
export function getDb(dbPath?: string): DatabaseInstance {
  const resolvedPath =
    dbPath ??
    process.env["DB_PATH"] ??
    path.join(process.cwd(), "talenttrust.db");

  if (instance) {
    if (dbPath !== undefined && instancePath !== resolvedPath) {
      try {
        instance.close();
      } catch {
        // Best-effort close; proceed to open the requested database.
      }
      instance = null;
      instancePath = null;
    } else {
      return instance;
    }
  }

  // `Database` (the default export from the wrapper) is the constructor; the
  // result of `new Database(path)` is an instance whose type is `DatabaseInstance`.
  const created = new Database(resolvedPath);
  instance = created;
  instancePath = resolvedPath;

  // Apply idempotent pragmas for performance and concurrency
  created.pragma("journal_mode = WAL"); // Better concurrency
  created.pragma("synchronous = NORMAL"); // Balance durability and performance
  const busyTimeout = parseInt(process.env["DB_BUSY_TIMEOUT"] ?? "5000", 10);
  created.pragma(`busy_timeout = ${busyTimeout}`); // Configurable timeout (default 5000ms)

  created.pragma("foreign_keys = ON"); // Enforce FK constraints

  runMigrations(created);
  return created;
}

/**
 * Closes and discards the current database instance.
 * Primarily used in tests to obtain a clean state between suites.
 */
export function closeDb(): void {
  if (instance) {
    (instance as DatabaseInstance).close();
    instance = null;
    instancePath = null;
  }
}

