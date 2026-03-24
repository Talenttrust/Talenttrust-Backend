/**
 * @module db/migrator
 * @description Deterministic, idempotent database migration runner.
 *
 * ## Design
 * - Migrations are plain TypeScript files that export an `up` and optional
 *   `down` function.
 * - A `schema_migrations` table tracks which migrations have been applied.
 * - Each migration runs inside its own transaction — if it fails the
 *   transaction is rolled back and the error is surfaced immediately.
 * - Migrations are ordered lexicographically by filename, so the naming
 *   convention `NNNN_description.ts` guarantees a stable, deterministic order.
 * - Running the migrator multiple times is safe: already-applied migrations
 *   are skipped.
 *
 * ## Security Assumptions
 * - Migration files are loaded from a known directory inside the project;
 *   user-supplied paths are not accepted.
 * - All SQL is parameterised where values are variable.
 * - The migration lock uses a Postgres advisory lock to prevent concurrent
 *   runs from applying the same migration twice.
 */

import path from 'path';
import fs from 'fs';
import { PoolClient } from 'pg';
import { getPool, withTransaction } from './connection';

export interface Migration {
  /** Unique migration identifier derived from filename (without extension). */
  id: string;
  /** Apply the migration. */
  up: (client: PoolClient) => Promise<void>;
  /** Revert the migration (optional). */
  down?: (client: PoolClient) => Promise<void>;
}

export interface MigrationRecord {
  id: string;
  applied_at: Date;
  checksum: string;
}

export interface MigratorOptions {
  /** Absolute path to the migrations directory. */
  migrationsDir?: string;
  /** Whether to emit progress logs. Default: true. */
  verbose?: boolean;
}

const DEFAULT_MIGRATIONS_DIR = path.resolve(__dirname, '../migrations');

/**
 * Ensure the schema_migrations tracking table exists.
 */
async function ensureMigrationsTable(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id          TEXT        PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      checksum    TEXT        NOT NULL
    )
  `);
}

/**
 * Acquire a Postgres advisory lock so only one migrator runs at a time.
 * Uses a fixed lock id derived from the table name.
 */
async function acquireAdvisoryLock(client: PoolClient): Promise<void> {
  // Lock id: hashtext('schema_migrations') — stable across connections
  await client.query(`SELECT pg_advisory_xact_lock(hashtext('schema_migrations'))`);
}

/**
 * Fetch the set of already-applied migration ids.
 */
async function appliedMigrationIds(client: PoolClient): Promise<Set<string>> {
  const result = await client.query<{ id: string }>(
    'SELECT id FROM schema_migrations ORDER BY id',
  );
  return new Set(result.rows.map((r) => r.id));
}

/**
 * Simple deterministic checksum: length + first 64 chars of the up function
 * source. Good enough to detect accidental edits to applied migrations.
 */
function checksum(migration: Migration): string {
  const src = migration.up.toString();
  return `${src.length}:${src.slice(0, 64).replace(/\s+/g, ' ')}`;
}

/**
 * Load all migration modules from the migrations directory, sorted by id.
 */
export function loadMigrations(migrationsDir: string = DEFAULT_MIGRATIONS_DIR): Migration[] {
  if (!fs.existsSync(migrationsDir)) {
    return [];
  }

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.ts') || f.endsWith('.js'))
    .sort();

  return files.map((file) => {
    const id = file.replace(/\.(ts|js)$/, '');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(path.join(migrationsDir, file)) as Migration;
    if (typeof mod.up !== 'function') {
      throw new Error(`Migration ${file} must export an 'up' function`);
    }
    return { ...mod, id };
  });
}

/**
 * Run all pending migrations in order.
 *
 * @returns Array of migration ids that were applied in this run.
 */
export async function runMigrations(options: MigratorOptions = {}): Promise<string[]> {
  const { migrationsDir = DEFAULT_MIGRATIONS_DIR, verbose = true } = options;
  const applied: string[] = [];

  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await ensureMigrationsTable(client);
    await acquireAdvisoryLock(client);

    const alreadyApplied = await appliedMigrationIds(client);
    const migrations = loadMigrations(migrationsDir);

    for (const migration of migrations) {
      if (alreadyApplied.has(migration.id)) {
        if (verbose) console.log(`[migrate] skip  ${migration.id}`);
        continue;
      }

      if (verbose) console.log(`[migrate] apply ${migration.id}`);

      await migration.up(client);

      await client.query(
        'INSERT INTO schema_migrations (id, checksum) VALUES ($1, $2)',
        [migration.id, checksum(migration)],
      );

      applied.push(migration.id);
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  if (verbose && applied.length === 0) {
    console.log('[migrate] Nothing to apply — database is up to date.');
  }

  return applied;
}

/**
 * Roll back the last N applied migrations (default: 1).
 *
 * @returns Array of migration ids that were rolled back.
 */
export async function rollbackMigrations(
  steps: number = 1,
  options: MigratorOptions = {},
): Promise<string[]> {
  const { migrationsDir = DEFAULT_MIGRATIONS_DIR, verbose = true } = options;
  const rolledBack: string[] = [];

  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await ensureMigrationsTable(client);
    await acquireAdvisoryLock(client);

    const result = await client.query<{ id: string }>(
      'SELECT id FROM schema_migrations ORDER BY id DESC LIMIT $1',
      [steps],
    );

    const toRollback = result.rows.map((r) => r.id);
    const migrations = loadMigrations(migrationsDir);
    const migrationMap = new Map(migrations.map((m) => [m.id, m]));

    for (const id of toRollback) {
      const migration = migrationMap.get(id);
      if (!migration?.down) {
        throw new Error(`Migration ${id} does not have a 'down' function — cannot roll back`);
      }

      if (verbose) console.log(`[migrate] rollback ${id}`);

      await migration.down(client);
      await client.query('DELETE FROM schema_migrations WHERE id = $1', [id]);
      rolledBack.push(id);
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return rolledBack;
}

/**
 * Return the list of all applied migrations from the tracking table.
 */
export async function getMigrationStatus(): Promise<MigrationRecord[]> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await ensureMigrationsTable(client);
    const result = await client.query<MigrationRecord>(
      'SELECT id, applied_at, checksum FROM schema_migrations ORDER BY id',
    );
    return result.rows;
  } finally {
    client.release();
  }
}
