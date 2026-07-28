/**
 * @file router.bulk.test.ts
 * @description Integration tests for `POST /api/v1/audit/bulk` — issue audit-22.
 *
 * Coverage goals:
 * 1. Success — all items valid, per-item results, sequential hash chain intact.
 * 2. Partial failure — some items fail validation or persistence; the batch
 *    still completes and reports per-item success/error (207).
 * 3. Envelope validation — empty batch, over-cap batch, non-array `entries`,
 *    missing `entries` (all rejected with 400 before any item is processed).
 * 4. Idempotency — whole-batch replay and payload-conflict semantics, shared
 *    with `POST /` via the same `idempotencyMiddleware`.
 * 5. Access-middleware gating — 401/403 paths, matching `POST /`'s pattern.
 *
 * Uses isolated in-memory stores (DB-free, deterministic), matching the
 * conventions in `router.integration.test.ts`.
 */

process.env['JWT_SECRET'] = 'router-bulk-test-secret-2026';

import express, { type RequestHandler } from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { AuditStore } from './store';
import { AuditService } from './service';
import { createAuditRouter, MAX_BULK_AUDIT_ITEMS } from './router';
import { requireAuth, requireRole } from '../middleware/authorization';
import { clearIdempotencyStore } from '../middleware/idempotency';
import type { AuditEntry, AuditLogRepository, AuditQuery, AuditQueryResult, CreateAuditEntryInput, IntegrityReport } from './types';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Minimal valid bulk item with optional overrides. */
function makeItem(overrides: Partial<CreateAuditEntryInput> = {}): CreateAuditEntryInput {
  return {
    action: 'CONTRACT_CREATED',
    severity: 'INFO',
    actor: 'user-abc',
    resource: 'contract',
    resourceId: 'contract-1',
    metadata: { note: 'test' },
    ...overrides,
  };
}

/** JWT signed with the test secret. */
function makeToken(role: 'admin' | 'auditor' | 'client', sub = `${role}-1`): string {
  return jwt.sign(
    { sub, email: `${role}@test.example`, role },
    process.env['JWT_SECRET'] as string,
    { expiresIn: '1h' },
  );
}

/**
 * Builds an isolated Express app wired to createAuditRouter().
 * Pass `accessMiddleware` to test the auth-gated variant.
 */
function buildApp(
  store: AuditStore,
  opts: { accessMiddleware?: RequestHandler[] } = {},
) {
  const service = new AuditService(store);
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals['requestId'] = 'test-request-id';
    next();
  });
  app.use(
    '/api/v1/audit',
    createAuditRouter({ service, accessMiddleware: opts.accessMiddleware ?? [] }),
  );
  return { app, service, store };
}

/**
 * Wraps a real AuditStore, forwarding every call except `append`, which
 * throws `error` on calls whose 1-based index is in `failOnCalls`. Used to
 * simulate a persistence-layer failure for a specific item in a batch
 * without needing a full mock of AuditLogRepository.
 */
class FlakyRepository implements AuditLogRepository {
  private callCount = 0;

  constructor(
    private readonly inner: AuditStore,
    private readonly failOnCalls: Set<number>,
    private readonly error: Error,
  ) {}

  append(input: CreateAuditEntryInput): AuditEntry {
    this.callCount += 1;
    if (this.failOnCalls.has(this.callCount)) {
      throw this.error;
    }
    return this.inner.append(input);
  }

  getById(id: string): AuditEntry | undefined {
    return this.inner.getById(id);
  }

  query(query?: AuditQuery): AuditEntry[] {
    return this.inner.query(query);
  }

  queryWithCursor(query?: AuditQuery): AuditQueryResult {
    return this.inner.queryWithCursor(query);
  }

  stream(query?: AuditQuery): IterableIterator<AuditEntry> {
    return this.inner.stream(query);
  }

  count(): number {
    return this.inner.count();
  }

  verifyIntegrity(): IntegrityReport {
    return this.inner.verifyIntegrity();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Success paths
// ═══════════════════════════════════════════════════════════════════════════

describe('POST /api/v1/audit/bulk — success paths', () => {
  let store: AuditStore;

  beforeEach(() => {
    store = new AuditStore();
    clearIdempotencyStore();
  });

  it('creates every entry and returns 201 when all items are valid', async () => {
    const { app } = buildApp(store);
    const entries = [
      makeItem({ actor: 'alice' }),
      makeItem({ actor: 'bob' }),
      makeItem({ actor: 'carol' }),
    ];

    const res = await request(app)
      .post('/api/v1/audit/bulk')
      .send({ entries })
      .expect(201);

    expect(res.body.succeeded).toBe(3);
    expect(res.body.failed).toBe(0);
    expect(res.body.results).toHaveLength(3);
    res.body.results.forEach((result: { index: number; success: boolean; entry?: AuditEntry }, i: number) => {
      expect(result.index).toBe(i);
      expect(result.success).toBe(true);
      expect(result.entry?.id).toBeDefined();
    });
    expect(store.count()).toBe(3);
  });

  it('appends entries sequentially, preserving the tamper-evident hash chain', async () => {
    const { app } = buildApp(store);
    const entries = [makeItem({ actor: 'alice' }), makeItem({ actor: 'bob' })];

    await request(app).post('/api/v1/audit/bulk').send({ entries }).expect(201);

    const report = store.verifyIntegrity();
    expect(report.valid).toBe(true);
    expect(report.totalEntries).toBe(2);
    const [first, second] = store.getAll();
    expect(second.previousHash).toBe(first.hash);
  });

  it('accepts a batch of exactly MAX_BULK_AUDIT_ITEMS items', async () => {
    const { app } = buildApp(store);
    const entries = Array.from({ length: MAX_BULK_AUDIT_ITEMS }, (_, i) => makeItem({ actor: `user-${i}` }));

    const res = await request(app)
      .post('/api/v1/audit/bulk')
      .send({ entries })
      .expect(201);

    expect(res.body.succeeded).toBe(MAX_BULK_AUDIT_ITEMS);
    expect(store.count()).toBe(MAX_BULK_AUDIT_ITEMS);
  });

  it('accepts a single-item batch', async () => {
    const { app } = buildApp(store);
    const res = await request(app)
      .post('/api/v1/audit/bulk')
      .send({ entries: [makeItem()] })
      .expect(201);

    expect(res.body.succeeded).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Partial failure
// ═══════════════════════════════════════════════════════════════════════════

describe('POST /api/v1/audit/bulk — partial failure', () => {
  let store: AuditStore;

  beforeEach(() => {
    store = new AuditStore();
    clearIdempotencyStore();
  });

  it('returns 207 and reports per-item errors for items missing required fields, without failing the batch', async () => {
    const { app } = buildApp(store);
    const entries = [
      makeItem({ actor: 'alice' }),
      { action: 'CONTRACT_CREATED' }, // missing severity/actor/resource/resourceId
      makeItem({ actor: 'carol' }),
    ];

    const res = await request(app)
      .post('/api/v1/audit/bulk')
      .send({ entries })
      .expect(207);

    expect(res.body.succeeded).toBe(2);
    expect(res.body.failed).toBe(1);
    expect(res.body.results).toHaveLength(3);
    expect(res.body.results[0].success).toBe(true);
    expect(res.body.results[1].success).toBe(false);
    expect(res.body.results[1].error).toContain('Missing required fields');
    expect(res.body.results[1].entry).toBeUndefined();
    expect(res.body.results[2].success).toBe(true);

    // Only the two valid items were actually persisted.
    expect(store.count()).toBe(2);
  });

  it('rejects an item with an invalid action while accepting the rest', async () => {
    const { app } = buildApp(store);
    const entries = [makeItem(), makeItem({ action: 'NOT_A_REAL_ACTION' as never })];

    const res = await request(app)
      .post('/api/v1/audit/bulk')
      .send({ entries })
      .expect(207);

    expect(res.body.results[0].success).toBe(true);
    expect(res.body.results[1].success).toBe(false);
    expect(res.body.results[1].error).toContain('Invalid action');
  });

  it('rejects an item with an invalid severity while accepting the rest', async () => {
    const { app } = buildApp(store);
    const entries = [makeItem({ severity: 'CATASTROPHIC' as never }), makeItem()];

    const res = await request(app)
      .post('/api/v1/audit/bulk')
      .send({ entries })
      .expect(207);

    expect(res.body.results[0].success).toBe(false);
    expect(res.body.results[0].error).toContain('Invalid severity');
    expect(res.body.results[1].success).toBe(true);
  });

  it('rejects a non-object item (e.g. a string) while accepting the rest', async () => {
    const { app } = buildApp(store);
    const entries = [makeItem(), 'not-an-object'];

    const res = await request(app)
      .post('/api/v1/audit/bulk')
      .send({ entries })
      .expect(207);

    expect(res.body.results[0].success).toBe(true);
    expect(res.body.results[1].success).toBe(false);
    expect(res.body.results[1].error).toBe('Item must be an object');
  });

  it('reports a persistence-layer failure for a single item without discarding sibling items', async () => {
    const repo = new FlakyRepository(store, new Set([2]), new Error('simulated write failure'));
    const service = new AuditService(repo);
    const app = express();
    app.use(express.json());
    app.use('/api/v1/audit', createAuditRouter({ service }));

    const entries = [makeItem({ actor: 'alice' }), makeItem({ actor: 'bob' }), makeItem({ actor: 'carol' })];

    const res = await request(app)
      .post('/api/v1/audit/bulk')
      .send({ entries })
      .expect(207);

    expect(res.body.succeeded).toBe(2);
    expect(res.body.failed).toBe(1);
    expect(res.body.results[0].success).toBe(true);
    expect(res.body.results[1].success).toBe(false);
    expect(res.body.results[1].error).toBe('simulated write failure');
    expect(res.body.results[2].success).toBe(true);

    // The failed item never reached the store; the chain among the two
    // successful appends is still intact.
    expect(store.count()).toBe(2);
    expect(store.verifyIntegrity().valid).toBe(true);
  });

  it('returns 207 when every item fails', async () => {
    const { app } = buildApp(store);
    const entries = [{ action: 'CONTRACT_CREATED' }, { action: 'CONTRACT_CREATED' }];

    const res = await request(app)
      .post('/api/v1/audit/bulk')
      .send({ entries })
      .expect(207);

    expect(res.body.succeeded).toBe(0);
    expect(res.body.failed).toBe(2);
    expect(store.count()).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Envelope validation — empty batch, over-cap, malformed body
// ═══════════════════════════════════════════════════════════════════════════

describe('POST /api/v1/audit/bulk — envelope validation', () => {
  let store: AuditStore;

  beforeEach(() => {
    store = new AuditStore();
    clearIdempotencyStore();
  });

  it('rejects an empty batch with 400', async () => {
    const { app } = buildApp(store);
    const res = await request(app)
      .post('/api/v1/audit/bulk')
      .send({ entries: [] })
      .expect(400);

    expect(res.body.error.code).toBe('validation_error');
    expect(store.count()).toBe(0);
  });

  it('rejects a batch over MAX_BULK_AUDIT_ITEMS with 400 and processes nothing', async () => {
    const { app } = buildApp(store);
    const entries = Array.from({ length: MAX_BULK_AUDIT_ITEMS + 1 }, () => makeItem());

    const res = await request(app)
      .post('/api/v1/audit/bulk')
      .send({ entries })
      .expect(400);

    expect(res.body.error.code).toBe('validation_error');
    expect(store.count()).toBe(0);
  });

  it('rejects a request with no entries field', async () => {
    const { app } = buildApp(store);
    const res = await request(app)
      .post('/api/v1/audit/bulk')
      .send({})
      .expect(400);

    expect(res.body.error.code).toBe('validation_error');
  });

  it('rejects a request where entries is not an array', async () => {
    const { app } = buildApp(store);
    const res = await request(app)
      .post('/api/v1/audit/bulk')
      .send({ entries: 'not-an-array' })
      .expect(400);

    expect(res.body.error.code).toBe('validation_error');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Idempotency — shared idempotencyMiddleware, whole-batch semantics
// ═══════════════════════════════════════════════════════════════════════════

describe('POST /api/v1/audit/bulk — idempotency', () => {
  let store: AuditStore;

  beforeEach(() => {
    store = new AuditStore();
    clearIdempotencyStore();
  });

  it('returns 200 + replay response on identical retry with the same Idempotency-Key', async () => {
    const { app } = buildApp(store);
    const entries = [makeItem({ actor: 'alice' }), makeItem({ actor: 'bob' })];

    const first = await request(app)
      .post('/api/v1/audit/bulk')
      .set('Idempotency-Key', 'bulk-key-replay')
      .send({ entries })
      .expect(201);

    const replay = await request(app)
      .post('/api/v1/audit/bulk')
      .set('Idempotency-Key', 'bulk-key-replay')
      .send({ entries })
      .expect(200);

    expect(replay.body.succeeded).toBe(first.body.succeeded);
    expect(replay.body.idempotencyHeader).toBe('replay-detected');
    // The retried request did not append a second time.
    expect(store.count()).toBe(2);
  });

  it('rejects a reused Idempotency-Key with a different batch payload via 409', async () => {
    const { app } = buildApp(store);

    await request(app)
      .post('/api/v1/audit/bulk')
      .set('Idempotency-Key', 'bulk-key-conflict')
      .send({ entries: [makeItem({ actor: 'alice' })] })
      .expect(201);

    const conflict = await request(app)
      .post('/api/v1/audit/bulk')
      .set('Idempotency-Key', 'bulk-key-conflict')
      .send({ entries: [makeItem({ actor: 'bob' })] })
      .expect(409);

    expect(conflict.body.error.code).toBe('idempotency_payload_conflict');
  });

  it('allows different Idempotency-Keys for independent batches', async () => {
    const { app } = buildApp(store);

    await request(app)
      .post('/api/v1/audit/bulk')
      .set('Idempotency-Key', 'bulk-key-a')
      .send({ entries: [makeItem({ actor: 'alice' })] })
      .expect(201);

    await request(app)
      .post('/api/v1/audit/bulk')
      .set('Idempotency-Key', 'bulk-key-b')
      .send({ entries: [makeItem({ actor: 'bob' })] })
      .expect(201);

    expect(store.count()).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Access-middleware gating — 401/403 paths
// ═══════════════════════════════════════════════════════════════════════════

describe('POST /api/v1/audit/bulk — auth gating', () => {
  let store: AuditStore;

  beforeEach(() => {
    store = new AuditStore();
    clearIdempotencyStore();
  });

  function buildAuthApp() {
    return buildApp(store, {
      accessMiddleware: [requireAuth, requireRole('admin', 'auditor')],
    });
  }

  it('returns 401 when no token is provided', async () => {
    const { app } = buildAuthApp();
    await request(app)
      .post('/api/v1/audit/bulk')
      .send({ entries: [makeItem()] })
      .expect(401);
  });

  it('returns 403 for a role without access', async () => {
    const { app } = buildAuthApp();
    await request(app)
      .post('/api/v1/audit/bulk')
      .set('Authorization', `Bearer ${makeToken('client')}`)
      .send({ entries: [makeItem()] })
      .expect(403);
  });

  it('returns 201 for admin role', async () => {
    const { app } = buildAuthApp();
    await request(app)
      .post('/api/v1/audit/bulk')
      .set('Authorization', `Bearer ${makeToken('admin')}`)
      .send({ entries: [makeItem()] })
      .expect(201);
  });
});
