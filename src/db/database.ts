/**
 * database.ts — SQLite singleton for TalentTrust.
 *
 * Opens (or creates) a SQLite database at the path specified by the DB_PATH
 * environment variable (default: talenttrust.db).  Pass ':memory:' during
 * tests to use an ephemeral, isolated in-memory database.
 *
 * Runs schema migrations synchronously on first open so the tables are
 * guaranteed to exist before the application serves any requests.
 *
 * Security notes:
 *  - All SQL statements in repositories use prepared statements / parameter
 *    binding — no string interpolation — preventing SQL injection.
 *  - The database file should be excluded from version control (.gitignore).
 *  - In production, restrict filesystem permissions on the DB file (chmod 600).
 */

import Database from "better-sqlite3";
import path from "path";

let instance: Database.Database | null = null;

/**
 * Returns the shared database instance, creating it on first call.
 *
 * @param dbPath - Optional path override (used by tests to pass ':memory:').
 *                 If omitted, falls back to DB_PATH env var or 'talenttrust.db'.
 */
export function getDb(dbPath?: string): Database.Database {
  if (instance) return instance;

  const resolvedPath =
    dbPath ??
    process.env["DB_PATH"] ??
    path.join(process.cwd(), "talenttrust.db");

  instance = new Database(resolvedPath);
  instance.pragma("journal_mode = WAL"); // Better concurrency
  instance.pragma("foreign_keys = ON"); // Enforce FK constraints

  runMigrations(instance);
  return instance;
}

/**
 * Closes and discards the current database instance.
 * Primarily used in tests to obtain a clean state between suites.
 */
export function closeDb(): void {
  if (instance) {
    instance.close();
    instance = null;
  }
}

/**
 * Runs all DDL migrations against the provided database connection.
 * Each statement uses IF NOT EXISTS so re-runs are idempotent.
 *
 * @param db - An open better-sqlite3 Database instance.
 */
function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id          TEXT    PRIMARY KEY,
      username    TEXT    NOT NULL UNIQUE,
      email       TEXT    NOT NULL UNIQUE,
      role        TEXT    NOT NULL DEFAULT 'client'
                          CHECK (role IN ('client', 'freelancer', 'both')),
      created_at  TEXT    NOT NULL
    );

    CREATE TABLE IF NOT EXISTS contracts (
      id            TEXT    PRIMARY KEY,
      title         TEXT    NOT NULL,
      client_id     TEXT    NOT NULL REFERENCES users(id),
      freelancer_id TEXT    NOT NULL REFERENCES users(id),
      amount        INTEGER NOT NULL CHECK (amount >= 0),
      status        TEXT    NOT NULL DEFAULT 'draft'
                            CHECK (status IN (
                              'draft', 'active', 'completed', 'disputed', 'cancelled'
                            )),
      created_at    TEXT    NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_contracts_client_id
      ON contracts(client_id);

    CREATE INDEX IF NOT EXISTS idx_contracts_freelancer_id
      ON contracts(freelancer_id);

    CREATE INDEX IF NOT EXISTS idx_contracts_status
      ON contracts(status);
  `);
}
