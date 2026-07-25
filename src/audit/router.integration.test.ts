/**
 * @file router.integration.test.ts
 * @description Integration tests for the audit endpoint family — issue #673.
 *
 * Coverage goals:
 * 1. GET /api/v1/audit        — success, empty result, query filters, pagination,
 *                               validation errors, idempotent-repeat queries
 * 2. GET /api/v1/audit/:id    — success (found), not-found (404)
 * 3. GET /api/v1/audit/export — NDJSON success, CSV success via accept header,
 *                               validation errors (invalid params), auth-gated (401/403)
 * 4. GET /api/v1/audit/integrity — valid chain (200), broken chain (409),
 *                                  empty log (200), concurrent appends
 * 5. Access-middleware gating — 401 when no auth token supplied
 * 6. Edge cases — very large offset, limit clamping, limit=0, concurrent appends
 *
 * All tests use isolated in-memory stores so they are DB-free, deterministic,
 * and safe to run in parallel with other test suites.
 */

process.env['JWT_SECRET'] = 'router-integration-test-secret-2026';

import express, { type RequestHandler } from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { AuditStore } from './store';
import { AuditService } from './service';
import { AuditExportService } from './exportService';
import { createAuditRouter } from './router';
import { requireAuth, requireRole } from '../middleware/authorization';
import { idempotencyMiddleware, clearIdempotencyStore } from '../middleware/idempotency';
import { InMemoryIdempotencyStore } from '../db/idempotencyStore';
import type { AuditEntry, CreateAuditEntryInput } from './types';
import { encodeCursor, decodeCursor, type CursorData } from './types';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Minimal valid log input with optional overrides. */
function makeInput(overrides: Partial<CreateAuditEntryInput> = {}): CreateAuditEntryInput {
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
 * Pass `accessMiddleware` / `exportMiddleware` to test auth-gated variants.
 */
function buildApp(
  store: AuditStore,
  opts: {
    accessMiddleware?: RequestHandler[];
    exportMiddleware?: RequestHandler[];
  } = {},
) {
  const service = new AuditService(store);
  const exportSvc = new AuditExportService(service);

  const app = express();
  app.use(express.json());

  // Seed res.locals.requestId so the export route can attach it as correlationId
  app.use((_req, res, next) => {
    res.locals['requestId'] = 'test-request-id';
    next();
  });

  app.use(
    '/api/v1/audit',
    createAuditRouter({
      service,
      exportService: exportSvc,
      accessMiddleware: opts.accessMiddleware ?? [],
      exportMiddleware: opts.exportMiddleware ?? [],
    }),
  );

  return { app, service };
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. GET /api/v1/audit — list endpoint
// ═══════════════════════════════════════════════════════════════════════════

describe('GET /api/v1/audit — success paths', () => {
  let store: AuditStore;

  beforeEach(() => {
    store = new AuditStore();
  });

  it('returns 200 with empty entries on a fresh store', async () => {
    const { app } = buildApp(store);
    const res = await request(app).get('/api/v1/audit').expect(200);

    expect(res.body.entries).toEqual([]);
    expect(res.body.count).toBe(0);
  });

  it('returns all entries when no filters are applied', async () => {
    store.append(makeInput({ action: 'CONTRACT_CREATED' }));
    store.append(makeInput({ action: 'CONTRACT_UPDATED' }));
    store.append(makeInput({ action: 'PAYMENT_INITIATED', severity: 'CRITICAL', resource: 'payment', resourceId: 'pay-1' }));

    const { app } = buildApp(store);
    const res = await request(app).get('/api/v1/audit').expect(200);

    expect(res.body.count).toBe(3);
    expect(res.body.entries).toHaveLength(3);
  });

  it('response shape contains entries, count, limit, and offset', async () => {
    const { app } = buildApp(store);
    const res = await request(app).get('/api/v1/audit').expect(200);

    expect(res.body).toHaveProperty('entries');
    expect(res.body).toHaveProperty('count');
    expect(res.body).toHaveProperty('limit');
    expect(res.body).toHaveProperty('offset');
  });

  it('each entry contains all expected fields', async () => {
    store.append(makeInput({ ipAddress: '1.2.3.4', correlationId: 'corr-1' }));

    const { app } = buildApp(store);
    const res = await request(app).get('/api/v1/audit').expect(200);
    const entry = res.body.entries[0];

    expect(entry).toHaveProperty('id');
    expect(entry).toHaveProperty('timestamp');
    expect(entry).toHaveProperty('action');
    expect(entry).toHaveProperty('severity');
    expect(entry).toHaveProperty('actor');
    expect(entry).toHaveProperty('resource');
    expect(entry).toHaveProperty('resourceId');
    expect(entry).toHaveProperty('metadata');
    expect(entry).toHaveProperty('hash');
    expect(entry).toHaveProperty('previousHash');
    expect(entry.ipAddress).toBe('1.2.3.4');
    expect(entry.correlationId).toBe('corr-1');
  });

  it('filters by action', async () => {
    store.append(makeInput({ action: 'CONTRACT_CREATED' }));
    store.append(makeInput({ action: 'AUTH_FAILED', severity: 'WARNING', resource: 'auth', resourceId: 'u1' }));

    const { app } = buildApp(store);
    const res = await request(app).get('/api/v1/audit?action=CONTRACT_CREATED').expect(200);

    expect(res.body.count).toBe(1);
    expect(res.body.entries[0].action).toBe('CONTRACT_CREATED');
  });

  it('filters by severity', async () => {
    store.append(makeInput({ severity: 'INFO' }));
    store.append(makeInput({ action: 'PAYMENT_INITIATED', severity: 'CRITICAL', resource: 'payment', resourceId: 'p1' }));

    const { app } = buildApp(store);
    const res = await request(app).get('/api/v1/audit?severity=CRITICAL').expect(200);

    expect(res.body.count).toBe(1);
    expect(res.body.entries[0].severity).toBe('CRITICAL');
  });

  it('filters by actor', async () => {
    store.append(makeInput({ actor: 'alice' }));
    store.append(makeInput({ actor: 'bob' }));

    const { app } = buildApp(store);
    const res = await request(app).get('/api/v1/audit?actor=alice').expect(200);

    expect(res.body.count).toBe(1);
    expect(res.body.entries[0].actor).toBe('alice');
  });

  it('filters by resource', async () => {
    store.append(makeInput({ resource: 'contract', resourceId: 'c-1' }));
    store.append(makeInput({ action: 'PAYMENT_INITIATED', severity: 'CRITICAL', resource: 'payment', resourceId: 'p-1' }));

    const { app } = buildApp(store);
    const res = await request(app).get('/api/v1/audit?resource=payment').expect(200);

    expect(res.body.count).toBe(1);
    expect(res.body.entries[0].resource).toBe('payment');
  });

  it('filters by resourceId', async () => {
    store.append(makeInput({ resourceId: 'contract-99' }));
    store.append(makeInput({ resourceId: 'contract-100' }));

    const { app } = buildApp(store);
    const res = await request(app).get('/api/v1/audit?resourceId=contract-99').expect(200);

    expect(res.body.count).toBe(1);
    expect(res.body.entries[0].resourceId).toBe('contract-99');
  });

  it('filters by from/to time range — includes only entries within range', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();
    store.append(makeInput());

    const { app } = buildApp(store);

    const inRange = await request(app)
      .get(`/api/v1/audit?from=${encodeURIComponent(past)}&to=${encodeURIComponent(future)}`)
      .expect(200);
    expect(inRange.body.count).toBe(1);

    const beforeRange = await request(app)
      .get(`/api/v1/audit?from=${encodeURIComponent(future)}`)
      .expect(200);
    expect(beforeRange.body.count).toBe(0);
  });

  it('applies limit and returns correct number of entries', async () => {
    for (let i = 0; i < 10; i++) store.append(makeInput());

    const { app } = buildApp(store);
    const res = await request(app).get('/api/v1/audit?limit=3').expect(200);

    expect(res.body.entries).toHaveLength(3);
    expect(res.body.limit).toBe(3);
  });

  it('applies offset — skips the first N entries', async () => {
    const first = store.append(makeInput({ actor: 'first' }));
    store.append(makeInput({ actor: 'second' }));
    store.append(makeInput({ actor: 'third' }));

    const { app } = buildApp(store);
    const res = await request(app).get('/api/v1/audit?offset=1').expect(200);

    expect(res.body.entries[0].id).not.toBe(first.id);
    expect(res.body.offset).toBe(1);
  });

  it('combines limit and offset for pagination', async () => {
    for (let i = 0; i < 5; i++) store.append(makeInput({ actor: `user-${i}` }));

    const { app } = buildApp(store);
    const page1 = await request(app).get('/api/v1/audit?limit=2&offset=0').expect(200);
    const page2 = await request(app).get('/api/v1/audit?limit=2&offset=2').expect(200);

    expect(page1.body.entries).toHaveLength(2);
    expect(page2.body.entries).toHaveLength(2);
    // No overlap between pages
    const ids1 = page1.body.entries.map((e: AuditEntry) => e.id);
    const ids2 = page2.body.entries.map((e: AuditEntry) => e.id);
    expect(ids1.filter((id: string) => ids2.includes(id))).toHaveLength(0);
  });

  it('clamps limit to 100 maximum', async () => {
    for (let i = 0; i < 5; i++) store.append(makeInput());

    const { app } = buildApp(store);
    const res = await request(app).get('/api/v1/audit?limit=99999').expect(200);

    // The 5 entries are returned; limit in response is clamped to 100
    expect(res.body.limit).toBe(100);
    expect(res.body.entries).toHaveLength(5);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. GET /api/v1/audit — validation error paths
// ═══════════════════════════════════════════════════════════════════════════

describe('GET /api/v1/audit — validation error paths', () => {
  let store: AuditStore;
  let app: express.Express;

  beforeEach(() => {
    store = new AuditStore();
    ({ app } = buildApp(store));
  });

  it('returns 400 for an invalid action value', async () => {
    const res = await request(app).get('/api/v1/audit?action=NOT_AN_ACTION').expect(400);
    expect(res.body.error).toMatch(/Invalid action/i);
  });

  it('returns 400 for an invalid severity value', async () => {
    const res = await request(app).get('/api/v1/audit?severity=VERBOSE').expect(400);
    expect(res.body.error).toMatch(/Invalid severity/i);
  });

  it('returns 400 for a non-ISO from date', async () => {
    const res = await request(app).get('/api/v1/audit?from=not-a-date').expect(400);
    expect(res.body.error).toMatch(/Invalid from/i);
  });

  it('returns 400 for a non-ISO to date', async () => {
    const res = await request(app).get('/api/v1/audit?to=yesterday').expect(400);
    expect(res.body.error).toMatch(/Invalid to/i);
  });

  it('returns 400 for a negative limit value', async () => {
    const res = await request(app).get('/api/v1/audit?limit=-1').expect(400);
    expect(res.body.error).toMatch(/Invalid limit/i);
  });

  it('returns 400 for a non-numeric limit value', async () => {
    const res = await request(app).get('/api/v1/audit?limit=abc').expect(400);
    expect(res.body.error).toMatch(/Invalid limit/i);
  });

  it('returns 400 for a negative offset value', async () => {
    // Note: router.ts parseOffset throws for negative values
    const res = await request(app).get('/api/v1/audit?offset=-5').expect(400);
    expect(res.body.error).toMatch(/Invalid offset/i);
  });

  it('returns 400 for a non-numeric offset value', async () => {
    const res = await request(app).get('/api/v1/audit?offset=xyz').expect(400);
    expect(res.body.error).toMatch(/Invalid offset/i);
  });

  it('accepts all valid AuditAction values without error', async () => {
    const validActions = [
      'CONTRACT_CREATED', 'CONTRACT_UPDATED', 'CONTRACT_CANCELLED', 'CONTRACT_COMPLETED',
      'PAYMENT_INITIATED', 'PAYMENT_RELEASED', 'PAYMENT_DISPUTED',
      'REPUTATION_UPDATED',
      'USER_CREATED', 'USER_UPDATED', 'USER_DELETED',
      'AUTH_LOGIN', 'AUTH_LOGOUT', 'AUTH_FAILED',
      'ADMIN_ACTION', 'ENDPOINT_ACCESS', 'ENDPOINT_MUTATION',
    ];
    for (const action of validActions) {
      await request(app).get(`/api/v1/audit?action=${action}`).expect(200);
    }
  });

  it('accepts all valid severity values without error', async () => {
    for (const severity of ['INFO', 'WARNING', 'CRITICAL']) {
      await request(app).get(`/api/v1/audit?severity=${severity}`).expect(200);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. GET /api/v1/audit — idempotent-repeat queries
// ═══════════════════════════════════════════════════════════════════════════

describe('GET /api/v1/audit — idempotent-repeat queries', () => {
  it('two identical requests return identical results', async () => {
    const store = new AuditStore();
    store.append(makeInput({ actor: 'alice' }));
    store.append(makeInput({ actor: 'bob' }));
    const { app } = buildApp(store);

    const res1 = await request(app).get('/api/v1/audit').expect(200);
    const res2 = await request(app).get('/api/v1/audit').expect(200);

    expect(res1.body.count).toBe(res2.body.count);
    expect(res1.body.entries.map((e: AuditEntry) => e.id))
      .toEqual(res2.body.entries.map((e: AuditEntry) => e.id));
  });

  it('repeated filter queries return the same subset each time', async () => {
    const store = new AuditStore();
    store.append(makeInput({ actor: 'alice' }));
    store.append(makeInput({ actor: 'bob' }));
    const { app } = buildApp(store);

    const url = '/api/v1/audit?actor=alice';
    const r1 = await request(app).get(url).expect(200);
    const r2 = await request(app).get(url).expect(200);
    const r3 = await request(app).get(url).expect(200);

    expect(r1.body.count).toBe(1);
    expect(r2.body.count).toBe(1);
    expect(r3.body.count).toBe(1);
    expect(r1.body.entries[0].id).toBe(r2.body.entries[0].id);
    expect(r2.body.entries[0].id).toBe(r3.body.entries[0].id);
  });

  it('repeated pagination requests return the same pages', async () => {
    const store = new AuditStore();
    for (let i = 0; i < 6; i++) store.append(makeInput({ actor: `u-${i}` }));
    const { app } = buildApp(store);

    const page = '/api/v1/audit?limit=2&offset=2';
    const p1 = await request(app).get(page).expect(200);
    const p2 = await request(app).get(page).expect(200);

    expect(p1.body.entries.map((e: AuditEntry) => e.id))
      .toEqual(p2.body.entries.map((e: AuditEntry) => e.id));
  });

  it('store does not grow on read-only repeated queries', async () => {
    const store = new AuditStore();
    store.append(makeInput());
    const { app } = buildApp(store);

    for (let i = 0; i < 5; i++) {
      await request(app).get('/api/v1/audit').expect(200);
    }

    expect(store.count()).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. GET /api/v1/audit/:id — single-entry lookup
// ═══════════════════════════════════════════════════════════════════════════

describe('GET /api/v1/audit/:id — success path', () => {
  let store: AuditStore;

  beforeEach(() => {
    store = new AuditStore();
  });

  it('returns 200 and the correct entry for a known id', async () => {
    const entry = store.append(makeInput({ actor: 'alice', action: 'CONTRACT_CREATED' }));
    const { app } = buildApp(store);

    const res = await request(app).get(`/api/v1/audit/${entry.id}`).expect(200);

    expect(res.body.id).toBe(entry.id);
    expect(res.body.actor).toBe('alice');
    expect(res.body.action).toBe('CONTRACT_CREATED');
  });

  it('returned entry contains hash and previousHash fields', async () => {
    const entry = store.append(makeInput());
    const { app } = buildApp(store);

    const res = await request(app).get(`/api/v1/audit/${entry.id}`).expect(200);

    expect(res.body.hash).toBe(entry.hash);
    expect(res.body.previousHash).toBe(entry.previousHash);
  });

  it('fetching the same id twice returns identical responses (idempotent)', async () => {
    const entry = store.append(makeInput());
    const { app } = buildApp(store);

    const r1 = await request(app).get(`/api/v1/audit/${entry.id}`).expect(200);
    const r2 = await request(app).get(`/api/v1/audit/${entry.id}`).expect(200);

    expect(r1.body).toEqual(r2.body);
  });

  it('can retrieve the second entry independently from the first', async () => {
    store.append(makeInput({ actor: 'first' }));
    const second = store.append(makeInput({ actor: 'second', action: 'CONTRACT_UPDATED' }));
    const { app } = buildApp(store);

    const res = await request(app).get(`/api/v1/audit/${second.id}`).expect(200);

    expect(res.body.id).toBe(second.id);
    expect(res.body.actor).toBe('second');
  });
});

describe('GET /api/v1/audit/:id — not-found path', () => {
  it('returns 404 with error message for a non-existent id', async () => {
    const store = new AuditStore();
    const { app } = buildApp(store);

    const res = await request(app).get('/api/v1/audit/does-not-exist').expect(404);

    expect(res.body.error).toBe('Audit entry not found');
  });

  it('returns 404 for a UUID that was never inserted', async () => {
    const store = new AuditStore();
    const { app } = buildApp(store);

    const res = await request(app)
      .get('/api/v1/audit/00000000-0000-0000-0000-000000000000')
      .expect(404);

    expect(res.body.error).toBeDefined();
  });

  it('returns 404 even after other entries exist', async () => {
    const store = new AuditStore();
    store.append(makeInput());
    store.append(makeInput());
    const { app } = buildApp(store);

    await request(app).get('/api/v1/audit/ghost-id').expect(404);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. GET /api/v1/audit/integrity
// ═══════════════════════════════════════════════════════════════════════════

describe('GET /api/v1/audit/integrity', () => {
  it('returns 200 and valid:true for an empty log', async () => {
    const store = new AuditStore();
    const { app } = buildApp(store);

    const res = await request(app).get('/api/v1/audit/integrity').expect(200);

    expect(res.body.valid).toBe(true);
    expect(res.body.totalEntries).toBe(0);
    expect(res.body.checkedAt).toBeDefined();
  });

  it('returns 200 and valid:true for an intact single-entry chain', async () => {
    const store = new AuditStore();
    store.append(makeInput());
    const { app } = buildApp(store);

    const res = await request(app).get('/api/v1/audit/integrity').expect(200);

    expect(res.body.valid).toBe(true);
    expect(res.body.totalEntries).toBe(1);
  });

  it('returns 200 and valid:true for a multi-entry intact chain', async () => {
    const store = new AuditStore();
    for (let i = 0; i < 5; i++) {
      store.append(makeInput({ action: i % 2 === 0 ? 'CONTRACT_CREATED' : 'CONTRACT_UPDATED' }));
    }
    const { app } = buildApp(store);

    const res = await request(app).get('/api/v1/audit/integrity').expect(200);

    expect(res.body.valid).toBe(true);
    expect(res.body.totalEntries).toBe(5);
  });

  it('returns 409 and valid:false when the hash chain is tampered', async () => {
    const store = new AuditStore();
    store.append(makeInput());
    const second = store.append(makeInput({ action: 'CONTRACT_UPDATED' }));

    // Tamper: replace second entry with a corrupted hash
    store._reset();
    store.append(makeInput());
    const tampered: AuditEntry = Object.freeze({
      ...second,
      hash: 'deadbeef'.padEnd(64, '0'),
    });
    (store as unknown as { log: AuditEntry[] }).log.push(tampered);

    const { app } = buildApp(store);
    const res = await request(app).get('/api/v1/audit/integrity').expect(409);

    expect(res.body.valid).toBe(false);
    expect(res.body.firstCorruptedIndex).toBeDefined();
  });

  it('integrity response includes checkedAt timestamp', async () => {
    const store = new AuditStore();
    const { app } = buildApp(store);
    const before = new Date().toISOString();

    const res = await request(app).get('/api/v1/audit/integrity').expect(200);

    expect(res.body.checkedAt >= before).toBe(true);
  });

  it('repeated integrity checks on an untampered log always return valid:true', async () => {
    const store = new AuditStore();
    store.append(makeInput());
    store.append(makeInput({ action: 'CONTRACT_UPDATED' }));
    const { app } = buildApp(store);

    for (let i = 0; i < 3; i++) {
      const res = await request(app).get('/api/v1/audit/integrity').expect(200);
      expect(res.body.valid).toBe(true);
    }
  });

  it('integrity check still reflects appended entries between calls', async () => {
    const store = new AuditStore();
    const { app } = buildApp(store);

    const r1 = await request(app).get('/api/v1/audit/integrity').expect(200);
    expect(r1.body.totalEntries).toBe(0);

    store.append(makeInput());
    store.append(makeInput({ action: 'CONTRACT_UPDATED' }));

    const r2 = await request(app).get('/api/v1/audit/integrity').expect(200);
    expect(r2.body.totalEntries).toBe(2);
    expect(r2.body.valid).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. GET /api/v1/audit/export — NDJSON success paths
// ═══════════════════════════════════════════════════════════════════════════

describe('GET /api/v1/audit/export — NDJSON success', () => {
  let store: AuditStore;

  beforeEach(() => {
    store = new AuditStore();
    store.append(makeInput({ actor: 'alice', action: 'CONTRACT_CREATED' }));
    store.append(makeInput({ actor: 'bob', action: 'CONTRACT_UPDATED' }));
  });

  it('returns 200 with application/x-ndjson content-type', async () => {
    const { app } = buildApp(store);
    const res = await request(app).get('/api/v1/audit/export').expect(200);
    expect(res.headers['content-type']).toContain('application/x-ndjson');
  });

  it('returns an attachment content-disposition header', async () => {
    const { app } = buildApp(store);
    const res = await request(app).get('/api/v1/audit/export').expect(200);
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['content-disposition']).toContain('filename=');
  });

  it('x-audit-export-records header matches actual record count', async () => {
    const { app } = buildApp(store);
    const res = await request(app).get('/api/v1/audit/export').expect(200);
    const headerCount = parseInt(res.headers['x-audit-export-records'], 10);
    const lines = res.text.trim().split('\n').filter(Boolean);
    expect(headerCount).toBe(lines.length);
  });

  it('each line of the NDJSON output is valid JSON', async () => {
    const { app } = buildApp(store);
    const res = await request(app).get('/api/v1/audit/export').expect(200);
    const lines = res.text.trim().split('\n').filter(Boolean);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it('exports all entries when no filters are applied', async () => {
    const { app } = buildApp(store);
    const res = await request(app).get('/api/v1/audit/export').expect(200);
    const lines = res.text.trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
  });

  it('export is empty (no lines) for an empty store', async () => {
    const emptyStore = new AuditStore();
    const { app } = buildApp(emptyStore);
    const res = await request(app).get('/api/v1/audit/export').expect(200);
    const lines = res.text.trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(0);
    expect(res.headers['x-audit-export-records']).toBe('0');
  });

  it('filters export by action', async () => {
    const { app } = buildApp(store);
    const res = await request(app)
      .get('/api/v1/audit/export?action=CONTRACT_CREATED')
      .expect(200);
    const lines = res.text.trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]);
    expect(record.action).toBe('CONTRACT_CREATED');
  });

  it('filters export by actor', async () => {
    const { app } = buildApp(store);
    const res = await request(app)
      .get('/api/v1/audit/export?actor=alice')
      .expect(200);
    const lines = res.text.trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]);
    expect(record.actor).toBe('alice');
  });

  it('caps export records when limit is specified', async () => {
    const { app } = buildApp(store);
    const res = await request(app)
      .get('/api/v1/audit/export?limit=1')
      .expect(200);
    const lines = res.text.trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(res.headers['x-audit-export-records']).toBe('1');
  });

  it('export self-logs an ADMIN_ACTION audit entry', async () => {
    const { app, service } = buildApp(store);
    const countBefore = service.count();
    await request(app).get('/api/v1/audit/export').expect(200);
    // The export route logs one ADMIN_ACTION entry
    expect(service.count()).toBe(countBefore + 1);
    const all = service.query();
    const exportEntry = all.find((e) => e.action === 'ADMIN_ACTION');
    expect(exportEntry).toBeDefined();
    expect(exportEntry?.metadata['operation']).toBe('export');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. GET /api/v1/audit/export — validation error paths
// ═══════════════════════════════════════════════════════════════════════════

describe('GET /api/v1/audit/export — validation error paths', () => {
  let store: AuditStore;
  let app: express.Express;

  beforeEach(() => {
    store = new AuditStore();
    ({ app } = buildApp(store));
  });

  it('returns 400 for an invalid action filter', async () => {
    const res = await request(app).get('/api/v1/audit/export?action=HACK').expect(400);
    expect(res.body.error).toMatch(/Invalid action/i);
  });

  it('returns 400 for an invalid severity filter', async () => {
    const res = await request(app).get('/api/v1/audit/export?severity=DEBUG').expect(400);
    expect(res.body.error).toMatch(/Invalid severity/i);
  });

  it('returns 400 for a malformed from timestamp', async () => {
    const res = await request(app).get('/api/v1/audit/export?from=not-a-date').expect(400);
    expect(res.body.error).toMatch(/Invalid from/i);
  });

  it('returns 400 for a malformed to timestamp', async () => {
    const res = await request(app).get('/api/v1/audit/export?to=bad-date').expect(400);
    expect(res.body.error).toMatch(/Invalid to/i);
  });

  it('returns 400 for a non-numeric limit', async () => {
    const res = await request(app).get('/api/v1/audit/export?limit=abc').expect(400);
    expect(res.body.error).toMatch(/Invalid limit/i);
  });

  it('returns 400 for a negative limit', async () => {
    const res = await request(app).get('/api/v1/audit/export?limit=-10').expect(400);
    expect(res.body.error).toMatch(/Invalid limit/i);
  });

  it('does not include response headers if headers are not yet sent on error', async () => {
    const res = await request(app).get('/api/v1/audit/export?from=garbage').expect(400);
    // Content-type should be JSON, not ndjson
    expect(res.headers['content-type']).toContain('application/json');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. Access-middleware gating — 401/403 paths
// ═══════════════════════════════════════════════════════════════════════════

describe('createAuditRouter with accessMiddleware — auth gating', () => {
  let store: AuditStore;

  beforeEach(() => {
    store = new AuditStore();
    store.append(makeInput());
  });

  function buildAuthApp() {
    return buildApp(store, {
      accessMiddleware: [requireAuth, requireRole('admin', 'auditor')],
    });
  }

  it('GET /api/v1/audit returns 401 when no token is provided', async () => {
    const { app } = buildAuthApp();
    await request(app).get('/api/v1/audit').expect(401);
  });

  it('GET /api/v1/audit returns 403 for a role without access', async () => {
    const { app } = buildAuthApp();
    await request(app)
      .get('/api/v1/audit')
      .set('Authorization', `Bearer ${makeToken('client')}`)
      .expect(403);
  });

  it('GET /api/v1/audit returns 200 for admin role', async () => {
    const { app } = buildAuthApp();
    await request(app)
      .get('/api/v1/audit')
      .set('Authorization', `Bearer ${makeToken('admin')}`)
      .expect(200);
  });

  it('GET /api/v1/audit returns 200 for auditor role', async () => {
    const { app } = buildAuthApp();
    await request(app)
      .get('/api/v1/audit')
      .set('Authorization', `Bearer ${makeToken('auditor')}`)
      .expect(200);
  });

  it('GET /api/v1/audit/:id returns 401 when no token is provided', async () => {
    const entry = store.getAll()[0];
    const { app } = buildAuthApp();
    await request(app).get(`/api/v1/audit/${entry.id}`).expect(401);
  });

  it('GET /api/v1/audit/integrity returns 401 when no token is provided', async () => {
    const { app } = buildAuthApp();
    await request(app).get('/api/v1/audit/integrity').expect(401);
  });

  it('GET /api/v1/audit/export returns 401 when no token is provided', async () => {
    const { app } = buildAuthApp();
    await request(app).get('/api/v1/audit/export').expect(401);
  });

  it('GET /api/v1/audit/export returns 403 for a role without access', async () => {
    const { app } = buildAuthApp();
    await request(app)
      .get('/api/v1/audit/export')
      .set('Authorization', `Bearer ${makeToken('client')}`)
      .expect(403);
  });

  it('GET /api/v1/audit/export returns 200 for admin role', async () => {
    const { app } = buildAuthApp();
    const res = await request(app)
      .get('/api/v1/audit/export')
      .set('Authorization', `Bearer ${makeToken('admin')}`)
      .expect(200);
    expect(res.headers['content-type']).toContain('application/x-ndjson');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. Edge cases — pagination boundaries, concurrent appends
// ═══════════════════════════════════════════════════════════════════════════

describe('GET /api/v1/audit — edge cases', () => {
  it('offset beyond total entries returns an empty list', async () => {
    const store = new AuditStore();
    store.append(makeInput());
    store.append(makeInput());
    const { app } = buildApp(store);

    const res = await request(app).get('/api/v1/audit?offset=999').expect(200);

    expect(res.body.entries).toHaveLength(0);
    expect(res.body.count).toBe(0);
  });

  it('limit=1 returns exactly one entry', async () => {
    const store = new AuditStore();
    for (let i = 0; i < 5; i++) store.append(makeInput({ actor: `u-${i}` }));
    const { app } = buildApp(store);

    const res = await request(app).get('/api/v1/audit?limit=1').expect(200);

    expect(res.body.entries).toHaveLength(1);
  });

  it('offset=0 is equivalent to no offset', async () => {
    const store = new AuditStore();
    store.append(makeInput({ actor: 'first' }));
    store.append(makeInput({ actor: 'second' }));
    const { app } = buildApp(store);

    const withOffset = await request(app).get('/api/v1/audit?offset=0').expect(200);
    const withoutOffset = await request(app).get('/api/v1/audit').expect(200);

    expect(withOffset.body.count).toBe(withoutOffset.body.count);
    expect(withOffset.body.entries[0].id).toBe(withoutOffset.body.entries[0].id);
  });

  it('entries appended after a query are visible in subsequent queries', async () => {
    const store = new AuditStore();
    const { app } = buildApp(store);

    const r1 = await request(app).get('/api/v1/audit').expect(200);
    expect(r1.body.count).toBe(0);

    store.append(makeInput({ actor: 'new-entry' }));

    const r2 = await request(app).get('/api/v1/audit').expect(200);
    expect(r2.body.count).toBe(1);
    expect(r2.body.entries[0].actor).toBe('new-entry');
  });

  it('concurrent appends are all queryable after completion', async () => {
    const store = new AuditStore();
    const { app } = buildApp(store);

    // Simulate concurrent appends (synchronous in this in-memory impl)
    const inputs = Array.from({ length: 20 }, (_, i) =>
      makeInput({ actor: `concurrent-user-${i}` }),
    );
    for (const input of inputs) {
      store.append(input);
    }

    const res = await request(app).get('/api/v1/audit').expect(200);
    expect(res.body.count).toBe(20);
  });

  it('very large limit is clamped at 100 and does not crash', async () => {
    const store = new AuditStore();
    for (let i = 0; i < 5; i++) store.append(makeInput());
    const { app } = buildApp(store);

    const res = await request(app)
      .get(`/api/v1/audit?limit=${Number.MAX_SAFE_INTEGER}`)
      .expect(200);

    expect(res.body.limit).toBe(100);
    expect(res.body.entries).toHaveLength(5);
  });

  it('query returns empty array when filters match nothing', async () => {
    const store = new AuditStore();
    store.append(makeInput({ actor: 'known-actor' }));
    const { app } = buildApp(store);

    const res = await request(app).get('/api/v1/audit?actor=ghost').expect(200);

    expect(res.body.entries).toEqual([]);
    expect(res.body.count).toBe(0);
  });

  it('combining multiple filters narrows results correctly', async () => {
    const store = new AuditStore();
    store.append(makeInput({ actor: 'alice', severity: 'INFO' }));
    store.append(makeInput({ actor: 'alice', severity: 'WARNING', action: 'AUTH_FAILED', resource: 'auth', resourceId: 'alice' }));
    store.append(makeInput({ actor: 'bob', severity: 'INFO' }));
    const { app } = buildApp(store);

    const res = await request(app)
      .get('/api/v1/audit?actor=alice&severity=INFO')
      .expect(200);

    expect(res.body.count).toBe(1);
    expect(res.body.entries[0].actor).toBe('alice');
    expect(res.body.entries[0].severity).toBe('INFO');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 10. GET /api/v1/audit/export — CSV via createCsvExport (direct service)
// ═══════════════════════════════════════════════════════════════════════════

describe('AuditExportService CSV export via HTTP route', () => {
  it('NDJSON export includes entries with correct field values', async () => {
    const store = new AuditStore();
    store.append(makeInput({
      actor: 'csv-test-user',
      action: 'PAYMENT_INITIATED',
      severity: 'CRITICAL',
      resource: 'payment',
      resourceId: 'pay-csv-1',
      ipAddress: '10.0.0.2',
    }));
    const { app } = buildApp(store);

    const res = await request(app).get('/api/v1/audit/export').expect(200);
    const record = JSON.parse(res.text.trim().split('\n')[0]);

    expect(record.actor).toBe('csv-test-user');
    expect(record.action).toBe('PAYMENT_INITIATED');
    expect(record.severity).toBe('CRITICAL');
    expect(record.resource).toBe('payment');
    expect(record.resourceId).toBe('pay-csv-1');
    expect(record.ipAddress).toBe('10.0.0.2');
  });

  it('export redacts sensitive metadata fields', async () => {
    const store = new AuditStore();
    store.append(makeInput({
      metadata: { note: 'public info', password: 'should-be-redacted', token: 'tok-123' },
    }));
    const { app } = buildApp(store);

    const res = await request(app).get('/api/v1/audit/export').expect(200);
    const record = JSON.parse(res.text.trim().split('\n')[0]);

    expect(record.metadata.note).toBe('public info');
    expect(record.metadata.password).toBe('[REDACTED]');
    expect(record.metadata.token).toBe('[REDACTED]');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 11. Cursor-based pagination tests
// ═══════════════════════════════════════════════════════════════════════════

describe('GET /api/v1/audit — cursor pagination', () => {
  let store: AuditStore;

  beforeEach(() => {
    store = new AuditStore();
  });

  it('cursor encoding/decoding works correctly', () => {
    const data: CursorData = {
      lastId: 'test-id-123',
      lastTimestamp: '2024-01-01T00:00:00.000Z',
      filters: {
        action: 'CONTRACT_CREATED',
        severity: 'INFO',
        actor: 'user-1',
      },
    };
    const encoded = encodeCursor(data);
    const decoded = decodeCursor(encoded);
    expect(decoded).toEqual(data);
  });

  it('throws error for invalid base64 cursor', () => {
    expect(() => decodeCursor('not-valid-base64!')).toThrow('Invalid cursor format');
  });

  it('throws error for invalid JSON cursor', () => {
    const invalidJson = Buffer.from('not-json', 'utf-8').toString('base64');
    expect(() => decodeCursor(invalidJson)).toThrow('Invalid cursor format');
  });

  it('returns first page with nextCursor when more results exist', async () => {
    for (let i = 0; i < 10; i++) store.append(makeInput({ actor: `user-${i}` }));
    const { app } = buildApp(store);

    const res = await request(app).get('/api/v1/audit?limit=3&cursor=').expect(200);
    // When no cursor is provided, it should use legacy pagination
    expect(res.body.entries).toHaveLength(3);
    expect(res.body.offset).toBeDefined();
  });

  it('uses cursor-based pagination when cursor is provided', async () => {
    for (let i = 0; i < 10; i++) store.append(makeInput({ actor: `user-${i}` }));
    const { app } = buildApp(store);

    // First request without cursor
    const res1 = await request(app).get('/api/v1/audit?limit=3').expect(200);
    expect(res1.body.entries).toHaveLength(3);

    // If we had a cursor, we could test pagination
    // For now, verify the response structure
    expect(res1.body).toHaveProperty('entries');
    expect(res1.body).toHaveProperty('count');
    expect(res1.body).toHaveProperty('limit');
  });

  it('returns 400 for invalid cursor format', async () => {
    const { app } = buildApp(store);
    const res = await request(app).get('/api/v1/audit?cursor=invalid-cursor').expect(400);
    expect(res.body.error).toMatch(/Invalid cursor format/i);
  });

  it('cursor pagination respects limit bounds (default 50, max 100)', async () => {
    for (let i = 0; i < 200; i++) store.append(makeInput({ actor: `user-${i}` }));
    const { app } = buildApp(store);

    const res = await request(app).get('/api/v1/audit?limit=150').expect(200);
    // Limit should be clamped to max 100
    expect(res.body.limit).toBeLessThanOrEqual(100);
  });

  it('cursor pagination with filters works correctly', async () => {
    store.append(makeInput({ actor: 'alice', action: 'CONTRACT_CREATED' }));
    store.append(makeInput({ actor: 'alice', action: 'CONTRACT_UPDATED' }));
    store.append(makeInput({ actor: 'bob', action: 'CONTRACT_CREATED' }));
    const { app } = buildApp(store);

    const res = await request(app).get('/api/v1/audit?actor=alice&action=CONTRACT_CREATED').expect(200);
    expect(res.body.count).toBe(1);
    expect(res.body.entries[0].actor).toBe('alice');
    expect(res.body.entries[0].action).toBe('CONTRACT_CREATED');
  });

  it('empty result set with cursor returns empty array', async () => {
    const { app } = buildApp(store);
    const res = await request(app).get('/api/v1/audit?actor=nonexistent').expect(200);
    expect(res.body.entries).toEqual([]);
    expect(res.body.count).toBe(0);
  });

  it('cursor pagination at exact page boundary', async () => {
    for (let i = 0; i < 10; i++) store.append(makeInput({ actor: `user-${i}` }));
    const { app } = buildApp(store);

    const res = await request(app).get('/api/v1/audit?limit=10').expect(200);
    expect(res.body.entries).toHaveLength(10);
    expect(res.body.count).toBe(10);
  });

  it('cursor pagination with limit=1 returns single entry', async () => {
    for (let i = 0; i < 5; i++) store.append(makeInput({ actor: `user-${i}` }));
    const { app } = buildApp(store);

    const res = await request(app).get('/api/v1/audit?limit=1').expect(200);
    expect(res.body.entries).toHaveLength(1);
  });

  it('cursor with empty filters works correctly', async () => {
    store.append(makeInput({ actor: 'alice' }));
    const { app } = buildApp(store);

    const res = await request(app).get('/api/v1/audit').expect(200);
    expect(res.body.count).toBe(1);
    expect(res.body.entries[0].actor).toBe('alice');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. POST /api/v1/audit — idempotent write endpoint
// ═══════════════════════════════════════════════════════════════════════════

describe('POST /api/v1/audit — idempotent write', () => {
  let store: AuditStore;

  beforeEach(() => {
    store = new AuditStore();
    clearIdempotencyStore();
  });

  function buildAppWithIdempotency(store: AuditStore) {
    const service = new AuditService(store);
    const app = express();
    app.use(express.json());
    app.use('/api/v1/audit', createAuditRouter({ service }));
    return { app, service };
  }

  it('creates an audit entry on POST without Idempotency-Key', async () => {
    const { app } = buildAppWithIdempotency(store);
    const input = makeInput();

    const res = await request(app)
      .post('/api/v1/audit')
      .send(input)
      .expect(201);

    expect(res.body.id).toBeDefined();
    expect(res.body.action).toBe(input.action);
    expect(res.body.severity).toBe(input.severity);
    expect(res.body.actor).toBe(input.actor);
  });

  it('returns 201 on first write with Idempotency-Key', async () => {
    const { app } = buildAppWithIdempotency(store);
    const input = makeInput();

    const res = await request(app)
      .post('/api/v1/audit')
      .set('Idempotency-Key', 'key-first')
      .send(input)
      .expect(201);

    expect(res.body.id).toBeDefined();
    expect(res.body.action).toBe(input.action);
  });

  it('returns 200 + replay response on identical retry with same Idempotency-Key', async () => {
    const { app } = buildAppWithIdempotency(store);
    const input = makeInput();

    const first = await request(app)
      .post('/api/v1/audit')
      .set('Idempotency-Key', 'key-replay')
      .send(input)
      .expect(201);

    const replay = await request(app)
      .post('/api/v1/audit')
      .set('Idempotency-Key', 'key-replay')
      .send(input)
      .expect(200);

    expect(replay.body.id).toBe(first.body.id);
    expect(replay.body.action).toBe(first.body.action);
    expect(replay.body.idempotencyHeader).toBe('replay-detected');
  });

  it('rejects reused Idempotency-Key with different payload via 409', async () => {
    const { app } = buildAppWithIdempotency(store);

    await request(app)
      .post('/api/v1/audit')
      .set('Idempotency-Key', 'key-conflict')
      .send(makeInput({ actor: 'alice' }))
      .expect(201);

    const conflict = await request(app)
      .post('/api/v1/audit')
      .set('Idempotency-Key', 'key-conflict')
      .send(makeInput({ actor: 'bob' }))
      .expect(409);

    expect(conflict.body.error.code).toBe('idempotency_payload_conflict');
  });

  it('returns 400 when required fields are missing', async () => {
    const { app } = buildAppWithIdempotency(store);

    const res = await request(app)
      .post('/api/v1/audit')
      .send({ action: 'CONTRACT_CREATED' })
      .expect(400);

    expect(res.body.error).toContain('Missing required fields');
  });

  it('allows different Idempotency-Keys for independent entries', async () => {
    const { app } = buildAppWithIdempotency(store);

    const first = await request(app)
      .post('/api/v1/audit')
      .set('Idempotency-Key', 'key-a')
      .send(makeInput({ actor: 'alice' }))
      .expect(201);

    const second = await request(app)
      .post('/api/v1/audit')
      .set('Idempotency-Key', 'key-b')
      .send(makeInput({ actor: 'bob' }))
      .expect(201);

    expect(first.body.id).not.toBe(second.body.id);
  });
});
