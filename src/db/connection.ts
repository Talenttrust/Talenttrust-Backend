/**
 * @module db/connection
 * @description Database connection pool for TalentTrust Backend.
 *
 * Manages a singleton PostgreSQL connection pool using the `pg` library.
 * Configuration is driven entirely by environment variables so that no
 * credentials are ever hard-coded.
 *
 * ## Environment Variables
 * | Variable       | Default       | Description                  |
 * |----------------|---------------|------------------------------|
 * | DATABASE_URL   | —             | Full Postgres connection URL  |
 * | DB_HOST        | localhost     | Postgres host                |
 * | DB_PORT        | 5432          | Postgres port                |
 * | DB_NAME        | talenttrust   | Database name                |
 * | DB_USER        | postgres      | Database user                |
 * | DB_PASSWORD    | —             | Database password            |
 * | DB_POOL_MAX    | 10            | Maximum pool connections     |
 * | DB_POOL_IDLE   | 30000         | Idle timeout (ms)            |
 *
 * ## Security Assumptions
 * - DATABASE_URL or DB_PASSWORD must be supplied via environment — never
 *   committed to source control.
 * - SSL is enforced in production (NODE_ENV=production).
 * - Pool size is capped to prevent connection exhaustion attacks.
 */

import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

export interface DbConfig {
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  max?: number;
  idleTimeoutMillis?: number;
  ssl?: boolean | { rejectUnauthorized: boolean };
}

/**
 * Build pool configuration from environment variables.
 */
export function buildConfig(env: NodeJS.ProcessEnv = process.env): DbConfig {
  const isProduction = env.NODE_ENV === 'production';

  const config: DbConfig = {
    max: parseInt(env.DB_POOL_MAX ?? '10', 10),
    idleTimeoutMillis: parseInt(env.DB_POOL_IDLE ?? '30000', 10),
  };

  if (env.DATABASE_URL) {
    config.connectionString = env.DATABASE_URL;
    if (isProduction) {
      config.ssl = { rejectUnauthorized: true };
    }
  } else {
    config.host = env.DB_HOST ?? 'localhost';
    config.port = parseInt(env.DB_PORT ?? '5432', 10);
    config.database = env.DB_NAME ?? 'talenttrust';
    config.user = env.DB_USER ?? 'postgres';
    config.password = env.DB_PASSWORD;
    if (isProduction) {
      config.ssl = { rejectUnauthorized: true };
    }
  }

  return config;
}

let _pool: Pool | null = null;

/**
 * Returns the singleton connection pool, creating it on first call.
 *
 * @param config - Optional override config (used in tests).
 */
export function getPool(config?: DbConfig): Pool {
  if (!_pool) {
    _pool = new Pool(config ?? buildConfig());

    _pool.on('error', (err: Error) => {
      console.error('[db] Unexpected pool error:', err.message);
    });
  }
  return _pool;
}

/**
 * Execute a parameterised query against the pool.
 *
 * @param text   - SQL query string with `$1`, `$2` … placeholders.
 * @param params - Ordered parameter values.
 */
export async function query<R extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<QueryResult<R>> {
  const pool = getPool();
  return pool.query<R>(text, params);
}

/**
 * Acquire a client from the pool and run `fn` inside a transaction.
 * Automatically commits on success and rolls back on error.
 *
 * @param fn - Async function receiving the pool client.
 */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Close the pool. Should be called on process exit or in test teardown.
 */
export async function closePool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}

/**
 * Reset the singleton pool (used in tests to inject a fresh pool).
 * @internal
 */
export function _resetPool(): void {
  _pool = null;
}
