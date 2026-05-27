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
import { runMigrations } from "./migrations";

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

