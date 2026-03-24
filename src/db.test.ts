/**
 * @file db/connection.test.ts
 * @description Unit and integration tests for the database connection module,
 * migrator, seeder, and admin API endpoints.
 *
 * All database calls are mocked using jest.mock so no real Postgres instance
 * is required. Integration-style tests verify the full request/response cycle
 * via supertest.
 */

import { buildConfig, _resetPool, getPool, withTransaction, closePool } from './db/connection';
import { loadMigrations, runMigrations, rollbackMigrations, getMigrationStatus } from './db/migrator';
import { loadSeeds, runSeeds, getSeedStatus } from './db/seeder';
import { app } from './index';
import path from 'path';
import fs from 'fs';

// ============================================================================
// Helpers — lightweight mock pool factory
// ============================================================================

function makeMockClient(queryResponses: Record<string, unknown[]> = {}) {
  const calls: Array<{ text: string; params: unknown[] }> = [];

  const client = {
    query: jest.fn(async (text: string, params: unknown[] = []) => {
      calls.push({ text, params });
      const key = Object.keys(queryResponses).find((k) => text.includes(k));
      const rows = key ? queryResponses[key] : [];
      return { rows, rowCount: (rows as unknown[]).length };
    }),
    release: jest.fn(),
    calls,
  };

  return client;
}

function makeMockPool(client: ReturnType<typeof makeMockClient>) {
  return {
    query: client.query,
    connect: jest.fn(async () => client),
    end: jest.fn(async () => undefined),
    on: jest.fn(),
  };
}

// ============================================================================
// db/connection — buildConfig
// ============================================================================

describe('buildConfig', () => {
  it('uses DATABASE_URL when provided', () => {
    const cfg = buildConfig({ DATABASE_URL: 'postgres://user:pass@host/db' });
    expect(cfg.connectionString).toBe('postgres://user:pass@host/db');
    expect(cfg.host).toBeUndefined();
  });

  it('falls back to individual fields when no DATABASE_URL', () => {
    const cfg = buildConfig({
      DB_HOST: 'myhost',
      DB_PORT: '5433',
      DB_NAME: 'mydb',
      DB_USER: 'myuser',
      DB_PASSWORD: 'secret',
    });
    expect(cfg.host).toBe('myhost');
    expect(cfg.port).toBe(5433);
    expect(cfg.database).toBe('mydb');
    expect(cfg.user).toBe('myuser');
    expect(cfg.password).toBe('secret');
  });

  it('defaults host to localhost and port to 5432', () => {
    const cfg = buildConfig({});
    expect(cfg.host).toBe('localhost');
    expect(cfg.port).toBe(5432);
  });

  it('enables SSL in production with DATABASE_URL', () => {
    const cfg = buildConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://host/db',
    });
    expect(cfg.ssl).toEqual({ rejectUnauthorized: true });
  });

  it('enables SSL in production without DATABASE_URL', () => {
    const cfg = buildConfig({ NODE_ENV: 'production', DB_PASSWORD: 'pw' });
    expect(cfg.ssl).toEqual({ rejectUnauthorized: true });
  });

  it('respects DB_POOL_MAX and DB_POOL_IDLE', () => {
    const cfg = buildConfig({ DB_POOL_MAX: '5', DB_POOL_IDLE: '60000' });
    expect(cfg.max).toBe(5);
    expect(cfg.idleTimeoutMillis).toBe(60000);
  });

  it('defaults pool max to 10 and idle to 30000', () => {
    const cfg = buildConfig({});
    expect(cfg.max).toBe(10);
    expect(cfg.idleTimeoutMillis).toBe(30000);
  });
});

// ============================================================================
// db/connection — getPool / closePool
// ============================================================================

describe('getPool', () => {
  beforeEach(() => _resetPool());
  afterEach(() => _resetPool());

  it('returns a pool instance', () => {
    const pg = require('pg');
    const spy = jest.spyOn(pg, 'Pool').mockImplementation(() => ({
      on: jest.fn(),
      end: jest.fn(),
      query: jest.fn(),
      connect: jest.fn(),
    }));
    const pool = getPool({ host: 'localhost', database: 'test' });
    expect(pool).toBeDefined();
    spy.mockRestore();
  });

  it('returns the same singleton on subsequent calls', () => {
    const pg = require('pg');
    const spy = jest.spyOn(pg, 'Pool').mockImplementation(() => ({
      on: jest.fn(),
      end: jest.fn(),
    }));
    const p1 = getPool({});
    const p2 = getPool({});
    expect(p1).toBe(p2);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

describe('closePool', () => {
  beforeEach(() => _resetPool());
  afterEach(() => _resetPool());

  it('calls pool.end() and resets singleton', async () => {
    const endMock = jest.fn(async () => undefined);
    const pg = require('pg');
    jest.spyOn(pg, 'Pool').mockImplementation(() => ({
      on: jest.fn(),
      end: endMock,
    }));
    getPool({});
    await closePool();
    expect(endMock).toHaveBeenCalledTimes(1);
    // After close, a new pool should be created on next getPool call
    jest.spyOn(pg, 'Pool').mockImplementation(() => ({ on: jest.fn(), end: jest.fn() }));
    const newPool = getPool({});
    expect(newPool).toBeDefined();
  });

  it('is a no-op when pool is already null', async () => {
    await expect(closePool()).resolves.toBeUndefined();
  });
});

// ============================================================================
// db/connection — withTransaction
// ============================================================================

describe('withTransaction', () => {
  beforeEach(() => _resetPool());
  afterEach(() => _resetPool());

  it('commits on success', async () => {
    const client = makeMockClient();
    const pool = makeMockPool(client);
    const pg = require('pg');
    jest.spyOn(pg, 'Pool').mockImplementation(() => pool);

    getPool({});
    const result = await withTransaction(async (c) => {
      await c.query('SELECT 1');
      return 42;
    });

    expect(result).toBe(42);
    expect(client.query).toHaveBeenCalledWith('BEGIN');
    expect(client.query).toHaveBeenCalledWith('COMMIT');
    expect(client.release).toHaveBeenCalled();
  });

  it('rolls back on error', async () => {
    const client = makeMockClient();
    const pool = makeMockPool(client);
    const pg = require('pg');
    jest.spyOn(pg, 'Pool').mockImplementation(() => pool);

    getPool({});

    await expect(
      withTransaction(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalled();
  });
});

// ============================================================================
// db/migrator — loadMigrations
// ============================================================================

describe('loadMigrations', () => {
  it('returns empty array when directory does not exist', () => {
    const migrations = loadMigrations('/non/existent/path');
    expect(migrations).toEqual([]);
  });

  it('loads and sorts migration files by name', () => {
    // Point at our actual migrations directory
    const dir = path.resolve(__dirname, 'migrations');
    if (!fs.existsSync(dir)) return; // skip if not present in test env

    const migrations = loadMigrations(dir);
    const ids = migrations.map((m) => m.id);
    expect(ids).toEqual([...ids].sort());
    migrations.forEach((m) => {
      expect(typeof m.up).toBe('function');
    });
  });

  it('throws if a migration file is missing an up function', () => {
    const tmpDir = fs.mkdtempSync('/tmp/tt-migrations-');
    fs.writeFileSync(
      path.join(tmpDir, '0001_bad.js'),
      `module.exports = { id: '0001_bad' }`, // no up function
    );
    expect(() => loadMigrations(tmpDir)).toThrow("must export an 'up' function");
    fs.rmSync(tmpDir, { recursive: true });
  });
});

// ============================================================================
// db/migrator — runMigrations
// ============================================================================

describe('runMigrations', () => {
  beforeEach(() => _resetPool());
  afterEach(() => _resetPool());

  function setupPool(appliedIds: string[] = []) {
    const client = makeMockClient({
      'SELECT id FROM schema_migrations': appliedIds.map((id) => ({ id })),
    });
    const pool = makeMockPool(client);
    const pg = require('pg');
    jest.spyOn(pg, 'Pool').mockImplementation(() => pool);
    getPool({});
    return client;
  }

  it('creates schema_migrations table if not present', async () => {
    const tmpDir = fs.mkdtempSync('/tmp/tt-migrate-');
    const client = setupPool();

    await runMigrations({ migrationsDir: tmpDir, verbose: false });

    const calls = client.calls.map((c) => c.text);
    expect(calls.some((t) => t.includes('CREATE TABLE IF NOT EXISTS schema_migrations'))).toBe(true);

    fs.rmSync(tmpDir, { recursive: true });
  });

  it('skips already-applied migrations', async () => {
    const tmpDir = fs.mkdtempSync('/tmp/tt-migrate-');
    // Write a fake migration
    fs.writeFileSync(
      path.join(tmpDir, '0001_test.js'),
      `module.exports = { id: '0001_test', up: async () => {}, down: async () => {} }`,
    );

    const client = setupPool(['0001_test']); // already applied

    const applied = await runMigrations({ migrationsDir: tmpDir, verbose: false });
    expect(applied).toEqual([]);

    const insertCalls = client.calls.filter((c) => c.text.includes('INSERT INTO schema_migrations'));
    expect(insertCalls).toHaveLength(0);

    fs.rmSync(tmpDir, { recursive: true });
  });

  it('applies pending migrations and records them', async () => {
    const tmpDir = fs.mkdtempSync('/tmp/tt-migrate-');
    fs.writeFileSync(
      path.join(tmpDir, '0001_test.js'),
      `module.exports = { id: '0001_test', up: async (client) => { await client.query('CREATE TABLE t (id int)'); }, down: async () => {} }`,
    );

    const client = setupPool([]); // nothing applied yet

    const applied = await runMigrations({ migrationsDir: tmpDir, verbose: false });
    expect(applied).toEqual(['0001_test']);

    const insertCalls = client.calls.filter((c) => c.text.includes('INSERT INTO schema_migrations'));
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0].params[0]).toBe('0001_test');

    fs.rmSync(tmpDir, { recursive: true });
  });

  it('rolls back transaction on migration error', async () => {
    const tmpDir = fs.mkdtempSync('/tmp/tt-migrate-');
    fs.writeFileSync(
      path.join(tmpDir, '0001_fail.js'),
      `module.exports = { id: '0001_fail', up: async () => { throw new Error('migration failed'); } }`,
    );

    const client = setupPool([]);

    await expect(
      runMigrations({ migrationsDir: tmpDir, verbose: false }),
    ).rejects.toThrow('migration failed');

    expect(client.query).toHaveBeenCalledWith('ROLLBACK');

    fs.rmSync(tmpDir, { recursive: true });
  });

  it('acquires advisory lock before running migrations', async () => {
    const tmpDir = fs.mkdtempSync('/tmp/tt-migrate-');
    const client = setupPool([]);

    await runMigrations({ migrationsDir: tmpDir, verbose: false });

    const lockCalls = client.calls.filter((c) =>
      c.text.includes('pg_advisory_xact_lock'),
    );
    expect(lockCalls.length).toBeGreaterThanOrEqual(1);

    fs.rmSync(tmpDir, { recursive: true });
  });
});

// ============================================================================
// db/migrator — rollbackMigrations
// ============================================================================

describe('rollbackMigrations', () => {
  beforeEach(() => _resetPool());
  afterEach(() => _resetPool());

  it('throws if migration has no down function', async () => {
    const tmpDir = fs.mkdtempSync('/tmp/tt-rollback-');
    fs.writeFileSync(
      path.join(tmpDir, '0001_nodown.js'),
      `module.exports = { id: '0001_nodown', up: async () => {} }`,
    );

    const client = makeMockClient({
      'SELECT id FROM schema_migrations ORDER BY id DESC': [{ id: '0001_nodown' }],
    });
    const pool = makeMockPool(client);
    const pg = require('pg');
    jest.spyOn(pg, 'Pool').mockImplementation(() => pool);
    getPool({});

    await expect(
      rollbackMigrations(1, { migrationsDir: tmpDir, verbose: false }),
    ).rejects.toThrow("does not have a 'down' function");

    fs.rmSync(tmpDir, { recursive: true });
  });

  it('rolls back migration and deletes record', async () => {
    const tmpDir = fs.mkdtempSync('/tmp/tt-rollback-');
    const downFn = jest.fn(async () => {});
    fs.writeFileSync(
      path.join(tmpDir, '0001_withdown.js'),
      `module.exports = { id: '0001_withdown', up: async () => {}, down: async (c) => { await c.query('DROP TABLE t'); } }`,
    );

    const client = makeMockClient({
      'SELECT id FROM schema_migrations ORDER BY id DESC': [{ id: '0001_withdown' }],
    });
    const pool = makeMockPool(client);
    const pg = require('pg');
    jest.spyOn(pg, 'Pool').mockImplementation(() => pool);
    getPool({});

    const rolled = await rollbackMigrations(1, { migrationsDir: tmpDir, verbose: false });
    expect(rolled).toEqual(['0001_withdown']);

    const deleteCalls = client.calls.filter((c) =>
      c.text.includes('DELETE FROM schema_migrations'),
    );
    expect(deleteCalls).toHaveLength(1);

    fs.rmSync(tmpDir, { recursive: true });
  });
});

// ============================================================================
// db/migrator — getMigrationStatus
// ============================================================================

describe('getMigrationStatus', () => {
  beforeEach(() => _resetPool());
  afterEach(() => _resetPool());

  it('returns applied migrations from schema_migrations', async () => {
    const now = new Date();
    const client = makeMockClient({
      'SELECT id, applied_at, checksum': [
        { id: '0001_test', applied_at: now, checksum: 'abc' },
      ],
    });
    const pool = makeMockPool(client);
    const pg = require('pg');
    jest.spyOn(pg, 'Pool').mockImplementation(() => pool);
    getPool({});

    const status = await getMigrationStatus();
    expect(status).toHaveLength(1);
    expect(status[0].id).toBe('0001_test');
  });
});

// ============================================================================
// db/seeder — loadSeeds
// ============================================================================

describe('loadSeeds', () => {
  it('returns empty array when directory does not exist', () => {
    const seeds = loadSeeds('/non/existent/path');
    expect(seeds).toEqual([]);
  });

  it('throws if a seed file is missing a run function', () => {
    const tmpDir = fs.mkdtempSync('/tmp/tt-seeds-');
    fs.writeFileSync(
      path.join(tmpDir, '0001_bad.js'),
      `module.exports = { id: '0001_bad', description: 'bad seed' }`,
    );
    expect(() => loadSeeds(tmpDir)).toThrow("must export a 'run' function");
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('loads and sorts seed files by name', () => {
    const tmpDir = fs.mkdtempSync('/tmp/tt-seeds-');
    ['0002_b.js', '0001_a.js'].forEach((f) => {
      fs.writeFileSync(
        path.join(tmpDir, f),
        `module.exports = { id: '${f}', description: 'x', run: async () => {} }`,
      );
    });
    const seeds = loadSeeds(tmpDir);
    expect(seeds[0].id).toBe('0001_a.js');
    expect(seeds[1].id).toBe('0002_b.js');
    fs.rmSync(tmpDir, { recursive: true });
  });
});

// ============================================================================
// db/seeder — runSeeds
// ============================================================================

describe('runSeeds', () => {
  beforeEach(() => _resetPool());
  afterEach(() => _resetPool());

  function setupPool(appliedIds: string[] = []) {
    const client = makeMockClient({
      'SELECT id FROM seed_history': appliedIds.map((id) => ({ id })),
    });
    const pool = makeMockPool(client);
    const pg = require('pg');
    jest.spyOn(pg, 'Pool').mockImplementation(() => pool);
    getPool({});
    return client;
  }

  it('throws when run in production without override', async () => {
    await expect(
      runSeeds({ environment: 'production', verbose: false }),
    ).rejects.toThrow('Seeding in production is disabled');
  });

  it('allows production seed when ALLOW_PRODUCTION_SEED=true', async () => {
    process.env.ALLOW_PRODUCTION_SEED = 'true';
    const tmpDir = fs.mkdtempSync('/tmp/tt-seeds-prod-');
    setupPool([]);

    await expect(
      runSeeds({ environment: 'production', seedsDir: tmpDir, verbose: false }),
    ).resolves.toEqual([]);

    delete process.env.ALLOW_PRODUCTION_SEED;
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('skips already-applied seeds', async () => {
    const tmpDir = fs.mkdtempSync('/tmp/tt-seeds-');
    fs.writeFileSync(
      path.join(tmpDir, '0001_test.js'),
      `module.exports = { id: '0001_test', description: 'x', run: async () => {} }`,
    );

    const client = setupPool(['0001_test']);
    const applied = await runSeeds({ seedsDir: tmpDir, verbose: false, environment: 'test' });
    expect(applied).toEqual([]);

    fs.rmSync(tmpDir, { recursive: true });
  });

  it('applies pending seeds and records them', async () => {
    const tmpDir = fs.mkdtempSync('/tmp/tt-seeds-');
    fs.writeFileSync(
      path.join(tmpDir, '0001_test.js'),
      `module.exports = { id: '0001_test', description: 'x', run: async (c) => { await c.query('INSERT INTO t VALUES (1)'); } }`,
    );

    const client = setupPool([]);
    const applied = await runSeeds({ seedsDir: tmpDir, verbose: false, environment: 'test' });
    expect(applied).toEqual(['0001_test']);

    const insertCalls = client.calls.filter((c) => c.text.includes('INSERT INTO seed_history'));
    expect(insertCalls).toHaveLength(1);

    fs.rmSync(tmpDir, { recursive: true });
  });

  it('re-runs seeds when force=true', async () => {
    const tmpDir = fs.mkdtempSync('/tmp/tt-seeds-');
    fs.writeFileSync(
      path.join(tmpDir, '0001_test.js'),
      `module.exports = { id: '0001_test', description: 'x', run: async () => {} }`,
    );

    const client = setupPool(['0001_test']); // already applied
    const applied = await runSeeds({
      seedsDir: tmpDir,
      verbose: false,
      environment: 'test',
      force: true,
    });
    expect(applied).toEqual(['0001_test']);

    fs.rmSync(tmpDir, { recursive: true });
  });

  it('rolls back transaction on seed error', async () => {
    const tmpDir = fs.mkdtempSync('/tmp/tt-seeds-');
    fs.writeFileSync(
      path.join(tmpDir, '0001_fail.js'),
      `module.exports = { id: '0001_fail', description: 'x', run: async () => { throw new Error('seed failed'); } }`,
    );

    const client = setupPool([]);
    await expect(
      runSeeds({ seedsDir: tmpDir, verbose: false, environment: 'test' }),
    ).rejects.toThrow('seed failed');

    expect(client.query).toHaveBeenCalledWith('ROLLBACK');

    fs.rmSync(tmpDir, { recursive: true });
  });
});

// ============================================================================
// db/seeder — getSeedStatus
// ============================================================================

describe('getSeedStatus', () => {
  beforeEach(() => _resetPool());
  afterEach(() => _resetPool());

  it('returns applied seeds for the environment', async () => {
    const now = new Date();
    const client = makeMockClient({
      'SELECT id, applied_at, environment': [
        { id: '0001_test', applied_at: now, environment: 'test' },
      ],
    });
    const pool = makeMockPool(client);
    const pg = require('pg');
    jest.spyOn(pg, 'Pool').mockImplementation(() => pool);
    getPool({});

    const status = await getSeedStatus('test');
    expect(status).toHaveLength(1);
    expect(status[0].id).toBe('0001_test');
  });
});

// ============================================================================
// Health endpoint
// ============================================================================

describe('GET /health', () => {
  it('returns status ok', async () => {
    const request = require('supertest');
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', service: 'talenttrust-backend' });
  });
});

// ============================================================================
// GET /api/v1/contracts
// ============================================================================

describe('GET /api/v1/contracts', () => {
  it('returns empty contracts array', async () => {
    const request = require('supertest');
    const res = await request(app).get('/api/v1/contracts');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ contracts: [] });
  });
});

// ============================================================================
// Admin endpoints — auth guard
// ============================================================================

describe('Admin auth guard', () => {
  const request = require('supertest');

  beforeEach(() => {
    process.env.ADMIN_SECRET = 'test-secret';
  });

  afterEach(() => {
    delete process.env.ADMIN_SECRET;
  });

  it('GET /admin/migrations returns 401 without secret', async () => {
    const res = await request(app).get('/admin/migrations');
    expect(res.status).toBe(401);
  });

  it('GET /admin/migrations returns 401 with wrong secret', async () => {
    const res = await request(app)
      .get('/admin/migrations')
      .set('x-admin-secret', 'wrong');
    expect(res.status).toBe(401);
  });

  it('GET /admin/seeds returns 401 without secret', async () => {
    const res = await request(app).get('/admin/seeds');
    expect(res.status).toBe(401);
  });

  it('returns 503 when ADMIN_SECRET is not configured', async () => {
    delete process.env.ADMIN_SECRET;
    const res = await request(app).get('/admin/migrations');
    expect(res.status).toBe(503);
  });
});

// ============================================================================
// Admin endpoints — GET /admin/migrations
// ============================================================================

describe('GET /admin/migrations', () => {
  beforeEach(() => {
    process.env.ADMIN_SECRET = 'test-secret';
    _resetPool();
  });
  afterEach(() => {
    delete process.env.ADMIN_SECRET;
    _resetPool();
  });

  it('returns migration list on success', async () => {
    const request = require('supertest');
    const now = new Date();

    const client = makeMockClient({
      'SELECT id, applied_at, checksum': [
        { id: '0001_initial_schema', applied_at: now, checksum: 'abc' },
      ],
    });
    const pool = makeMockPool(client);
    const pg = require('pg');
    jest.spyOn(pg, 'Pool').mockImplementation(() => pool);
    getPool({});

    const res = await request(app)
      .get('/admin/migrations')
      .set('x-admin-secret', 'test-secret');

    expect(res.status).toBe(200);
    expect(res.body.migrations).toHaveLength(1);
    expect(res.body.migrations[0].id).toBe('0001_initial_schema');
  });

  it('returns 500 on database error', async () => {
    const request = require('supertest');

    const client = {
      query: jest.fn().mockRejectedValue(new Error('db error')),
      release: jest.fn(),
    };
    const pool = makeMockPool(client as never);
    const pg = require('pg');
    jest.spyOn(pg, 'Pool').mockImplementation(() => pool);
    getPool({});

    const res = await request(app)
      .get('/admin/migrations')
      .set('x-admin-secret', 'test-secret');

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('db error');
  });
});

// ============================================================================
// Admin endpoints — POST /admin/migrations/run
// ============================================================================

describe('POST /admin/migrations/run', () => {
  beforeEach(() => {
    process.env.ADMIN_SECRET = 'test-secret';
    _resetPool();
  });
  afterEach(() => {
    delete process.env.ADMIN_SECRET;
    _resetPool();
  });

  it('returns applied migrations', async () => {
    const request = require('supertest');

    const client = makeMockClient({
      'SELECT id FROM schema_migrations': [],
    });
    const pool = makeMockPool(client);
    const pg = require('pg');
    jest.spyOn(pg, 'Pool').mockImplementation(() => pool);
    getPool({});

    const res = await request(app)
      .post('/admin/migrations/run')
      .set('x-admin-secret', 'test-secret');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.applied)).toBe(true);
  });
});

// ============================================================================
// Admin endpoints — GET /admin/seeds
// ============================================================================

describe('GET /admin/seeds', () => {
  beforeEach(() => {
    process.env.ADMIN_SECRET = 'test-secret';
    _resetPool();
  });
  afterEach(() => {
    delete process.env.ADMIN_SECRET;
    _resetPool();
  });

  it('returns seed list on success', async () => {
    const request = require('supertest');
    const now = new Date();

    const client = makeMockClient({
      'SELECT id, applied_at, environment': [
        { id: '0001_dev_users', applied_at: now, environment: 'test' },
      ],
    });
    const pool = makeMockPool(client);
    const pg = require('pg');
    jest.spyOn(pg, 'Pool').mockImplementation(() => pool);
    getPool({});

    const res = await request(app)
      .get('/admin/seeds')
      .set('x-admin-secret', 'test-secret');

    expect(res.status).toBe(200);
    expect(res.body.seeds).toHaveLength(1);
  });
});

// ============================================================================
// Admin endpoints — POST /admin/seeds/run
// ============================================================================

describe('POST /admin/seeds/run', () => {
  beforeEach(() => {
    process.env.ADMIN_SECRET = 'test-secret';
    _resetPool();
  });
  afterEach(() => {
    delete process.env.ADMIN_SECRET;
    _resetPool();
  });

  it('returns applied seeds', async () => {
    const request = require('supertest');

    const client = makeMockClient({
      'SELECT id FROM seed_history': [],
    });
    const pool = makeMockPool(client);
    const pg = require('pg');
    jest.spyOn(pg, 'Pool').mockImplementation(() => pool);
    getPool({});

    const res = await request(app)
      .post('/admin/seeds/run')
      .set('x-admin-secret', 'test-secret');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.applied)).toBe(true);
  });

  it('returns 500 on seed error', async () => {
    const request = require('supertest');

    const client = {
      query: jest.fn().mockRejectedValue(new Error('seed error')),
      release: jest.fn(),
    };
    const pool = makeMockPool(client as never);
    const pg = require('pg');
    jest.spyOn(pg, 'Pool').mockImplementation(() => pool);
    getPool({});

    const res = await request(app)
      .post('/admin/seeds/run')
      .set('x-admin-secret', 'test-secret');

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('seed error');
  });
});

// ============================================================================
// Existing health test (preserved)
// ============================================================================

describe('health', () => {
  it('should pass', () => {
    expect(true).toBe(true);
  });
});
