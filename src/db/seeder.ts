/**
 * @module db/seeder
 * @description Deterministic, idempotent seed data manager.
 *
 * ## Design
 * - Seeds are plain TypeScript files that export a `run` function and a
 *   unique `id` string.
 * - A `seed_history` table tracks which seeds have been applied and when.
 * - Seeds are designed to be idempotent: re-running them produces the same
 *   result (typically using INSERT … ON CONFLICT DO NOTHING or UPSERT).
 * - Seeds are ordered lexicographically by filename.
 * - An optional `--force` flag allows re-running seeds that were already
 *   applied (useful in development to reset to a known state).
 *
 * ## Security Assumptions
 * - Seeds should never be run in production unless explicitly opted-in via
 *   ALLOW_PRODUCTION_SEED=true environment variable.
 * - Seed files are loaded from a known directory; user paths are not accepted.
 * - All SQL within seeds must use parameterised queries.
 */

import path from 'path';
import fs from 'fs';
import { PoolClient } from 'pg';
import { getPool } from './connection';

export interface Seed {
  /** Unique seed identifier (derived from filename). */
  id: string;
  /** Human-readable description of what this seed does. */
  description: string;
  /** Execute the seed against the provided client. */
  run: (client: PoolClient) => Promise<void>;
}

export interface SeedRecord {
  id: string;
  applied_at: Date;
  environment: string;
}

export interface SeederOptions {
  /** Absolute path to the seeds directory. */
  seedsDir?: string;
  /** Re-run seeds even if already applied. Default: false. */
  force?: boolean;
  /** Whether to emit progress logs. Default: true. */
  verbose?: boolean;
  /** Target environment. Defaults to NODE_ENV. */
  environment?: string;
}

const DEFAULT_SEEDS_DIR = path.resolve(__dirname, '../seeds');

/**
 * Ensure the seed_history tracking table exists.
 */
async function ensureSeedTable(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS seed_history (
      id          TEXT        NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      environment TEXT        NOT NULL,
      PRIMARY KEY (id, environment)
    )
  `);
}

/**
 * Fetch the set of already-applied seed ids for the current environment.
 */
async function appliedSeedIds(
  client: PoolClient,
  environment: string,
): Promise<Set<string>> {
  const result = await client.query<{ id: string }>(
    'SELECT id FROM seed_history WHERE environment = $1',
    [environment],
  );
  return new Set(result.rows.map((r) => r.id));
}

/**
 * Load all seed modules from the seeds directory, sorted by id.
 */
export function loadSeeds(seedsDir: string = DEFAULT_SEEDS_DIR): Seed[] {
  if (!fs.existsSync(seedsDir)) {
    return [];
  }

  const files = fs
    .readdirSync(seedsDir)
    .filter((f) => f.endsWith('.ts') || f.endsWith('.js'))
    .sort();

  return files.map((file) => {
    const id = file.replace(/\.(ts|js)$/, '');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(path.join(seedsDir, file)) as Seed;
    if (typeof mod.run !== 'function') {
      throw new Error(`Seed ${file} must export a 'run' function`);
    }
    return { ...mod, id };
  });
}

/**
 * Run all pending seeds in order.
 *
 * @returns Array of seed ids that were applied in this run.
 */
export async function runSeeds(options: SeederOptions = {}): Promise<string[]> {
  const {
    seedsDir = DEFAULT_SEEDS_DIR,
    force = false,
    verbose = true,
    environment = process.env.NODE_ENV ?? 'development',
  } = options;

  // Safety guard: refuse to seed production unless explicitly allowed
  if (
    environment === 'production' &&
    process.env.ALLOW_PRODUCTION_SEED !== 'true'
  ) {
    throw new Error(
      'Seeding in production is disabled. Set ALLOW_PRODUCTION_SEED=true to override.',
    );
  }

  const applied: string[] = [];
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await ensureSeedTable(client);

    const alreadyApplied = force
      ? new Set<string>()
      : await appliedSeedIds(client, environment);

    const seeds = loadSeeds(seedsDir);

    for (const seed of seeds) {
      if (alreadyApplied.has(seed.id)) {
        if (verbose) console.log(`[seed] skip  ${seed.id}`);
        continue;
      }

      if (verbose) console.log(`[seed] apply ${seed.id} — ${seed.description}`);

      await seed.run(client);

      await client.query(
        `INSERT INTO seed_history (id, environment)
         VALUES ($1, $2)
         ON CONFLICT (id, environment) DO UPDATE SET applied_at = NOW()`,
        [seed.id, environment],
      );

      applied.push(seed.id);
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  if (verbose && applied.length === 0) {
    console.log('[seed] Nothing to apply — all seeds already run.');
  }

  return applied;
}

/**
 * Return the list of all applied seeds from the tracking table.
 */
export async function getSeedStatus(
  environment: string = process.env.NODE_ENV ?? 'development',
): Promise<SeedRecord[]> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await ensureSeedTable(client);
    const result = await client.query<SeedRecord>(
      'SELECT id, applied_at, environment FROM seed_history WHERE environment = $1 ORDER BY id',
      [environment],
    );
    return result.rows;
  } finally {
    client.release();
  }
}
