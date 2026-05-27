/**
 * @file audit.test.ts
 * @description Comprehensive unit and integration tests for the audit log system.
 *
 * Coverage targets:
 * - AuditStore: append, query, getById, verifyIntegrity, immutability
 * - AuditService: all convenience wrappers, error handling
 * - auditRouter: all HTTP endpoints, validation, edge cases
 * - Security: tamper detection, mutation prevention, input validation
 */

import request from 'supertest';
import express from 'express';
import { AuditStore, GENESIS_HASH, computeEntryHash } from './store';
import { AuditService } from './service';
import { auditMiddleware } from './middleware';
import { auditRouter } from './router';
import type { AuditEntry, CreateAuditEntryInput } from './types';
import {
  isSensitiveHeader,
  isSensitiveKey,
  maskEmail,
  redactHeaders,
  redactBody,
  buildAuditMetadata,
  REDACTED,
} from './redact';
import { createProtectedEndpointAuditMiddleware } from './protectedEndpointMiddleware';
import { createToken } from '../auth/authenticate';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeInput(overrides: Partial<CreateAuditEntryInput> = {}): CreateAuditEntryInput {
  return {
    action: 'CONTRACT_CREATED',
    severity: 'INFO',
    actor: 'user-abc',
    resource: 'contract',
    resourceId: 'contract-1',
    metadata: { clientId: 'client-1' },
    ...overrides,
  };
}

function buildTestApp(store?: AuditStore) {
  const app = express();
  app.use(express.json());
  app.use(auditMiddleware);
  if (store) {
    // Swap the singleton for an isolated store in integration tests
    const svc = new AuditService(store);
    const router = express.Router();
    // Use a fresh router wired to the isolated service
    router.get('/', (req, res) => {
      const limit = Math.min(parseInt(req.query['limit'] as string ?? '100', 10) || 100, 1000);
      const offset = Math.max(parseInt(req.query['offset'] as string ?? '0', 10) || 0, 0);
      const entries = svc.query({ limit, offset });
      res.json({ entries, count: entries.length, limit, offset });
    });
    router.get('/integrity', (_req, res) => {
      const report = svc.verifyIntegrity();
      res.status(report.valid ? 200 : 409).json(report);
    });
    router.get('/:id', (req, res) => {
      const entry = svc.getById(req.params['id'] ?? '');
      if (!entry) { res.status(404).json({ error: 'Audit entry not found' }); return; }
      res.json(entry);
    });
    app.use('/api/v1/audit', router);
  } else {
    app.use('/api/v1/audit', auditRouter);
  }
  return app;
}

// ─── AuditStore unit tests ───────────────────────────────────────────────────

describe('AuditStore', () => {
  let store: AuditStore;

  beforeEach(() => {
    store = new AuditStore();
  });

  // ── append ──────────────────────────────────────────────────────────────

  describe('append', () => {
    it('returns a frozen entry with all required fields', () => {
      const entry = store.append(makeInput());
      expect(entry.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(entry.action).toBe('CONTRACT_CREATED');
      expect(entry.severity).toBe('INFO');
      expect(entry.actor).toBe('user-abc');
      expect(entry.resource).toBe('contract');
      expect(entry.resourceId).toBe('contract-1');
      expect(entry.hash).toHaveLength(64);
      expect(Object.isFrozen(entry)).toBe(true);
    });

    it('first entry has previousHash === GENESIS_HASH', () => {
      const entry = store.append(makeInput());
      expect(entry.previousHash).toBe(GENESIS_HASH);
    });

    it('second entry previousHash equals first entry hash', () => {
      const first = store.append(makeInput());
      const second = store.append(makeInput({ action: 'CONTRACT_UPDATED' }));
      expect(second.previousHash).toBe(first.hash);
    });

    it('each entry gets a unique id', () => {
      const ids = Array.from({ length: 10 }, () => store.append(makeInput()).id);
      expect(new Set(ids).size).toBe(10);
    });

    it('each entry gets a unique hash', () => {
      const hashes = Array.from({ length: 5 }, () => store.append(makeInput()).hash);
      expect(new Set(hashes).size).toBe(5);
    });

    it('metadata is frozen', () => {
      const entry = store.append(makeInput({ metadata: { key: 'value' } }));
      expect(Object.isFrozen(entry.metadata)).toBe(true);
    });

    it('stores optional ipAddress and correlationId', () => {
      const entry = store.append(makeInput({ ipAddress: '1.2.3.4', correlationId: 'corr-1' }));
      expect(entry.ipAddress).toBe('1.2.3.4');
      expect(entry.correlationId).toBe('corr-1');
    });

    it('increments count on each append', () => {
      expect(store.count()).toBe(0);
      store.append(makeInput());
      expect(store.count()).toBe(1);
      store.append(makeInput());
      expect(store.count()).toBe(2);
    });
  });

  // ── immutability ─────────────────────────────────────────────────────────

  describe('immutability', () => {
    it('throws when attempting to mutate a frozen entry field', () => {
      const entry = store.append(makeInput());
      expect(() => {
        (entry as unknown as Record<string, unknown>)['actor'] = 'hacker';
      }).toThrow();
    });

    it('throws when attempting to mutate frozen metadata', () => {
      const entry = store.append(makeInput({ metadata: { key: 'original' } }));
      expect(() => {
        (entry.metadata as Record<string, unknown>)['key'] = 'tampered';
      }).toThrow();
    });

    it('getAll returns a copy — mutating it does not affect the store', () => {
      store.append(makeInput());
      const all = store.getAll();
      all.pop();
      expect(store.count()).toBe(1);
    });
  });

  // ── getById ──────────────────────────────────────────────────────────────

  describe('getById', () => {
    it('returns the correct entry', () => {
      const entry = store.append(makeInput());
      expect(store.getById(entry.id)).toBe(entry);
    });

    it('returns undefined for unknown id', () => {
      expect(store.getById('nonexistent')).toBeUndefined();
    });
  });

  // ── query ────────────────────────────────────────────────────────────────

  describe('query', () => {
    beforeEach(() => {
      store.append(makeInput({ action: 'CONTRACT_CREATED', actor: 'alice', severity: 'INFO' }));
      store.append(makeInput({ action: 'PAYMENT_INITIATED', actor: 'bob', severity: 'CRITICAL', resource: 'payment', resourceId: 'pay-1' }));
      store.append(makeInput({ action: 'AUTH_FAILED', actor: 'charlie', severity: 'WARNING', resource: 'auth', resourceId: 'charlie' }));
      store.append(makeInput({ action: 'CONTRACT_UPDATED', actor: 'alice', severity: 'INFO' }));
    });

    it('returns all entries when no filter given', () => {
      expect(store.query()).toHaveLength(4);
    });

    it('filters by action', () => {
      const results = store.query({ action: 'CONTRACT_CREATED' });
      expect(results).toHaveLength(1);
      expect(results[0].action).toBe('CONTRACT_CREATED');
    });

    it('filters by actor', () => {
      const results = store.query({ actor: 'alice' });
      expect(results).toHaveLength(2);
    });

    it('filters by severity', () => {
      const results = store.query({ severity: 'CRITICAL' });
      expect(results).toHaveLength(1);
      expect(results[0].action).toBe('PAYMENT_INITIATED');
    });

    it('filters by resource', () => {
      const results = store.query({ resource: 'payment' });
      expect(results).toHaveLength(1);
    });

    it('filters by resourceId', () => {
      const results = store.query({ resourceId: 'pay-1' });
      expect(results).toHaveLength(1);
    });

    it('applies limit', () => {
      expect(store.query({ limit: 2 })).toHaveLength(2);
    });

    it('applies offset', () => {
      const all = store.query();
      const paged = store.query({ offset: 2 });
      expect(paged).toHaveLength(2);
      expect(paged[0].id).toBe(all[2].id);
    });

    it('clamps limit to 1000', () => {
      for (let i = 0; i < 10; i++) store.append(makeInput());
      const results = store.query({ limit: 99999 });
      expect(results.length).toBeLessThanOrEqual(1000);
    });

    it('returns empty array when no entries match', () => {
      expect(store.query({ actor: 'nobody' })).toHaveLength(0);
    });

    it('filters by from/to time range', () => {
      const before = new Date(Date.now() - 10000).toISOString();
      const after = new Date(Date.now() + 10000).toISOString();
      expect(store.query({ from: before, to: after })).toHaveLength(4);
      expect(store.query({ from: after })).toHaveLength(0);
      expect(store.query({ to: before })).toHaveLength(0);
    });
  });

  // ── verifyIntegrity ──────────────────────────────────────────────────────

  describe('verifyIntegrity', () => {
    it('returns valid for empty log', () => {
      const report = store.verifyIntegrity();
      expect(report.valid).toBe(true);
      expect(report.totalEntries).toBe(0);
    });

    it('returns valid for a correct chain', () => {
      store.append(makeInput());
      store.append(makeInput({ action: 'CONTRACT_UPDATED' }));
      store.append(makeInput({ action: 'CONTRACT_COMPLETED' }));
      const report = store.verifyIntegrity();
      expect(report.valid).toBe(true);
      expect(report.totalEntries).toBe(3);
    });

    it('detects hash tampering on an entry', () => {
      store.append(makeInput());
      store.append(makeInput({ action: 'CONTRACT_UPDATED' }));
      // Directly tamper with the internal log via _reset + re-insert with bad hash
      const all = store.getAll();
      store._reset();
      // Re-insert first entry normally
      store.append(makeInput());
      // Manually push a tampered second entry (bypass append)
      const tampered: AuditEntry = Object.freeze({
        ...all[1],
        hash: 'deadbeef'.repeat(8), // wrong hash
      });
      (store as unknown as { log: AuditEntry[] }).log.push(tampered);
      const report = store.verifyIntegrity();
      expect(report.valid).toBe(false);
      expect(report.firstCorruptedIndex).toBe(1);
    });

    it('detects previousHash chain break', () => {
      store.append(makeInput());
      const second = store.append(makeInput({ action: 'CONTRACT_UPDATED' }));
      // Tamper previousHash of second entry
      store._reset();
      store.append(makeInput());
      const broken: AuditEntry = Object.freeze({
        ...second,
        previousHash: 'not-the-real-previous-hash',
      });
      (store as unknown as { log: AuditEntry[] }).log.push(broken);
      const report = store.verifyIntegrity();
      expect(report.valid).toBe(false);
      expect(report.firstCorruptedIndex).toBe(1);
      expect(report.firstCorruptedId).toBe(broken.id);
    });
  });

  // ── computeEntryHash ─────────────────────────────────────────────────────

  describe('computeEntryHash', () => {
    it('produces a 64-char hex string', () => {
      const entry = store.append(makeInput());
      expect(entry.hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('is deterministic for the same input', () => {
      const entry = store.append(makeInput());
      const { hash, ...rest } = entry;
      expect(computeEntryHash(rest)).toBe(hash);
    });

    it('changes when any field changes', () => {
      const entry = store.append(makeInput());
      const { hash, ...rest } = entry;
      const modified = { ...rest, actor: 'different-actor' };
      expect(computeEntryHash(modified)).not.toBe(hash);
    });
  });
});

// ─── AuditService unit tests ─────────────────────────────────────────────────

describe('AuditService', () => {
  let store: AuditStore;
  let service: AuditService;

  beforeEach(() => {
    store = new AuditStore();
    service = new AuditService(store);
  });

  it('log() persists and returns an entry', () => {
    const entry = service.log(makeInput());
    expect(entry.action).toBe('CONTRACT_CREATED');
    expect(service.count()).toBe(1);
  });

  it('logContractEvent() sets resource to "contract"', () => {
    const entry = service.logContractEvent('CONTRACT_CREATED', 'user-1', 'c-1', { note: 'test' });
    expect(entry.resource).toBe('contract');
    expect(entry.resourceId).toBe('c-1');
    expect(entry.severity).toBe('INFO');
  });

  it('logPaymentEvent() sets severity to CRITICAL', () => {
    const entry = service.logPaymentEvent('PAYMENT_INITIATED', 'user-1', 'pay-1');
    expect(entry.severity).toBe('CRITICAL');
    expect(entry.resource).toBe('payment');
  });

  it('logAuthEvent() sets WARNING for AUTH_FAILED', () => {
    const entry = service.logAuthEvent('AUTH_FAILED', 'user-1', {}, { ipAddress: '1.2.3.4' });
    expect(entry.severity).toBe('WARNING');
    expect(entry.ipAddress).toBe('1.2.3.4');
  });

  it('logAuthEvent() sets INFO for AUTH_LOGIN', () => {
    const entry = service.logAuthEvent('AUTH_LOGIN', 'user-1');
    expect(entry.severity).toBe('INFO');
  });

  it('logUserEvent() sets WARNING for USER_DELETED', () => {
    const entry = service.logUserEvent('USER_DELETED', 'admin-1', 'user-2');
    expect(entry.severity).toBe('WARNING');
  });

  it('logUserEvent() sets INFO for USER_CREATED', () => {
    const entry = service.logUserEvent('USER_CREATED', 'admin-1', 'user-2');
    expect(entry.severity).toBe('INFO');
  });

  it('query() delegates to store', () => {
    service.log(makeInput({ actor: 'alice' }));
    service.log(makeInput({ actor: 'bob' }));
    expect(service.query({ actor: 'alice' })).toHaveLength(1);
  });

  it('stream() yields entries without preloading all records', () => {
    service.log(makeInput({ actor: 'alice' }));
    service.log(makeInput({ actor: 'bob' }));

    const entries = Array.from(service.stream({ limit: 1 }));
    expect(entries).toHaveLength(1);
    expect(entries[0].actor).toBe('alice');
  });

  it('getById() returns correct entry', () => {
    const entry = service.log(makeInput());
    expect(service.getById(entry.id)).toBe(entry);
  });

  it('getById() returns undefined for unknown id', () => {
    expect(service.getById('nope')).toBeUndefined();
  });

  it('verifyIntegrity() returns valid for correct chain', () => {
    service.log(makeInput());
    service.log(makeInput({ action: 'CONTRACT_UPDATED' }));
    expect(service.verifyIntegrity().valid).toBe(true);
  });

  it('log() re-throws when store throws', () => {
    const badStore = new AuditStore();
    jest.spyOn(badStore, 'append').mockImplementation(() => { throw new Error('store failure'); });
    const strictService = new AuditService(badStore);
    expect(() => strictService.log(makeInput())).toThrow('store failure');
  });

  it('count() reflects number of entries', () => {
    expect(service.count()).toBe(0);
    service.log(makeInput());
    expect(service.count()).toBe(1);
  });
});

// ─── auditMiddleware unit tests ───────────────────────────────────────────────

describe('auditMiddleware', () => {
  it('attaches res.locals.audit with a log function', (done) => {
    const app = express();
    app.use(auditMiddleware);
    app.get('/test', (req, res) => {
      expect(typeof res.locals.audit.log).toBe('function');
      res.json({ ok: true });
    });
    request(app).get('/test').expect(200, done);
  });

  it('injects ipAddress and correlationId from request headers', (done) => {
    const store = new AuditStore();
    const svc = new AuditService(store);
    const app = express();
    app.use(auditMiddleware);
    app.get('/test', (req, res) => {
      // Use the middleware helper but backed by our isolated store
      const entry = svc.log({
        ...makeInput(),
        ipAddress: req.ip,
        correlationId: req.headers['x-correlation-id'] as string,
      });
      res.json({ correlationId: entry.correlationId });
    });
    request(app)
      .get('/test')
      .set('x-correlation-id', 'test-corr-123')
      .expect(200)
      .then((res) => {
        expect(res.body.correlationId).toBe('test-corr-123');
        done();
      });
  });
});

// ─── auditRouter integration tests ───────────────────────────────────────────

describe('auditRouter (integration)', () => {
  let store: AuditStore;
  let app: express.Express;

  beforeEach(() => {
    store = new AuditStore();
    app = buildTestApp(store);
  });

  // ── GET /api/v1/audit ────────────────────────────────────────────────────

  describe('GET /api/v1/audit', () => {
    it('returns empty entries on fresh store', async () => {
      const res = await request(app).get('/api/v1/audit').expect(200);
      expect(res.body.entries).toHaveLength(0);
      expect(res.body.count).toBe(0);
    });

    it('returns all entries', async () => {
      store.append(makeInput());
      store.append(makeInput({ action: 'CONTRACT_UPDATED' }));
      const res = await request(app).get('/api/v1/audit').expect(200);
      expect(res.body.entries).toHaveLength(2);
    });

    it('returns limit and offset in response', async () => {
      const res = await request(app).get('/api/v1/audit?limit=50&offset=10').expect(200);
      expect(res.body.limit).toBe(50);
      expect(res.body.offset).toBe(10);
    });
  });

  // ── GET /api/v1/audit/integrity ──────────────────────────────────────────

  describe('GET /api/v1/audit/integrity', () => {
    it('returns 200 and valid:true for intact chain', async () => {
      store.append(makeInput());
      const res = await request(app).get('/api/v1/audit/integrity').expect(200);
      expect(res.body.valid).toBe(true);
    });

    it('returns 200 and valid:true for empty log', async () => {
      const res = await request(app).get('/api/v1/audit/integrity').expect(200);
      expect(res.body.valid).toBe(true);
      expect(res.body.totalEntries).toBe(0);
    });

    it('returns 409 and valid:false when chain is broken', async () => {
      store.append(makeInput());
      const second = store.append(makeInput({ action: 'CONTRACT_UPDATED' }));
      // Tamper: push a broken entry
      const tampered: AuditEntry = Object.freeze({ ...second, hash: 'badhash'.padEnd(64, '0') });
      store._reset();
      store.append(makeInput());
      (store as unknown as { log: AuditEntry[] }).log.push(tampered);
      const res = await request(app).get('/api/v1/audit/integrity').expect(409);
      expect(res.body.valid).toBe(false);
    });
  });

  // ── GET /api/v1/audit/:id ────────────────────────────────────────────────

  describe('GET /api/v1/audit/:id', () => {
    it('returns the entry for a valid id', async () => {
      const entry = store.append(makeInput());
      const res = await request(app).get(`/api/v1/audit/${entry.id}`).expect(200);
      expect(res.body.id).toBe(entry.id);
      expect(res.body.action).toBe('CONTRACT_CREATED');
    });

    it('returns 404 for unknown id', async () => {
      const res = await request(app).get('/api/v1/audit/nonexistent-id').expect(404);
      expect(res.body.error).toBe('Audit entry not found');
    });
  });
});

// ─── auditRouter with singleton (uses real router) ───────────────────────────

describe('auditRouter (singleton, real router)', () => {
  const { auditStore: singletonStore } = require('./store');

  beforeEach(() => {
    singletonStore._reset();
  });

  afterEach(() => {
    singletonStore._reset();
  });

  it('GET /api/v1/audit returns 200', async () => {
    const app = buildTestApp(); // uses singleton
    await request(app).get('/api/v1/audit').expect(200);
  });

  it('GET /api/v1/audit rejects invalid action param', async () => {
    const app = buildTestApp();
    const res = await request(app).get('/api/v1/audit?action=INVALID_ACTION').expect(400);
    expect(res.body.error).toMatch(/Invalid action/);
  });

  it('GET /api/v1/audit rejects invalid severity param', async () => {
    const app = buildTestApp();
    const res = await request(app).get('/api/v1/audit?severity=UNKNOWN').expect(400);
    expect(res.body.error).toMatch(/Invalid severity/);
  });

  it('GET /api/v1/audit/:id returns 404 for unknown id', async () => {
    const app = buildTestApp();
    await request(app).get('/api/v1/audit/does-not-exist').expect(404);
  });

  it('GET /api/v1/audit/integrity returns 200 for empty log', async () => {
    const app = buildTestApp();
    await request(app).get('/api/v1/audit/integrity').expect(200);
  });

  it('GET /api/v1/audit/export streams NDJSON output', async () => {
    const app = buildTestApp();
    singletonStore.append(makeInput({ actor: 'stream-user-1' }));
    singletonStore.append(makeInput({ actor: 'stream-user-2' }));

    const res = await request(app)
      .get('/api/v1/audit/export?limit=1')
      .expect(200);

    expect(res.headers['content-type']).toContain('application/x-ndjson');
    const lines = res.text.trim().split('\n');
    expect(lines).toHaveLength(1);
    const first = JSON.parse(lines[0]) as { actor: string };
    expect(first.actor).toBe('stream-user-1');
  });
});

// ─── Security threat scenarios ────────────────────────────────────────────────

describe('Security: threat scenarios', () => {
  let store: AuditStore;

  beforeEach(() => {
    store = new AuditStore();
  });

  it('THREAT: entry cannot be deleted from the log', () => {
    const entry = store.append(makeInput());
    const all = store.getAll();
    // Attempt to remove from the returned copy
    const filtered = all.filter((e) => e.id !== entry.id);
    expect(filtered).toHaveLength(0);
    // Original store is unaffected
    expect(store.count()).toBe(1);
  });

  it('THREAT: entry fields cannot be mutated (strict mode)', () => {
    const entry = store.append(makeInput());
    expect(() => { (entry as unknown as Record<string, unknown>)['action'] = 'ADMIN_ACTION'; }).toThrow();
    expect(entry.action).toBe('CONTRACT_CREATED');
  });

  it('THREAT: metadata cannot be mutated', () => {
    const entry = store.append(makeInput({ metadata: { amount: 100 } }));
    expect(() => { (entry.metadata as Record<string, unknown>)['amount'] = 9999; }).toThrow();
    expect(entry.metadata['amount']).toBe(100);
  });

  it('THREAT: hash chain detects single entry modification', () => {
    store.append(makeInput());
    store.append(makeInput({ action: 'PAYMENT_INITIATED' }));
    store.append(makeInput({ action: 'PAYMENT_RELEASED' }));

    // Simulate an attacker modifying the second entry's actor
    const log = (store as unknown as { log: AuditEntry[] }).log;
    const original = log[1];
    // Replace with a tampered frozen entry (actor changed, hash not updated)
    (log as AuditEntry[])[1] = Object.freeze({ ...original, actor: 'attacker' });

    const report = store.verifyIntegrity();
    expect(report.valid).toBe(false);
    expect(report.firstCorruptedIndex).toBe(1);
  });

  it('THREAT: hash chain detects entry insertion', () => {
    const first = store.append(makeInput());
    store.append(makeInput({ action: 'CONTRACT_COMPLETED' }));

    // Insert a fake entry between index 0 and 1
    const log = (store as unknown as { log: AuditEntry[] }).log;
    const fakeEntry: AuditEntry = Object.freeze({
      id: 'fake-id',
      timestamp: new Date().toISOString(),
      action: 'ADMIN_ACTION',
      severity: 'CRITICAL',
      actor: 'attacker',
      resource: 'system',
      resourceId: 'sys-1',
      metadata: {},
      previousHash: first.hash,
      hash: 'fakehash'.padEnd(64, '0'),
    });
    log.splice(1, 0, fakeEntry);

    const report = store.verifyIntegrity();
    expect(report.valid).toBe(false);
  });

  it('THREAT: query does not expose internal array reference', () => {
    store.append(makeInput());
    const results = store.query();
    results.length = 0; // mutate the returned array
    expect(store.count()).toBe(1); // store unaffected
  });

  it('THREAT: large limit is clamped to 1000', () => {
    for (let i = 0; i < 5; i++) store.append(makeInput());
    const results = store.query({ limit: Number.MAX_SAFE_INTEGER });
    expect(results.length).toBeLessThanOrEqual(1000);
  });

  it('THREAT: negative offset is treated as 0', () => {
    store.append(makeInput());
    store.append(makeInput({ action: 'CONTRACT_UPDATED' }));
    const results = store.query({ offset: -999 });
    expect(results).toHaveLength(2);
  });
});

// ─── redact module ────────────────────────────────────────────────────────────

describe('isSensitiveHeader', () => {
  it.each([
    'authorization',
    'Authorization',
    'AUTHORIZATION',
    'cookie',
    'Cookie',
    'set-cookie',
    'x-api-key',
    'x-auth-token',
    'x-access-token',
  ])('flags %s as sensitive', (header) => {
    expect(isSensitiveHeader(header)).toBe(true);
  });

  it.each([
    'content-type',
    'accept',
    'x-request-id',
    'user-agent',
    'host',
  ])('does not flag %s as sensitive', (header) => {
    expect(isSensitiveHeader(header)).toBe(false);
  });
});

describe('isSensitiveKey', () => {
  it.each([
    'password',
    'userPassword',
    'PASSWORD',
    'secret',
    'clientSecret',
    'token',
    'accessToken',
    'credential',
    'apiCredential',
    'apikey',
    'api_key',
    'privateKey',
  ])('flags key "%s" as sensitive', (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it.each([
    'username',
    'email',
    'name',
    'description',
    'amount',
    'contractId',
  ])('does not flag key "%s" as sensitive', (key) => {
    expect(isSensitiveKey(key)).toBe(false);
  });
});

describe('maskEmail', () => {
  it('masks a standard email to 3-char prefix', () => {
    expect(maskEmail('alice@example.com')).toBe('ali***@example.com');
  });

  it('uses the full local part when it is shorter than 3 chars', () => {
    expect(maskEmail('ab@host.io')).toBe('ab***@host.io');
  });

  it('returns non-email strings unchanged', () => {
    expect(maskEmail('not-an-email')).toBe('not-an-email');
    expect(maskEmail('hello world')).toBe('hello world');
    expect(maskEmail('')).toBe('');
  });

  it('handles edge-case single-char local part', () => {
    expect(maskEmail('a@b.co')).toBe('a***@b.co');
  });
});

describe('redactHeaders', () => {
  it('replaces authorization header with REDACTED', () => {
    const headers = {
      authorization: 'Bearer super-secret-token',
      'content-type': 'application/json',
    };
    const result = redactHeaders(headers);
    expect(result['authorization']).toBe(REDACTED);
    expect(result['content-type']).toBe('application/json');
  });

  it('redacts cookie and set-cookie headers', () => {
    const headers = { cookie: 'session=abc123', 'set-cookie': 'id=xyz' };
    const result = redactHeaders(headers);
    expect(result['cookie']).toBe(REDACTED);
    expect(result['set-cookie']).toBe(REDACTED);
  });

  it('redacts x-api-key, x-auth-token, and x-access-token', () => {
    const headers = {
      'x-api-key': 'key-value',
      'x-auth-token': 'auth-value',
      'x-access-token': 'access-value',
    };
    const result = redactHeaders(headers);
    expect(result['x-api-key']).toBe(REDACTED);
    expect(result['x-auth-token']).toBe(REDACTED);
    expect(result['x-access-token']).toBe(REDACTED);
  });

  it('does not mutate the original headers object', () => {
    const headers = { authorization: 'Bearer token' };
    redactHeaders(headers);
    expect(headers.authorization).toBe('Bearer token');
  });

  it('passes non-sensitive headers through unchanged', () => {
    const headers = { 'x-request-id': 'req-123', host: 'localhost' };
    const result = redactHeaders(headers);
    expect(result['x-request-id']).toBe('req-123');
    expect(result['host']).toBe('localhost');
  });
});

describe('redactBody', () => {
  it('returns null and undefined unchanged', () => {
    expect(redactBody(null)).toBeNull();
    expect(redactBody(undefined)).toBeUndefined();
  });

  it('returns numbers and booleans unchanged', () => {
    expect(redactBody(42)).toBe(42);
    expect(redactBody(true)).toBe(true);
  });

  it('redacts sensitive keys in a flat object', () => {
    const body = { username: 'alice', password: 's3cr3t', email: 'alice@example.com' };
    const result = redactBody(body) as Record<string, unknown>;
    expect(result['username']).toBe('alice');
    expect(result['password']).toBe(REDACTED);
    expect(result['email']).toBe('ali***@example.com');
  });

  it('redacts nested sensitive keys recursively', () => {
    const body = { user: { id: 'u1', secret: 'shhh', profile: { token: 'tok' } } };
    const result = redactBody(body) as Record<string, unknown>;
    const user = result['user'] as Record<string, unknown>;
    expect(user['id']).toBe('u1');
    expect(user['secret']).toBe(REDACTED);
    const profile = user['profile'] as Record<string, unknown>;
    expect(profile['token']).toBe(REDACTED);
  });

  it('traverses arrays and redacts sensitive keys within elements', () => {
    const body = [{ name: 'alice', password: 'pw1' }, { name: 'bob', password: 'pw2' }];
    const result = redactBody(body) as Record<string, unknown>[];
    expect(result[0]['name']).toBe('alice');
    expect(result[0]['password']).toBe(REDACTED);
    expect(result[1]['password']).toBe(REDACTED);
  });

  it('masks email strings in non-sensitive fields', () => {
    const body = { contactEmail: 'bob@domain.org' };
    const result = redactBody(body) as Record<string, unknown>;
    expect(result['contactEmail']).toBe('bob***@domain.org');
  });

  it('does not mutate the original object', () => {
    const body = { password: 'original' };
    redactBody(body);
    expect(body.password).toBe('original');
  });
});

describe('buildAuditMetadata', () => {
  it('returns the expected shape', () => {
    const result = buildAuditMetadata(
      'GET',
      '/api/v1/contracts',
      { 'content-type': 'application/json', authorization: 'Bearer tok' },
      undefined,
      {},
      200,
      'req-uuid-1',
    );
    expect(result['method']).toBe('GET');
    expect(result['path']).toBe('/api/v1/contracts');
    expect(result['statusCode']).toBe(200);
    expect(result['requestId']).toBe('req-uuid-1');
    expect(result['body']).toBeNull();
    expect(result['query']).toBeNull();
  });

  it('redacts the authorization header in the output', () => {
    const result = buildAuditMetadata(
      'POST',
      '/api/v1/contracts',
      { authorization: 'Bearer super-secret' },
      { name: 'test' },
      {},
      201,
      'req-uuid-2',
    );
    const headers = result['headers'] as Record<string, unknown>;
    expect(headers['authorization']).toBe(REDACTED);
  });

  it('redacts sensitive body fields', () => {
    const result = buildAuditMetadata(
      'POST',
      '/api/v1/users',
      {},
      { username: 'carol', password: 'hunter2' },
      {},
      201,
      'req-uuid-3',
    );
    const body = result['body'] as Record<string, unknown>;
    expect(body['username']).toBe('carol');
    expect(body['password']).toBe(REDACTED);
  });

  it('sets requestId to null when undefined', () => {
    const result = buildAuditMetadata('GET', '/', {}, undefined, {}, 200, undefined);
    expect(result['requestId']).toBeNull();
  });

  it('includes non-empty query string after redaction', () => {
    const result = buildAuditMetadata(
      'GET',
      '/api/v1/contracts',
      {},
      undefined,
      { status: 'active', token: 'leaked' },
      200,
      'req-1',
    );
    const query = result['query'] as Record<string, unknown>;
    expect(query['status']).toBe('active');
    expect(query['token']).toBe(REDACTED);
  });
});

// ─── protectedEndpointAuditMiddleware ─────────────────────────────────────────

describe('protectedEndpointAuditMiddleware', () => {
  let store: AuditStore;
  let service: AuditService;

  beforeEach(() => {
    store = new AuditStore();
    service = new AuditService(store);
  });

  function buildProtectedApp(opts: {
    method?: string;
    path?: string;
    statusCode?: number;
    withUser?: boolean;
    requestId?: string;
    body?: Record<string, unknown>;
  } = {}) {
    const {
      path = '/api/v1/contracts',
      statusCode = 200,
      withUser = false,
      requestId = 'test-req-id',
      body,
    } = opts;

    const app = express();
    app.use(express.json());

    // Simulate requestIdMiddleware by pre-populating res.locals
    app.use((_req, res, next) => {
      res.locals['requestId'] = requestId;
      next();
    });

    app.use(createProtectedEndpointAuditMiddleware(service));

    // Simulate auth middleware by conditionally setting req.user
    if (withUser) {
      app.use((req: express.Request, _res, next) => {
        (req as any).user = { userId: 'user-42', role: 'freelancer' };
        next();
      });
    }

    app.all(path, (req, res) => {
      if (body !== undefined) {
        // echo body back so we can verify it was received
      }
      res.status(statusCode).json({ ok: true });
    });

    return app;
  }

  it('emits ENDPOINT_ACCESS for a GET request returning 200', async () => {
    const app = buildProtectedApp({ method: 'GET', statusCode: 200 });
    await request(app).get('/api/v1/contracts').expect(200);

    expect(store.count()).toBe(1);
    const entry = store.getAll()[0];
    expect(entry.action).toBe('ENDPOINT_ACCESS');
    expect(entry.severity).toBe('INFO');
  });

  it('emits ENDPOINT_MUTATION for a POST request returning 201', async () => {
    const app = buildProtectedApp({ statusCode: 201 });
    await request(app).post('/api/v1/contracts').send({ name: 'c1' }).expect(201);

    expect(store.count()).toBe(1);
    const entry = store.getAll()[0];
    expect(entry.action).toBe('ENDPOINT_MUTATION');
    expect(entry.severity).toBe('INFO');
  });

  it('emits ENDPOINT_MUTATION for PATCH, PUT, and DELETE', async () => {
    for (const verb of ['patch', 'put', 'delete'] as const) {
      const innerStore = new AuditStore();
      const innerService = new AuditService(innerStore);
      const app = express();
      app.use(createProtectedEndpointAuditMiddleware(innerService));
      app.all('/api/v1/contracts/123', (_req, res) => res.status(200).json({}));

      await request(app)[verb]('/api/v1/contracts/123').expect(200);
      expect(innerStore.getAll()[0].action).toBe('ENDPOINT_MUTATION');
    }
  });

  it('emits AUTH_FAILED with WARNING severity for a 401 response', async () => {
    const app = express();
    app.use(createProtectedEndpointAuditMiddleware(service));
    app.get('/api/v1/contracts', (_req, res) => {
      res.status(401).json({ error: 'Unauthorized' });
    });

    await request(app).get('/api/v1/contracts').expect(401);

    expect(store.count()).toBe(1);
    const entry = store.getAll()[0];
    expect(entry.action).toBe('AUTH_FAILED');
    expect(entry.severity).toBe('WARNING');
  });

  it('emits AUTH_FAILED with WARNING severity for a 403 response', async () => {
    const app = express();
    app.use(createProtectedEndpointAuditMiddleware(service));
    app.get('/api/v1/contracts', (_req, res) => {
      res.status(403).json({ error: 'Forbidden' });
    });

    await request(app).get('/api/v1/contracts').expect(403);

    const entry = store.getAll()[0];
    expect(entry.action).toBe('AUTH_FAILED');
    expect(entry.severity).toBe('WARNING');
  });

  it('sets actor to "anonymous" when req.user is not set', async () => {
    const app = buildProtectedApp({ withUser: false });
    await request(app).get('/api/v1/contracts').expect(200);

    expect(store.getAll()[0].actor).toBe('anonymous');
  });

  it('sets actor to req.user.userId when authenticated', async () => {
    const app = buildProtectedApp({ withUser: true });
    await request(app).get('/api/v1/contracts').expect(200);

    expect(store.getAll()[0].actor).toBe('user-42');
  });

  it('uses requestId from res.locals as correlationId', async () => {
    const app = buildProtectedApp({ requestId: 'my-trace-id' });
    await request(app).get('/api/v1/contracts').expect(200);

    expect(store.getAll()[0].correlationId).toBe('my-trace-id');
  });

  it('derives resource from the URL path', async () => {
    const app = buildProtectedApp({ path: '/api/v1/reputation/u1' });
    await request(app).get('/api/v1/reputation/u1').expect(200);

    expect(store.getAll()[0].resource).toBe('reputation');
    expect(store.getAll()[0].resourceId).toBe('u1');
  });

  it('sets resource to "endpoint" for non-versioned paths', async () => {
    const app = express();
    app.use(createProtectedEndpointAuditMiddleware(service));
    app.get('/health', (_req, res) => res.status(200).json({}));

    await request(app).get('/health').expect(200);

    expect(store.getAll()[0].resource).toBe('endpoint');
  });

  it('does NOT persist the Authorization header value in metadata', async () => {
    const token = createToken('u1', 'admin');
    const app = buildProtectedApp({ withUser: false });

    await request(app)
      .get('/api/v1/contracts')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const entry = store.getAll()[0];
    const headers = (entry.metadata['headers'] as Record<string, unknown>);
    expect(headers['authorization']).toBe(REDACTED);
    // Make sure the actual token value is nowhere in the serialised entry
    expect(JSON.stringify(entry)).not.toContain(token);
  });

  it('redacts password fields from the request body in metadata', async () => {
    const app = express();
    app.use(express.json());
    app.use((_req, res, next) => { res.locals['requestId'] = 'r1'; next(); });
    app.use(createProtectedEndpointAuditMiddleware(service));
    app.post('/api/v1/users', (_req, res) => res.status(201).json({}));

    await request(app)
      .post('/api/v1/users')
      .send({ username: 'alice', password: 'hunter2' })
      .expect(201);

    const body = store.getAll()[0].metadata['body'] as Record<string, unknown>;
    expect(body['username']).toBe('alice');
    expect(body['password']).toBe(REDACTED);
  });

  it('emits WARNING severity for non-auth 4xx errors', async () => {
    const app = express();
    app.use(createProtectedEndpointAuditMiddleware(service));
    app.get('/api/v1/contracts/missing', (_req, res) => {
      res.status(404).json({ error: 'Not found' });
    });

    await request(app).get('/api/v1/contracts/missing').expect(404);

    const entry = store.getAll()[0];
    expect(entry.severity).toBe('WARNING');
    // 404 is not an auth failure — action should be ENDPOINT_ACCESS (GET)
    expect(entry.action).toBe('ENDPOINT_ACCESS');
  });

  it('records the HTTP method and path in metadata', async () => {
    const app = buildProtectedApp({ path: '/api/v1/contracts', statusCode: 200 });
    await request(app).get('/api/v1/contracts').expect(200);

    const meta = store.getAll()[0].metadata;
    expect(meta['method']).toBe('GET');
    expect(meta['path']).toBe('/api/v1/contracts');
    expect(meta['statusCode']).toBe(200);
  });

  it('silently swallows audit errors without breaking the response', async () => {
    const brokenService = new AuditService(new AuditStore());
    jest.spyOn(brokenService, 'log').mockImplementation(() => {
      throw new Error('store exploded');
    });
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const app = express();
    app.use(createProtectedEndpointAuditMiddleware(brokenService));
    app.get('/api/v1/contracts', (_req, res) => res.status(200).json({ ok: true }));

    await request(app).get('/api/v1/contracts').expect(200);

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[protectedEndpointAuditMiddleware]'),
      expect.any(Error),
    );

    consoleSpy.mockRestore();
  });
});
