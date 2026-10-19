import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createApp } from '../src/app';
import { EscrowService } from '../src/service';
import { MemoryRepository } from '../src/repo/memory';
import { SqliteRepository } from '../src/repo/sqlite';
import { EscrowRepository } from '../src/repo/types';
import { storageConfig } from '../src/config';
import { migrate } from '../src/repo/migrations';

describe.each(['memory', 'sqlite'] as const)('%s API persistence', driver => {
  let repo: EscrowRepository;
  let service: EscrowService;
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    repo = driver === 'memory' ? new MemoryRepository() : new SqliteRepository(':memory:');
    service = new EscrowService(repo);
    app = createApp(service);
  });
  afterEach(async () => { jest.restoreAllMocks(); await app.locals.close(); });

  it('runs the lifecycle and prevents duplicate releases and ratings', async () => {
    const { body: c } = await request(app).post('/api/v1/contracts').send({ client: 'GA', freelancer: 'GB', milestones: [100, 50] }).expect(201);
    await request(app).post(`/api/v1/contracts/${c.id}/deposit`).send({ amount: 150 }).expect(200);
    const releases = await Promise.all([0, 0].map(i => request(app).post(`/api/v1/contracts/${c.id}/milestones/${i}/release`)));
    expect(releases.map(r => r.status).sort()).toEqual([200, 409]);
    const done = await request(app).post(`/api/v1/contracts/${c.id}/milestones/1/release`).expect(200);
    expect(done.body.status).toBe('Completed');
    const ratings = await Promise.all([4, 5].map(rating => request(app).post(`/api/v1/contracts/${c.id}/reputation`).send({ rating })));
    expect(ratings.map(r => r.status).sort()).toEqual([200, 409]);
    expect((await service.getReputation('GB')).completedContracts).toBe(1);
    expect(done.body.updatedAt > c.updatedAt).toBe(true);
    const health = await request(app).get('/health').expect(200);
    expect(health.body.storage).toBe(driver);
  });

  it('handles disputes, rejects outsiders and preserves the split', async () => {
    const c = await service.create({ client: 'GC', freelancer: 'GD', milestones: [200] });
    await request(app).post(`/api/v1/contracts/${c.id}/deposit`).send({ amount: 200 }).expect(200);
    await request(app).post(`/api/v1/contracts/${c.id}/dispute`).send({ raisedBy: 'GX' }).expect(403);
    await request(app).post(`/api/v1/contracts/${c.id}/dispute`).send({ raisedBy: 'GD', reason: 'late' }).expect(200);
    await request(app).post(`/api/v1/contracts/${c.id}/resolve`).send({ freelancerBps: 10001 }).expect(400);
    const r = await request(app).post(`/api/v1/contracts/${c.id}/resolve`).send({ freelancerBps: 5000 }).expect(200);
    expect(r.body).toMatchObject({ status: 'Resolved', releasedAmount: 100, fundedAmount: 100, dispute: { freelancerBps: 5000, reason: 'late' } });
  });

  it('rolls back a mutation that fails after both reputation and contract writes', async () => {
    const c = await service.create({ client: 'GA', freelancer: 'GB', milestones: [100] });
    await service.deposit(c.id, 100);
    const before = await service.release(c.id, 0);
    const update = repo.update.bind(repo);
    jest.spyOn(repo, 'update').mockImplementationOnce(async (...args) => { await update(...args); throw new Error('injected failure'); });
    const failed = await request(app).post(`/api/v1/contracts/${c.id}/reputation`).send({ rating: 5 }).expect(500);
    expect(failed.body).toEqual({ error: 'internal_error', message: 'Unexpected error' });
    expect(await service.get(c.id)).toEqual(before);
    expect((await service.getReputation('GB')).completedContracts).toBe(0);
    expect((await service.rate(c.id, 5)).averageRating).toBe(5);
  });

  it('forwards asynchronous read rejection to the error handler', async () => {
    jest.spyOn(repo, 'list').mockRejectedValueOnce(new Error('private database detail'));
    const r = await request(app).get('/api/v1/contracts').expect(500);
    expect(r.body).toEqual({ error: 'internal_error', message: 'Unexpected error' });
  });

  it('seeds only an empty repository, including concurrent initialization', async () => {
    await Promise.all([service.seed(), service.seed()]);
    expect((await service.list()).length).toBe(2);
    expect((await service.getReputation('GFREELANCERDEMOBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB')).completedContracts).toBe(1);
  });

  it('cancels and filters contracts without losing released funds', async () => {
    const c = await service.create({ client: 'GA', freelancer: 'GB', milestones: [50, 50] });
    await service.deposit(c.id, 100);
    await service.release(c.id, 0);
    await request(app).post(`/api/v1/contracts/${c.id}/cancel`).expect(200);
    const { body } = await request(app).get('/api/v1/contracts?party=GB&status=Cancelled').expect(200);
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({ fundedAmount: 50, releasedAmount: 50 });
    expect(await service.stats()).toEqual({ contracts: 1, byStatus: { Cancelled: 1 }, totalEscrowed: 0, totalReleased: 50 });
  });
});

describe('SQLite file and configuration', () => {
  let directory: string;
  const opened: EscrowRepository[] = [];
  const oldEnv = { ...process.env };
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'talenttrust-')); });
  afterEach(async () => {
    for (const repo of opened.splice(0)) await repo.close();
    process.env = { ...oldEnv };
    rmSync(directory, { recursive: true, force: true });
  });
  function open() { const repo = new SqliteRepository(join(directory, 'data', 'test.db')); opened.push(repo); return repo; }

  it('retains funded contracts, reputation and IDs across app/database restart', async () => {
    const first = new EscrowService(open());
    const app = createApp(first);
    const { body: c } = await request(app).post('/api/v1/contracts').send({ client: 'GA', freelancer: 'GB', milestones: [100] }).expect(201);
    const funded = await request(app).post(`/api/v1/contracts/${c.id}/deposit`).send({ amount: 100 }).expect(200);
    const rated = await first.create({ client: 'GA', freelancer: 'GB', milestones: [50] });
    await first.deposit(rated.id, 50); await first.release(rated.id, 0); await first.rate(rated.id, 4);
    await app.locals.close();
    const second = new EscrowService(open());
    const restarted = createApp(second);
    expect((await request(restarted).get(`/api/v1/contracts/${c.id}`).expect(200)).body).toEqual(funded.body);
    expect((await request(restarted).get('/api/v1/reputation/GB').expect(200)).body).toMatchObject({ completedContracts: 1, averageRating: 4 });
    await second.seed();
    expect(await second.list()).toHaveLength(2);
    expect((await second.create({ client: 'GC', freelancer: 'GD', milestones: [1] })).id).toBe(3);
    await restarted.locals.close();
    const db = new Database(join(directory, 'data', 'test.db'));
    try { expect(db.prepare('SELECT version FROM schema_version').all()).toEqual([{ version: 1 }]); }
    finally { db.close(); }
  });

  it('serializes independent connections without losing deposits or colliding IDs', async () => {
    const first = new EscrowService(open());
    const second = new EscrowService(open());
    const contracts = await Promise.all([first, second].map(service => service.create({ client: 'GA', freelancer: 'GB', milestones: [100] })));
    expect(new Set(contracts.map(c => c.id)).size).toBe(2);
    await Promise.all([first.deposit(contracts[0].id, 40), second.deposit(contracts[0].id, 60)]);
    expect(await first.get(contracts[0].id)).toMatchObject({ fundedAmount: 100, status: 'Funded' });
  });

  it('selects SQLite from environment and disables demo data', async () => {
    process.env.STORAGE_DRIVER = 'sqlite';
    process.env.SQLITE_PATH = join(directory, 'configured.db');
    process.env.SEED_DEMO_DATA = 'false';
    const app = createApp();
    try {
      expect((await request(app).get('/health')).body.storage).toBe('sqlite');
      expect((await request(app).get('/api/v1/contracts')).body.data).toEqual([]);
    } finally { await app.locals.close(); }
  });

  it('defaults to seeded memory and rejects unsupported drivers', async () => {
    delete process.env.STORAGE_DRIVER; delete process.env.SEED_DEMO_DATA; delete process.env.SQLITE_PATH;
    expect(storageConfig()).toEqual({ driver: 'memory', path: './data/talenttrust.db', seedDemoData: true });
    const app = createApp();
    try { expect((await request(app).get('/api/v1/contracts')).body.data).toHaveLength(2); }
    finally { await app.locals.close(); }
    process.env.STORAGE_DRIVER = 'unknown';
    expect(() => createApp()).toThrow('STORAGE_DRIVER');
  });

  it('migrates idempotently, rejects newer schemas, and rolls back a failed migration', () => {
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE reputation (address TEXT)');
      expect(() => migrate(db)).toThrow();
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('contracts', 'schema_version')").all()).toEqual([]);
      db.exec('DROP TABLE reputation');
      migrate(db); migrate(db);
      expect(db.prepare('SELECT version FROM schema_version').all()).toEqual([{ version: 1 }]);
      db.prepare('INSERT INTO schema_version VALUES (?)').run(99);
      expect(() => migrate(db)).toThrow('newer');
    } finally { db.close(); }
  });

  it('documents the changed health response and storage/conflict errors', async () => {
    const app = createApp(new EscrowService(new MemoryRepository()));
    try {
      const { body: spec } = await request(app).get('/openapi.json').expect(200);
      expect(spec.openapi).toBe('3.0.3');
      expect(spec.components.schemas.Health.properties.storage.enum).toEqual(['memory', 'sqlite']);
      expect(spec.paths['/health'].get.responses['200'].content['application/json'].schema.$ref).toBe('#/components/schemas/Health');
      expect(spec.paths['/api/v1/contracts/{id}/deposit'].post.responses).toHaveProperty('409');
      expect(spec.paths['/api/v1/contracts'].get.responses).toHaveProperty('500');
    } finally { await app.locals.close(); }
  });
});
