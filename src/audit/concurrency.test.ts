import express from 'express';
import request from 'supertest';
import { AuditStore, GENESIS_HASH } from './store';
import { AuditService } from './service';
import { SqliteAuditRepository } from './sqliteRepository';
import { createAuditRouter } from './router';
import Database from '../db/betterSqlite3';
import type { AuditLogRepository } from './repository';
import type { CreateAuditEntryInput } from './types';

function makeInput(overrides: Partial<CreateAuditEntryInput> = {}): CreateAuditEntryInput {
  return {
    action: 'CONTRACT_CREATED',
    severity: 'INFO',
    actor: `user-${Math.random().toString(36).slice(2, 8)}`,
    resource: 'contract',
    resourceId: `contract-${Math.random().toString(36).slice(2, 8)}`,
    metadata: { seq: overrides.seq ?? 0 },
    ...overrides,
  };
}

async function fireConcurrentAppends(
  repo: AuditLogRepository,
  count: number,
): Promise<ReturnType<AuditLogRepository['append']>[]> {
  const tasks = Array.from({ length: count }, async (_, i) => {
    await Promise.resolve();
    return repo.append(makeInput({ seq: i, metadata: { seq: i } }));
  });
  return Promise.all(tasks);
}

function assertNoLostUpdates(
  repo: AuditLogRepository,
  expectedCount: number,
): void {
  expect(repo.count()).toBe(expectedCount);
  const all = repo.query();
  expect(all).toHaveLength(expectedCount);
}

function assertHashChain(repo: AuditLogRepository): void {
  const report = repo.verifyIntegrity();
  expect(report.valid).toBe(true);
  const entries = repo.query();
  if (entries.length === 0) return;
  expect(entries[0].previousHash).toBe(GENESIS_HASH);
  for (let i = 1; i < entries.length; i += 1) {
    expect(entries[i].previousHash).toBe(entries[i - 1].hash);
  }
}

describe('AuditStore — concurrency smoke tests', () => {
  let store: AuditStore;

  beforeEach(() => {
    store = new AuditStore();
  });

  it('parallel writes: 10 concurrent appends produce 10 entries with no lost updates', async () => {
    const count = 10;
    const results = await fireConcurrentAppends(store, count);

    expect(results).toHaveLength(count);
    assertNoLostUpdates(store, count);
  });

  it('parallel writes: hash chain remains intact after 50 concurrent appends', async () => {
    const count = 50;
    await fireConcurrentAppends(store, count);

    assertHashChain(store);
  });

  it('parallel writes: each appended entry is retrievable by id', async () => {
    const count = 20;
    const results = await fireConcurrentAppends(store, count);

    for (const entry of results) {
      const found = store.getById((entry as { id: string }).id);
      expect(found).toBeDefined();
      expect(found?.id).toBe((entry as { id: string }).id);
    }
  });

  it('read-after-write consistency: reads during concurrent writes never see partial state', async () => {
    const count = 30;
    let inconsistentCount = 0;
    const reader = async (): Promise<void> => {
      for (let i = 0; i < 50; i += 1) {
        await Promise.resolve();
        const snapshotCount = store.count();
        const snapshotEntries = store.query();
        if (snapshotEntries.length !== snapshotCount) {
          inconsistentCount += 1;
        }
        if (snapshotCount > 0) {
          const last = snapshotEntries[snapshotCount - 1];
          const byId = store.getById(last.id);
          if (!byId || byId.hash !== last.hash) {
            inconsistentCount += 1;
          }
        }
      }
    };

    await Promise.all([
      fireConcurrentAppends(store, count),
      reader(),
      reader(),
    ]);

    expect(inconsistentCount).toBe(0);
    assertNoLostUpdates(store, count);
    assertHashChain(store);
  });

  it('parallel writes: metadata and query filters are consistent under concurrent writes', async () => {
    const actions: Array<'CONTRACT_CREATED' | 'PAYMENT_INITIATED' | 'USER_CREATED'> =
      ['CONTRACT_CREATED', 'PAYMENT_INITIATED', 'USER_CREATED'];
    const tasks = Array.from({ length: 60 }, async (_, i) => {
      await Promise.resolve();
      const action = actions[i % actions.length];
      const severity = action === 'PAYMENT_INITIATED' ? 'CRITICAL' : 'INFO';
      const resource = action === 'PAYMENT_INITIATED' ? 'payment' : action === 'USER_CREATED' ? 'user' : 'contract';
      return store.append(makeInput({
        action,
        severity,
        resource,
        resourceId: `${resource}-${i}`,
        metadata: { seq: i },
      }));
    });

    await Promise.all(tasks);

    for (const action of actions) {
      const filtered = store.query({ action });
      expect(filtered.length).toBe(20);
      for (const e of filtered) {
        expect(e.action).toBe(action);
      }
    }

    assertHashChain(store);
    expect(store.count()).toBe(60);
  });

  it('read-after-write: integrity remains valid when verifyIntegrity runs during appends', async () => {
    const count = 40;
    let invalidReports = 0;
    const integrityReader = async (): Promise<void> => {
      for (let i = 0; i < 20; i += 1) {
        await Promise.resolve();
        const report = store.verifyIntegrity();
        if (!report.valid) {
          invalidReports += 1;
        }
      }
    };

    await Promise.all([
      fireConcurrentAppends(store, count),
      integrityReader(),
      integrityReader(),
    ]);

    expect(invalidReports).toBe(0);
    assertHashChain(store);
    expect(store.count()).toBe(count);
  });

  it('parallel writes: cursor-based pagination returns all entries with stable ordering', async () => {
    const count = 25;
    await fireConcurrentAppends(store, count);

    const collected = [];
    let cursor: string | undefined;
    do {
      const page = store.queryWithCursor({ limit: 5, cursor });
      collected.push(...page.entries);
      cursor = page.nextCursor;
    } while (cursor);

    expect(collected).toHaveLength(count);
    assertHashChain(store);
    for (let i = 1; i < collected.length; i += 1) {
      expect(collected[i].previousHash).toBe(collected[i - 1].hash);
    }
  });
});

describe('SqliteAuditRepository — concurrency smoke tests', () => {
  let db: ReturnType<typeof Database>;
  let repo: SqliteAuditRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    repo = new SqliteAuditRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it('parallel writes: 10 concurrent appends produce 10 entries with no lost updates', async () => {
    const count = 10;
    const results = await fireConcurrentAppends(repo, count);

    expect(results).toHaveLength(count);
    assertNoLostUpdates(repo, count);
  });

  it('parallel writes: hash chain remains intact after 50 concurrent appends', async () => {
    const count = 50;
    await fireConcurrentAppends(repo, count);

    assertHashChain(repo);
  });

  it('parallel writes: each appended entry is retrievable by id', async () => {
    const count = 20;
    const results = await fireConcurrentAppends(repo, count);

    for (const entry of results) {
      const found = repo.getById(entry.id);
      expect(found).toBeDefined();
      expect(found?.id).toBe(entry.id);
    }
  });

  it('read-after-write consistency: reads during concurrent writes never see partial state', async () => {
    const count = 30;
    let inconsistentCount = 0;
    const reader = async (): Promise<void> => {
      for (let i = 0; i < 50; i += 1) {
        await Promise.resolve();
        const snapshotCount = repo.count();
        const snapshotEntries = repo.query();
        if (snapshotEntries.length !== snapshotCount) {
          inconsistentCount += 1;
        }
        if (snapshotCount > 0) {
          const last = snapshotEntries[snapshotCount - 1];
          const byId = repo.getById(last.id);
          if (!byId || byId.hash !== last.hash) {
            inconsistentCount += 1;
          }
        }
      }
    };

    await Promise.all([
      fireConcurrentAppends(repo, count),
      reader(),
      reader(),
    ]);

    expect(inconsistentCount).toBe(0);
    assertNoLostUpdates(repo, count);
    assertHashChain(repo);
  });

  it('read-after-write: integrity remains valid when verifyIntegrity runs during appends', async () => {
    const count = 40;
    let invalidReports = 0;
    const integrityReader = async (): Promise<void> => {
      for (let i = 0; i < 20; i += 1) {
        await Promise.resolve();
        const report = repo.verifyIntegrity();
        if (!report.valid) {
          invalidReports += 1;
        }
      }
    };

    await Promise.all([
      fireConcurrentAppends(repo, count),
      integrityReader(),
      integrityReader(),
    ]);

    expect(invalidReports).toBe(0);
    assertHashChain(repo);
    expect(repo.count()).toBe(count);
  });

  it('parallel writes: cursor-based pagination returns all entries with stable ordering', async () => {
    const count = 25;
    await fireConcurrentAppends(repo, count);

    const collected = [];
    let cursor: string | undefined;
    do {
      const page = repo.queryWithCursor({ limit: 5, cursor });
      collected.push(...page.entries);
      cursor = page.nextCursor;
    } while (cursor);

    expect(collected).toHaveLength(count);
    assertHashChain(repo);
    for (let i = 1; i < collected.length; i += 1) {
      expect(collected[i].previousHash).toBe(collected[i - 1].hash);
    }
  });

  it('parallel writes: stream() yields all entries in insertion order', async () => {
    const count = 15;
    await fireConcurrentAppends(repo, count);

    const streamed = Array.from(repo.stream());
    expect(streamed).toHaveLength(count);
    for (let i = 1; i < streamed.length; i += 1) {
      expect(streamed[i].previousHash).toBe(streamed[i - 1].hash);
    }
    assertHashChain(repo);
  });
});

describe('Audit router endpoints — concurrency smoke tests', () => {
  function buildApp(store: AuditStore) {
    const service = new AuditService(store);
    const app = express();
    app.use(express.json());
    app.use((_req, res, next) => {
      res.locals['requestId'] = 'concurrency-test';
      next();
    });
    app.use('/api/v1/audit', createAuditRouter({ service }));
    return { app, service };
  }

  it('POST /api/v1/audit: parallel writes — all requests succeed with 201', async () => {
    const store = new AuditStore();
    const { app } = buildApp(store);
    const count = 10;

    const tasks = Array.from({ length: count }, async (_, i) => {
      await Promise.resolve();
      return request(app)
        .post('/api/v1/audit')
        .send(makeInput({ seq: i, metadata: { seq: i } }))
        .set('Idempotency-Key', `idem-${i}-${Math.random()}`);
    });

    const responses = await Promise.all(tasks);

    for (const res of responses) {
      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('id');
      expect(res.body).toHaveProperty('hash');
    }
    assertNoLostUpdates(store, count);
    assertHashChain(store);
  });

  it('POST /api/v1/audit: read-after-write — GET during parallel POSTs sees consistent state', async () => {
    const store = new AuditStore();
    const { app } = buildApp(store);
    const writeCount = 30;
    let inconsistentCount = 0;

    const writeTasks = Array.from({ length: writeCount }, async (_, i) => {
      await Promise.resolve();
      return request(app)
        .post('/api/v1/audit')
        .send(makeInput({ seq: i, metadata: { seq: i } }))
        .set('Idempotency-Key', `rw-${i}-${Math.random()}`);
    });

    const readTask = async (): Promise<void> => {
      for (let i = 0; i < 40; i += 1) {
        await Promise.resolve();
        const res = await request(app).get('/api/v1/audit').expect(200);
        const { entries, count } = res.body;
        if (entries.length !== count) {
          inconsistentCount += 1;
        }
        for (let j = 1; j < entries.length; j += 1) {
          if (entries[j].previousHash !== entries[j - 1].hash) {
            inconsistentCount += 1;
          }
        }
      }
    };

    const integrityTask = async (): Promise<void> => {
      for (let i = 0; i < 15; i += 1) {
        await Promise.resolve();
        const res = await request(app).get('/api/v1/audit/integrity');
        if (res.body.valid === false) {
          inconsistentCount += 1;
        }
      }
    };

    await Promise.all([
      Promise.all(writeTasks),
      readTask(),
      readTask(),
      integrityTask(),
    ]);

    expect(inconsistentCount).toBe(0);
    assertNoLostUpdates(store, writeCount);
    assertHashChain(store);
  });

  it('GET /api/v1/audit/:id: every concurrent write is immediately retrievable', async () => {
    const store = new AuditStore();
    const { app } = buildApp(store);
    const count = 15;

    const created = await Promise.all(
      Array.from({ length: count }, async (_, i) => {
        const res = await request(app)
          .post('/api/v1/audit')
          .send(makeInput({ seq: i, metadata: { seq: i } }))
          .set('Idempotency-Key', `getid-${i}-${Math.random()}`);
        return res.body.id as string;
      }),
    );

    const fetchTasks = created.map((id) => request(app).get(`/api/v1/audit/${id}`).expect(200));
    const fetchResponses = await Promise.all(fetchTasks);

    expect(fetchResponses).toHaveLength(count);
    for (let i = 0; i < count; i += 1) {
      expect(fetchResponses[i].body.id).toBe(created[i]);
    }
  });

  it('POST /api/v1/audit: parallel writes — filters return correct subset counts', async () => {
    const store = new AuditStore();
    const { app } = buildApp(store);
    const actions: Array<'CONTRACT_CREATED' | 'PAYMENT_INITIATED' | 'AUTH_LOGIN'> =
      ['CONTRACT_CREATED', 'PAYMENT_INITIATED', 'AUTH_LOGIN'];
    const perAction = 15;
    const total = perAction * actions.length;

    const tasks: Promise<unknown>[] = [];
    for (let i = 0; i < total; i += 1) {
      const action = actions[i % actions.length];
      const severity = action === 'PAYMENT_INITIATED' ? 'CRITICAL' : 'INFO';
      const resource =
        action === 'PAYMENT_INITIATED' ? 'payment' :
        action === 'AUTH_LOGIN' ? 'auth' : 'contract';
      tasks.push(
        Promise.resolve().then(() =>
          request(app)
            .post('/api/v1/audit')
            .send(makeInput({
              action,
              severity,
              resource,
              resourceId: `${resource}-${i}`,
              metadata: { seq: i },
            }))
            .set('Idempotency-Key', `filter-${i}-${Math.random()}`),
        ),
      );
    }

    await Promise.all(tasks);

    for (const action of actions) {
      const res = await request(app)
        .get('/api/v1/audit')
        .query({ action })
        .expect(200);
      expect(res.body.count).toBe(perAction);
      expect(res.body.entries).toHaveLength(perAction);
      for (const entry of res.body.entries) {
        expect(entry.action).toBe(action);
      }
    }

    assertHashChain(store);
    expect(store.count()).toBe(total);
  });

  it('POST /api/v1/audit: no lost updates when firing 50 concurrent POSTs', async () => {
    const store = new AuditStore();
    const { app } = buildApp(store);
    const count = 50;

    const responses = await Promise.all(
      Array.from({ length: count }, async (_, i) => {
        await Promise.resolve();
        return request(app)
          .post('/api/v1/audit')
          .send(makeInput({ seq: i, metadata: { seq: i } }))
          .set('Idempotency-Key', `lost-${i}-${Math.random()}`);
      }),
    );

    const successful = responses.filter((r) => r.status === 201);
    expect(successful.length).toBe(count);
    expect(store.count()).toBe(count);
    assertHashChain(store);

    const report = store.verifyIntegrity();
    expect(report.valid).toBe(true);
    expect(report.totalEntries).toBe(count);
  });
});

import { createDefaultAuditRepository } from './repository';
import { encodeCursor, type CursorData } from './types';
import { auditMiddleware } from './middleware';
import { auditService } from './service';

describe('AuditStore — queryWithCursor cursor edge cases', () => {
  let store: AuditStore;

  beforeEach(() => {
    store = new AuditStore();
    for (let i = 0; i < 10; i += 1) {
      store.append(makeInput({ actor: `u${i}` }));
    }
  });

  it('filter-mismatch cursor throws rather than silently resetting to page 1', () => {
    const firstPage = store.queryWithCursor({ actor: 'u0', limit: 1 });
    const cursor = firstPage.nextCursor ?? (() => {
      const cursorData: CursorData = {
        lastId: store.query({ actor: 'u0' })[0].id,
        lastTimestamp: new Date().toISOString(),
        filters: { actor: 'u0' },
      };
      return encodeCursor(cursorData);
    })();

    expect(() =>
      store.queryWithCursor({ cursor, actor: 'u1', limit: 5 }),
    ).toThrow('Cursor filters do not match query filters');
  });

  it('malformed (non-base64) cursor is ignored and falls back to page 1', () => {
    const result = store.queryWithCursor({ cursor: '!!!not-valid-base64!!!', limit: 3 });
    expect(result.entries).toHaveLength(3);
    expect(result.entries[0]).toBeDefined();
  });

  it('cursor whose lastId is not found resets startIndex to 0 via -1 path', () => {
    const cursorData: CursorData = {
      lastId: 'does-not-exist-in-log',
      lastTimestamp: new Date().toISOString(),
      filters: {},
    };
    const cursor = encodeCursor(cursorData);
    const result = store.queryWithCursor({ cursor, limit: 5 });
    expect(result.entries).toHaveLength(5);
  });

  it('no nextCursor is generated when the page exactly exhausts all entries', () => {
    const small = new AuditStore();
    small.append(makeInput());
    small.append(makeInput());
    const result = small.queryWithCursor({ limit: 2 });
    expect(result.entries).toHaveLength(2);
    expect(result.nextCursor).toBeUndefined();
  });

  it('nextCursor is generated when more entries follow the current page', () => {
    const result = store.queryWithCursor({ limit: 3 });
    expect(result.nextCursor).toBeDefined();
    const next = store.queryWithCursor({ cursor: result.nextCursor, limit: 3 });
    expect(next.entries).toHaveLength(3);
    expect(next.entries[0].id).not.toBe(result.entries[0].id);
  });
});

describe('createDefaultAuditRepository — backend selection', () => {
  const original = process.env['AUDIT_STORAGE_BACKEND'];

  afterEach(() => {
    if (original === undefined) {
      delete process.env['AUDIT_STORAGE_BACKEND'];
    } else {
      process.env['AUDIT_STORAGE_BACKEND'] = original;
    }
  });

  it('returns the in-memory AuditStore when AUDIT_STORAGE_BACKEND is "memory"', () => {
    process.env['AUDIT_STORAGE_BACKEND'] = 'memory';
    const repo = createDefaultAuditRepository();
    repo.append(makeInput());
    expect(repo.count()).toBe(1);
  });

  it('returns a SqliteAuditRepository when AUDIT_STORAGE_BACKEND is "sqlite"', () => {
    process.env['AUDIT_STORAGE_BACKEND'] = 'sqlite';
    process.env['AUDIT_DB_PATH'] = ':memory:';
    const repo = createDefaultAuditRepository();
    repo.append(makeInput());
    expect(repo.count()).toBe(1);
  });

  it('throws for an unsupported backend value', () => {
    process.env['AUDIT_STORAGE_BACKEND'] = 'redis';
    expect(() => createDefaultAuditRepository()).toThrow(
      'Unsupported AUDIT_STORAGE_BACKEND: redis',
    );
  });
});

describe('AuditService — queryWithCursor delegation', () => {
  it('delegates queryWithCursor to the repository and returns its result', () => {
    const store = new AuditStore();
    const service = new AuditService(store);
    for (let i = 0; i < 5; i += 1) {
      service.log(makeInput({ actor: `u${i}` }));
    }
    const spy = jest.spyOn(store, 'queryWithCursor');
    const result = service.queryWithCursor({ limit: 3 });
    expect(spy).toHaveBeenCalledWith({ limit: 3 });
    expect(result.entries).toHaveLength(3);
    expect(result.limit).toBe(3);
    spy.mockRestore();
  });
});

describe('auditMiddleware — socket remoteAddress fallback', () => {
  it('uses req.socket.remoteAddress when req.ip is undefined', async () => {
    const logSpy = jest.spyOn(auditService, 'log').mockImplementation((input) => ({
      id: 'x',
      timestamp: new Date().toISOString(),
      hash: 'a'.repeat(64),
      previousHash: 'GENESIS',
      ...input,
    }));

    const app = express();
    app.use((req, _res, next) => {
      Object.defineProperty(req, 'ip', { get: () => undefined, configurable: true });
      next();
    });
    app.use(auditMiddleware);
    app.get('/test', (req, res) => {
      res.locals.audit.log({
        action: 'ENDPOINT_ACCESS',
        severity: 'INFO',
        actor: 'tester',
        resource: 'test',
        resourceId: 'r1',
        metadata: {},
      });
      res.status(200).json({ ok: true });
    });

    await request(app).get('/test').expect(200);

    expect(logSpy).toHaveBeenCalled();
    logSpy.mockRestore();
  });
});

describe('createDefaultAuditRepository — AUDIT_DB_PATH and NODE_ENV branches', () => {
  const origBackend = process.env['AUDIT_STORAGE_BACKEND'];
  const origDbPath = process.env['AUDIT_DB_PATH'];
  const origNodeEnv = process.env['NODE_ENV'];

  afterEach(() => {
    if (origBackend === undefined) delete process.env['AUDIT_STORAGE_BACKEND'];
    else process.env['AUDIT_STORAGE_BACKEND'] = origBackend;

    if (origDbPath === undefined) delete process.env['AUDIT_DB_PATH'];
    else process.env['AUDIT_DB_PATH'] = origDbPath;

    if (origNodeEnv === undefined) delete process.env['NODE_ENV'];
    else process.env['NODE_ENV'] = origNodeEnv;
  });

  it('sqlite path: uses :memory: when NODE_ENV=test and AUDIT_DB_PATH is unset', () => {
    process.env['AUDIT_STORAGE_BACKEND'] = 'sqlite';
    delete process.env['AUDIT_DB_PATH'];
    process.env['NODE_ENV'] = 'test';
    const repo = createDefaultAuditRepository();
    repo.append(makeInput());
    expect(repo.count()).toBe(1);
  });

  it('sqlite path: uses AUDIT_DB_PATH when explicitly set', () => {
    process.env['AUDIT_STORAGE_BACKEND'] = 'sqlite';
    process.env['AUDIT_DB_PATH'] = ':memory:';
    process.env['NODE_ENV'] = 'test';
    const repo = createDefaultAuditRepository();
    repo.append(makeInput());
    expect(repo.count()).toBe(1);
  });
});

describe('AuditStore — queryWithCursor individual filter branch coverage', () => {
  it('filters by severity only', () => {
    const store = new AuditStore();
    store.append(makeInput({ severity: 'INFO', action: 'CONTRACT_CREATED', resource: 'contract', resourceId: 'c1' }));
    store.append(makeInput({ severity: 'CRITICAL', action: 'PAYMENT_INITIATED', resource: 'payment', resourceId: 'p1' }));
    const result = store.queryWithCursor({ severity: 'CRITICAL', limit: 10 });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].severity).toBe('CRITICAL');
  });

  it('filters by actor only', () => {
    const store = new AuditStore();
    store.append(makeInput({ actor: 'alice' }));
    store.append(makeInput({ actor: 'bob' }));
    const result = store.queryWithCursor({ actor: 'alice', limit: 10 });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].actor).toBe('alice');
  });

  it('filters by resource only', () => {
    const store = new AuditStore();
    store.append(makeInput({ resource: 'contract', resourceId: 'c1' }));
    store.append(makeInput({ action: 'PAYMENT_INITIATED', severity: 'CRITICAL', resource: 'payment', resourceId: 'p1' }));
    const result = store.queryWithCursor({ resource: 'payment', limit: 10 });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].resource).toBe('payment');
  });

  it('filters by resourceId only', () => {
    const store = new AuditStore();
    store.append(makeInput({ resourceId: 'target-r' }));
    store.append(makeInput({ resourceId: 'other-r' }));
    const result = store.queryWithCursor({ resourceId: 'target-r', limit: 10 });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].resourceId).toBe('target-r');
  });

  it('filters by from/to time range', () => {
    const store = new AuditStore();
    store.append(makeInput());
    const past = new Date(Date.now() - 120_000).toISOString();
    const future = new Date(Date.now() + 120_000).toISOString();
    const inRange = store.queryWithCursor({ from: past, to: future, limit: 10 });
    expect(inRange.entries).toHaveLength(1);
    const outOfRange = store.queryWithCursor({ from: future, limit: 10 });
    expect(outOfRange.entries).toHaveLength(0);
  });

  it('query without any cursor or filter returns all entries up to limit', () => {
    const store = new AuditStore();
    for (let i = 0; i < 7; i += 1) store.append(makeInput());
    const result = store.queryWithCursor({ limit: 7 });
    expect(result.entries).toHaveLength(7);
    expect(result.nextCursor).toBeUndefined();
  });
});
