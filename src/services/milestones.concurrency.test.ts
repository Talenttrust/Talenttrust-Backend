/**
 * @file milestones.concurrency.test.ts
 * @description Concurrency smoke tests for the milestones service and endpoint.
 *
 * Fires concurrent milestones operations and asserts consistent state with no
 * lost updates. Tests are deterministic and bounded — no real network, no
 * timers, no real DB. All I/O goes through the in-memory Map store that
 * MilestonesService uses for demo persistence.
 *
 * Strategy
 * ────────
 * - All "concurrent" calls are dispatched on fresh microtasks via
 *   `Promise.resolve().then(fn)` and collected with `Promise.all` /
 *   `Promise.allSettled`. This is the closest approximation to concurrent
 *   dispatch available in a single-threaded Node.js process with a
 *   synchronous store.
 * - Service-level: parallel creates, updates (soft-delete / restore), reads.
 * - HTTP endpoint-level: concurrent GET / POST / DELETE against express app.
 * - No lost updates: every writer that should succeed does, none are silently
 *   dropped.
 * - Race surfaced & noted: concurrent soft-delete of the same milestone —
 *   the Map-backed store is synchronous so only the first synchronous
 *   invocation sets `deletedAt`. All subsequent callers observe the
 *   already-deleted flag and receive a deterministic 409 MilestoneConflictError.
 *   No update is lost and no silent swallowing occurs.
 *
 * Coverage targets (>= 95 % for impacted modules):
 *   - MilestonesService: create, listByContract, getById, softDelete, restore,
 *     purgeExpired
 *   - MilestonesSoftDeleteController: list, create, softDelete, restore
 *   - HTTP endpoints under /:id/milestones (GET, POST, DELETE, restore)
 */

import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';

import {
  MilestonesService,
  MilestoneConflictError,
  MILESTONES_SOFT_DELETE_RETENTION_DAYS_ENV,
  type MilestoneRecord,
} from './milestones.service';
import {
  MilestonesSoftDeleteController,
  createMilestonesSoftDeleteController,
} from '../controllers/milestones.softdelete.controller';
import { requestIdMiddleware } from '../middleware/requestId';

// ─── Middleware / dependency stubs ────────────────────────────────────────────

jest.mock('../middleware/authorization', () => ({
  requireAuth: (_req: Request, _res: Response, next: NextFunction) => next(),
  requirePermission:
    () => (_req: Request, _res: Response, next: NextFunction) =>
      next(),
}));

jest.mock('../middleware/contractIdempotency', () => ({
  contractCreateIdempotencyMiddleware:
    () => (_req: Request, _res: Response, next: NextFunction) =>
      next(),
}));

jest.mock('../db/database', () => ({ getDb: jest.fn(() => ({})) }));

jest.mock('../repositories/contractRepository', () => ({
  ContractRepository: jest.fn().mockImplementation(() => ({
    findById: jest.fn().mockResolvedValue({ clientId: 'owner-1' }),
    create: jest.fn().mockResolvedValue({
      id: 'c1',
      clientId: 'owner-1',
      amount: 0,
      status: 'draft',
      version: 0,
    }),
    updateWithVersion: jest.fn(),
    findAll: jest.fn().mockResolvedValue([]),
    findPage: jest
      .fn()
      .mockResolvedValue({ data: [], nextCursor: null, hasNextPage: false, limit: 20 }),
    delete: jest.fn().mockResolvedValue(true),
  })),
}));

jest.mock('../observability/contracts-observability', () => ({
  createContractsObservabilityMiddleware:
    () => (_req: Request, _res: Response, next: NextFunction) =>
      next(),
}));

jest.mock('compression', () => () => (_req: Request, _res: Response, next: NextFunction) => next());

jest.mock('../middleware/rateLimiter', () => ({
  createRateLimiter:
    () => (_req: Request, _res: Response, next: NextFunction) =>
      next(),
}));

jest.mock('../services/contracts.service', () => ({
  ContractsService: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('./soroban.service');

// ─── Helper: deferred microtask dispatch ─────────────────────────────────────

/**
 * Wraps `fn` in a fresh microtask so that all concurrent calls dispatched
 * via `Promise.all` are queued together before any of them executes.
 * This is the closest approximation to "concurrent requests" for a
 * synchronous (Map-backed) store in a single-threaded Node.js process.
 */
function deferred<T>(fn: () => T): Promise<T> {
  return Promise.resolve().then(fn);
}

/** Convenience: create one milestone and return it. */
function seed(svc: MilestonesService, contractId: string, title = 'Seed'): MilestoneRecord {
  return svc.create(contractId, { title, amount: 1_000_000 });
}

// ═════════════════════════════════════════════════════════════════════════════
// SERVICE-LEVEL CONCURRENCY TESTS
// ═════════════════════════════════════════════════════════════════════════════

describe('MilestonesService — concurrency smoke tests', () => {
  let svc: MilestonesService;
  const A = 'contract-concurrent-A';
  const B = 'contract-concurrent-B';

  beforeEach(() => {
    svc = new MilestonesService();
    svc.clearStore();
    delete process.env[MILESTONES_SOFT_DELETE_RETENTION_DAYS_ENV];
  });

  afterEach(() => {
    svc.clearStore();
    delete process.env[MILESTONES_SOFT_DELETE_RETENTION_DAYS_ENV];
  });

  // ── Parallel creates ───────────────────────────────────────────────────────

  it('parallel writes: 20 concurrent creates produce 20 unique records with no lost updates', async () => {
    const N = 20;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        deferred(() => svc.create(A, { title: `M-${i}`, amount: i + 1 })),
      ),
    );

    expect(results).toHaveLength(N);
    expect(svc.storeSize()).toBe(N);
    const ids = new Set(results.map((r) => r.id));
    expect(ids.size).toBe(N); // no silent overwrites
  });

  it('parallel writes: 50 concurrent creates — all land, no lost updates', async () => {
    const N = 50;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        deferred(() => svc.create(A, { title: `Bulk-${i}`, amount: 100 })),
      ),
    );

    expect(results).toHaveLength(N);
    expect(svc.storeSize()).toBe(N);
    expect(new Set(results.map((r) => r.id)).size).toBe(N);
  });

  it('parallel writes: each created milestone is immediately retrievable (read-after-write)', async () => {
    const N = 15;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        deferred(() => svc.create(A, { title: `Rw-${i}`, amount: 50 })),
      ),
    );

    for (const m of results) {
      const fetched = svc.getById(A, m.id);
      expect(fetched.id).toBe(m.id);
      expect(fetched.title).toBe(m.title);
    }
  });

  // ── Read-after-write consistency ───────────────────────────────────────────

  it('read-after-write: listByContract during concurrent creates never returns a phantom count', async () => {
    const WRITE_N = 30;
    let badReads = 0;

    const writer = async (): Promise<void> => {
      for (let i = 0; i < WRITE_N; i++) {
        await Promise.resolve();
        svc.create(A, { title: `W-${i}`, amount: 1 });
      }
    };

    const reader = async (): Promise<void> => {
      for (let i = 0; i < 60; i++) {
        await Promise.resolve();
        const listed = svc.listByContract(A).length;
        const stored = svc.storeSize();
        // listed can only be <= stored (some records may belong to other contracts)
        if (listed > stored) badReads += 1;
      }
    };

    await Promise.all([writer(), reader(), reader()]);

    expect(badReads).toBe(0);
    expect(svc.storeSize()).toBe(WRITE_N);
  });

  it('getById is immediately consistent after concurrent creates', async () => {
    const N = 10;
    const pairs = await Promise.all(
      Array.from({ length: N }, async (_, i) => {
        await Promise.resolve();
        const m = svc.create(A, { title: `Pair-${i}`, amount: 1 });
        return svc.getById(A, m.id).id === m.id;
      }),
    );

    expect(pairs.every(Boolean)).toBe(true);
  });

  // ── Contract isolation ─────────────────────────────────────────────────────

  it('concurrent creates across two contracts maintain per-contract isolation', async () => {
    const N = 20;
    await Promise.all([
      ...Array.from({ length: N }, (_, i) =>
        deferred(() => svc.create(A, { title: `A-${i}`, amount: 1 })),
      ),
      ...Array.from({ length: N }, (_, i) =>
        deferred(() => svc.create(B, { title: `B-${i}`, amount: 1 })),
      ),
    ]);

    const listA = svc.listByContract(A);
    const listB = svc.listByContract(B);

    expect(listA).toHaveLength(N);
    expect(listB).toHaveLength(N);
    for (const m of listA) expect(m.contractId).toBe(A);
    for (const m of listB) expect(m.contractId).toBe(B);
  });

  // ── Concurrent soft-delete (race note) ────────────────────────────────────
  //
  // Race note: N callers concurrently soft-delete the SAME milestone.
  // Because Map writes are synchronous in Node.js, only the first invocation
  // sets `deletedAt`; all others see the already-deleted flag and throw a
  // deterministic MilestoneConflictError (409). No update is lost; no write is
  // silently dropped.

  it('concurrent soft-delete on the same milestone: exactly one succeeds, the rest get MilestoneConflictError', async () => {
    const m = seed(svc, A);
    const N = 10;

    const outcomes = await Promise.allSettled(
      Array.from({ length: N }, () =>
        deferred(() => svc.softDelete(A, m.id)),
      ),
    );

    const ok = outcomes.filter((o) => o.status === 'fulfilled');
    const err = outcomes.filter(
      (o): o is PromiseRejectedResult => o.status === 'rejected',
    );

    expect(ok).toHaveLength(1);
    expect(err).toHaveLength(N - 1);
    for (const r of err) expect(r.reason).toBeInstanceOf(MilestoneConflictError);

    const final = svc.getById(A, m.id, { includeDeleted: true });
    expect(final.deletedAt).toBeInstanceOf(Date);
  });

  it('concurrent soft-delete on distinct milestones: all succeed with no lost updates', async () => {
    const N = 15;
    const milestones = Array.from({ length: N }, (_, i) =>
      svc.create(A, { title: `Del-${i}`, amount: 1 }),
    );

    const results = await Promise.all(
      milestones.map((m) => deferred(() => svc.softDelete(A, m.id))),
    );

    expect(results).toHaveLength(N);
    for (const r of results) expect(r.deletedAt).toBeInstanceOf(Date);

    expect(svc.listByContract(A)).toHaveLength(0);
    expect(svc.listByContract(A, { includeDeleted: true })).toHaveLength(N);
  });

  // ── Concurrent restore ─────────────────────────────────────────────────────

  it('concurrent restore on the same milestone: exactly one succeeds, the rest get MilestoneConflictError', async () => {
    process.env[MILESTONES_SOFT_DELETE_RETENTION_DAYS_ENV] = '30';
    const m = seed(svc, A);
    svc.softDelete(A, m.id);

    const N = 8;
    const outcomes = await Promise.allSettled(
      Array.from({ length: N }, () =>
        deferred(() => svc.restore(A, m.id)),
      ),
    );

    const ok = outcomes.filter((o) => o.status === 'fulfilled');
    const err = outcomes.filter(
      (o): o is PromiseRejectedResult => o.status === 'rejected',
    );

    expect(ok).toHaveLength(1);
    expect(err).toHaveLength(N - 1);
    for (const r of err) expect(r.reason).toBeInstanceOf(MilestoneConflictError);

    expect(svc.getById(A, m.id).deletedAt).toBeNull();
  });

  it('concurrent restore on distinct milestones: all succeed with no lost updates', async () => {
    process.env[MILESTONES_SOFT_DELETE_RETENTION_DAYS_ENV] = '30';
    const N = 10;
    const milestones = Array.from({ length: N }, (_, i) => {
      const m = svc.create(A, { title: `Restore-${i}`, amount: 1 });
      svc.softDelete(A, m.id);
      return m;
    });

    const results = await Promise.all(
      milestones.map((m) => deferred(() => svc.restore(A, m.id))),
    );

    expect(results).toHaveLength(N);
    for (const r of results) expect(r.deletedAt).toBeNull();
  });

  // ── Mixed operations ───────────────────────────────────────────────────────

  it('mixed concurrent creates, lists, and soft-deletes: no errors, no corruption', async () => {
    const CREATE_N = 10;
    let errorCount = 0;
    let listReadCount = 0;

    const initial = Array.from({ length: 5 }, (_, i) =>
      svc.create(A, { title: `Initial-${i}`, amount: 1 }),
    );

    const creator = async (): Promise<void> => {
      for (let i = 0; i < CREATE_N; i++) {
        await Promise.resolve();
        try {
          svc.create(A, { title: `Concurrent-${i}`, amount: 10 });
        } catch {
          errorCount += 1;
        }
      }
    };

    const deleter = async (): Promise<void> => {
      for (const m of initial) {
        await Promise.resolve();
        try {
          svc.softDelete(A, m.id);
        } catch {
          /* double-delete conflict is not a bug */
        }
      }
    };

    const reader = async (): Promise<void> => {
      for (let i = 0; i < 20; i++) {
        await Promise.resolve();
        try {
          svc.listByContract(A);
          listReadCount += 1;
        } catch {
          errorCount += 1;
        }
      }
    };

    await Promise.all([creator(), deleter(), reader(), reader()]);

    expect(errorCount).toBe(0);
    expect(listReadCount).toBeGreaterThan(0);
    expect(svc.storeSize()).toBe(CREATE_N + initial.length);
  });

  // ── Concurrent purge ───────────────────────────────────────────────────────

  it('concurrent purgeExpired calls produce a deterministic total (no double-purge)', async () => {
    process.env[MILESTONES_SOFT_DELETE_RETENTION_DAYS_ENV] = '30';
    const N_EXPIRED = 5;
    const N_ACTIVE = 3;

    for (let i = 0; i < N_EXPIRED; i++) {
      const m = svc.create(A, { title: `Expired-${i}`, amount: 1 });
      svc.softDelete(A, m.id, new Date('2020-01-01T00:00:00.000Z'));
    }
    for (let i = 0; i < N_ACTIVE; i++) {
      svc.create(A, { title: `Active-${i}`, amount: 1 });
    }

    const purgeNow = new Date('2026-07-01T00:00:00.000Z');
    const counts = await Promise.all(
      Array.from({ length: 5 }, () => deferred(() => svc.purgeExpired(purgeNow))),
    );

    // Total purged = N_EXPIRED — no double-purge
    expect(counts.reduce((s, n) => s + n, 0)).toBe(N_EXPIRED);
    expect(svc.storeSize()).toBe(N_ACTIVE);
  });

  // ── Ordering stability ─────────────────────────────────────────────────────

  it('listByContract preserves createdAt-ascending order across concurrent reads', async () => {
    const ordered: string[] = [];
    for (let i = 0; i < 10; i++) {
      const m = svc.create(A, { title: `Ord-${i}`, amount: 1 });
      ordered.push(m.id);
    }

    const reads = await Promise.all(
      Array.from({ length: 10 }, () =>
        deferred(() => svc.listByContract(A).map((m) => m.id)),
      ),
    );

    for (const ids of reads) expect(ids).toEqual(ordered);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// CONTROLLER-LEVEL CONCURRENCY TESTS
// ═════════════════════════════════════════════════════════════════════════════

describe('MilestonesSoftDeleteController — concurrency smoke tests', () => {
  let controller: MilestonesSoftDeleteController;
  let svcSingleton: MilestonesService;
  const CID = 'contract-ctrl-concurrency';

  function mockRes(): Response & { statusCode: number; body: any } {
    const res: any = {
      statusCode: 200,
      body: undefined,
      locals: { requestId: 'req-test' },
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: unknown) {
        this.body = payload;
        return this;
      },
    };
    return res as Response & { statusCode: number; body: any };
  }

  function fakeReq(
    params: Record<string, string>,
    body?: unknown,
    query: Record<string, string> = {},
  ): Request {
    return { params, body: body ?? {}, query } as unknown as Request;
  }

  beforeEach(async () => {
    controller = createMilestonesSoftDeleteController();
    const mod = await import('./milestones.service');
    svcSingleton = mod.milestonesService;
    svcSingleton.clearStore();
    delete process.env[MILESTONES_SOFT_DELETE_RETENTION_DAYS_ENV];
  });

  afterEach(() => {
    svcSingleton.clearStore();
    delete process.env[MILESTONES_SOFT_DELETE_RETENTION_DAYS_ENV];
  });

  it('20 concurrent controller.create calls all respond 201 with unique IDs', async () => {
    const N = 20;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        deferred(() => {
          const res = mockRes();
          controller.create(
            fakeReq({ id: CID }, { title: `T-${i}`, amount: 100 + i }),
            res,
            jest.fn(),
          );
          return { status: res.statusCode, id: res.body?.data?.milestone?.id as string };
        }),
      ),
    );

    expect(results.filter((r) => r.status === 201)).toHaveLength(N);
    const ids = new Set(results.map((r) => r.id).filter(Boolean));
    expect(ids.size).toBe(N);
  });

  it('30 concurrent controller.list calls all return the same stable count', async () => {
    const SEED_N = 5;
    for (let i = 0; i < SEED_N; i++) {
      svcSingleton.create(CID, { title: `Seed-${i}`, amount: 50 });
    }

    const totals = await Promise.all(
      Array.from({ length: 30 }, () =>
        deferred(() => {
          const res = mockRes();
          controller.list(fakeReq({ id: CID }), res, jest.fn());
          return res.body?.data?.total as number;
        }),
      ),
    );

    for (const t of totals) expect(t).toBe(SEED_N);
  });

  it('concurrent soft-delete on same milestone via controller: one 200, rest 409', async () => {
    const m = svcSingleton.create(CID, { title: 'ToDelete', amount: 1 });
    const N = 8;

    const statuses = await Promise.all(
      Array.from({ length: N }, () =>
        deferred(() => {
          const res = mockRes();
          controller.softDelete(fakeReq({ id: CID, milestoneId: m.id }), res, jest.fn());
          return res.statusCode;
        }),
      ),
    );

    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(N - 1);
  });

  it('concurrent restore on same milestone via controller: one 200, rest 409', async () => {
    process.env[MILESTONES_SOFT_DELETE_RETENTION_DAYS_ENV] = '30';
    const m = svcSingleton.create(CID, { title: 'ToRestore', amount: 1 });
    svcSingleton.softDelete(CID, m.id);

    const N = 8;
    const statuses = await Promise.all(
      Array.from({ length: N }, () =>
        deferred(() => {
          const res = mockRes();
          controller.restore(fakeReq({ id: CID, milestoneId: m.id }), res, jest.fn());
          return res.statusCode;
        }),
      ),
    );

    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(N - 1);
  });

  it('mixed concurrent creates, soft-deletes, and lists produce no unhandled errors', async () => {
    const targets = Array.from({ length: 5 }, (_, i) =>
      svcSingleton.create(CID, { title: `Target-${i}`, amount: 1 }),
    );

    let unhandledErrors = 0;
    const next = jest.fn(() => { unhandledErrors += 1; });

    const creates = Array.from({ length: 10 }, (_, i) =>
      deferred(() => {
        const res = mockRes();
        controller.create(fakeReq({ id: CID }, { title: `New-${i}`, amount: 5 }), res, next);
        return res.statusCode;
      }),
    );

    const deletes = targets.map((m) =>
      deferred(() => {
        const res = mockRes();
        controller.softDelete(fakeReq({ id: CID, milestoneId: m.id }), res, next);
        return res.statusCode;
      }),
    );

    const lists = Array.from({ length: 10 }, () =>
      deferred(() => {
        const res = mockRes();
        controller.list(fakeReq({ id: CID }), res, next);
        return res.body?.data?.total;
      }),
    );

    await Promise.all([...creates, ...deletes, ...lists]);
    expect(unhandledErrors).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// HTTP ENDPOINT-LEVEL CONCURRENCY TESTS
// ═════════════════════════════════════════════════════════════════════════════

describe('Milestones HTTP endpoints — concurrency smoke tests', () => {
  let svcSingleton: MilestonesService;
  const CID = 'http-contract-concurrency';

  /**
   * Lean express app: mounts the controller directly without the full
   * contracts router (which requires a real DB). Auth & idempotency are
   * already stubbed at the top of this file.
   */
  function buildApp(): express.Express {
    const app = express();
    app.use(express.json());
    app.use(requestIdMiddleware);

    const ctrl = createMilestonesSoftDeleteController();
    app.get('/api/v1/contracts/:id/milestones', (req, res, next) =>
      ctrl.list(req, res, next),
    );
    app.post('/api/v1/contracts/:id/milestones', (req, res, next) =>
      ctrl.create(req, res, next),
    );
    app.delete('/api/v1/contracts/:id/milestones/:milestoneId', (req, res, next) =>
      ctrl.softDelete(req, res, next),
    );
    app.post('/api/v1/contracts/:id/milestones/:milestoneId/restore', (req, res, next) =>
      ctrl.restore(req, res, next),
    );
    return app;
  }

  beforeEach(async () => {
    const mod = await import('./milestones.service');
    svcSingleton = mod.milestonesService;
    svcSingleton.clearStore();
    delete process.env[MILESTONES_SOFT_DELETE_RETENTION_DAYS_ENV];
  });

  afterEach(() => {
    svcSingleton.clearStore();
    delete process.env[MILESTONES_SOFT_DELETE_RETENTION_DAYS_ENV];
  });

  // ── GET /milestones ────────────────────────────────────────────────────────

  it('GET: 20 concurrent reads all return 200 with a consistent count', async () => {
    const app = buildApp();
    const SEED_N = 3;
    for (let i = 0; i < SEED_N; i++) {
      svcSingleton.create(CID, { title: `Seed-${i}`, amount: 100 });
    }

    const responses = await Promise.all(
      Array.from({ length: 20 }, () =>
        deferred(() => request(app).get(`/api/v1/contracts/${CID}/milestones`)),
      ),
    );

    for (const res of responses) {
      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(SEED_N);
      expect(res.body.data.milestones).toHaveLength(SEED_N);
    }
  });

  it('GET: concurrent reads for two different contracts are fully isolated', async () => {
    const app = buildApp();
    const X = 'http-contract-X';
    const Y = 'http-contract-Y';

    svcSingleton.create(X, { title: 'X-1', amount: 1 });
    svcSingleton.create(X, { title: 'X-2', amount: 2 });
    svcSingleton.create(Y, { title: 'Y-1', amount: 3 });

    const [xRes, yRes] = await Promise.all([
      Promise.all(
        Array.from({ length: 10 }, () =>
          deferred(() => request(app).get(`/api/v1/contracts/${X}/milestones`)),
        ),
      ),
      Promise.all(
        Array.from({ length: 10 }, () =>
          deferred(() => request(app).get(`/api/v1/contracts/${Y}/milestones`)),
        ),
      ),
    ]);

    for (const r of xRes) {
      expect(r.status).toBe(200);
      expect(r.body.data.total).toBe(2);
    }
    for (const r of yRes) {
      expect(r.status).toBe(200);
      expect(r.body.data.total).toBe(1);
    }
  });

  // ── POST /milestones ───────────────────────────────────────────────────────

  it('POST: 15 concurrent creates all return 201 with unique IDs', async () => {
    const app = buildApp();
    const N = 15;

    const responses = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        deferred(() =>
          request(app)
            .post(`/api/v1/contracts/${CID}/milestones`)
            .send({ title: `Create-${i}`, amount: 500 + i }),
        ),
      ),
    );

    expect(responses.filter((r) => r.status === 201)).toHaveLength(N);
    const ids = new Set(
      responses
        .map((r) => r.body?.data?.milestone?.id as string | undefined)
        .filter(Boolean),
    );
    expect(ids.size).toBe(N);
  });

  it('POST: concurrent creates followed by a GET reflect the correct total (read-after-write)', async () => {
    const app = buildApp();
    const N = 10;

    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        deferred(() =>
          request(app)
            .post(`/api/v1/contracts/${CID}/milestones`)
            .send({ title: `RaW-${i}`, amount: 1 }),
        ),
      ),
    );

    const listRes = await request(app).get(`/api/v1/contracts/${CID}/milestones`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.data.total).toBe(N);
  });

  it('POST: invalid payloads return 400 and never pollute the store', async () => {
    const app = buildApp();

    const responses = await Promise.all(
      [{ title: 'no-amount' }, { amount: 99 }, {}].map((payload) =>
        deferred(() =>
          request(app)
            .post(`/api/v1/contracts/${CID}/milestones`)
            .send(payload),
        ),
      ),
    );

    for (const r of responses) expect(r.status).toBe(400);
    expect(svcSingleton.storeSize()).toBe(0);
  });

  // ── DELETE /milestones/:id ─────────────────────────────────────────────────

  it('DELETE: concurrent deletes of the same milestone — exactly one 200, rest 409', async () => {
    const app = buildApp();
    const m = svcSingleton.create(CID, { title: 'HTTP-ToDelete', amount: 1 });
    const N = 8;

    const responses = await Promise.all(
      Array.from({ length: N }, () =>
        deferred(() =>
          request(app).delete(`/api/v1/contracts/${CID}/milestones/${m.id}`),
        ),
      ),
    );

    const ok = responses.filter((r) => r.status === 200);
    const conflict = responses.filter((r) => r.status === 409);
    expect(ok).toHaveLength(1);
    expect(conflict).toHaveLength(N - 1);
    for (const r of conflict) expect(r.body.error.code).toBe('milestone_conflict');
  });

  it('DELETE: concurrent deletes of distinct milestones all return 200', async () => {
    const app = buildApp();
    const N = 10;
    const milestones = Array.from({ length: N }, (_, i) =>
      svcSingleton.create(CID, { title: `Del-${i}`, amount: 1 }),
    );

    const responses = await Promise.all(
      milestones.map((m) =>
        deferred(() =>
          request(app).delete(`/api/v1/contracts/${CID}/milestones/${m.id}`),
        ),
      ),
    );

    for (const r of responses) {
      expect(r.status).toBe(200);
      expect(r.body.data.milestone.deletedAt).not.toBeNull();
    }
  });

  // ── POST /milestones/:id/restore ───────────────────────────────────────────

  it('restore: concurrent restores of the same milestone — exactly one 200, rest 409', async () => {
    process.env[MILESTONES_SOFT_DELETE_RETENTION_DAYS_ENV] = '30';
    const app = buildApp();
    const m = svcSingleton.create(CID, { title: 'HTTP-ToRestore', amount: 1 });
    svcSingleton.softDelete(CID, m.id);

    const N = 6;
    const responses = await Promise.all(
      Array.from({ length: N }, () =>
        deferred(() =>
          request(app).post(`/api/v1/contracts/${CID}/milestones/${m.id}/restore`),
        ),
      ),
    );

    expect(responses.filter((r) => r.status === 200)).toHaveLength(1);
    expect(responses.filter((r) => r.status === 409)).toHaveLength(N - 1);
  });

  // ── Mixed HTTP methods ─────────────────────────────────────────────────────

  it('mixed GET + POST + DELETE: no 5xx responses, all expected status codes', async () => {
    const app = buildApp();
    const targets = Array.from({ length: 5 }, (_, i) =>
      svcSingleton.create(CID, { title: `Target-${i}`, amount: 1 }),
    );

    const getOps = Array.from({ length: 10 }, () =>
      deferred(() => request(app).get(`/api/v1/contracts/${CID}/milestones`)),
    );
    const postOps = Array.from({ length: 10 }, (_, i) =>
      deferred(() =>
        request(app)
          .post(`/api/v1/contracts/${CID}/milestones`)
          .send({ title: `Mix-${i}`, amount: 10 }),
      ),
    );
    const deleteOps = targets.map((m) =>
      deferred(() =>
        request(app).delete(`/api/v1/contracts/${CID}/milestones/${m.id}`),
      ),
    );

    const all = await Promise.all([...getOps, ...postOps, ...deleteOps]);

    for (const r of all) expect(r.status).not.toBe(500);

    expect(all.slice(0, 10).every((r) => r.status === 200)).toBe(true);
    expect(all.slice(10, 20).every((r) => r.status === 201)).toBe(true);
    expect(all.slice(20).every((r) => r.status === 200)).toBe(true);
  });

  it('concurrent requests from different client IPs are handled independently', async () => {
    const app = buildApp();
    const N = 10;

    const [aRes, bRes] = await Promise.all([
      Promise.all(
        Array.from({ length: N }, () =>
          deferred(() =>
            request(app)
              .get(`/api/v1/contracts/${CID}/milestones`)
              .set('X-Forwarded-For', '10.0.0.1'),
          ),
        ),
      ),
      Promise.all(
        Array.from({ length: N }, () =>
          deferred(() =>
            request(app)
              .get(`/api/v1/contracts/${CID}/milestones`)
              .set('X-Forwarded-For', '10.0.0.2'),
          ),
        ),
      ),
    ]);

    for (const r of [...aRes, ...bRes]) expect(r.status).toBe(200);
  });

  // ── Read-after-write via HTTP ──────────────────────────────────────────────

  it('DELETE then GET: soft-deleted milestone absent from default list, visible with includeDeleted=true', async () => {
    const app = buildApp();
    const m = svcSingleton.create(CID, { title: 'RaW', amount: 1 });

    const before = await request(app).get(`/api/v1/contracts/${CID}/milestones`);
    expect(before.body.data.total).toBe(1);

    const del = await request(app).delete(`/api/v1/contracts/${CID}/milestones/${m.id}`);
    expect(del.status).toBe(200);

    const after = await request(app).get(`/api/v1/contracts/${CID}/milestones`);
    expect(after.status).toBe(200);
    expect(after.body.data.total).toBe(0);

    const withDel = await request(app).get(
      `/api/v1/contracts/${CID}/milestones?includeDeleted=true`,
    );
    expect(withDel.body.data.total).toBe(1);
    expect(withDel.body.data.milestones[0].deletedAt).not.toBeNull();
  });

  // ── Full lifecycle ─────────────────────────────────────────────────────────

  it('POST → DELETE → restore: full lifecycle produces consistent HTTP state', async () => {
    process.env[MILESTONES_SOFT_DELETE_RETENTION_DAYS_ENV] = '30';
    const app = buildApp();

    const createRes = await request(app)
      .post(`/api/v1/contracts/${CID}/milestones`)
      .send({ title: 'Lifecycle', amount: 100 });
    expect(createRes.status).toBe(201);
    const id: string = createRes.body.data.milestone.id;

    const delRes = await request(app).delete(
      `/api/v1/contracts/${CID}/milestones/${id}`,
    );
    expect(delRes.status).toBe(200);
    expect(delRes.body.data.milestone.deletedAt).not.toBeNull();

    const restoreRes = await request(app).post(
      `/api/v1/contracts/${CID}/milestones/${id}/restore`,
    );
    expect(restoreRes.status).toBe(200);
    expect(restoreRes.body.data.milestone.deletedAt).toBeNull();

    const finalList = await request(app).get(`/api/v1/contracts/${CID}/milestones`);
    expect(finalList.body.data.total).toBe(1);
  });
});
