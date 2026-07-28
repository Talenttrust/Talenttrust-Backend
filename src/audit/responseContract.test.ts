/**
 * @file responseContract.test.ts
 * @description Contract tests that lock down every audit HTTP response shape.
 *
 * Each test asserts:
 *  - The exact set of top-level keys (no extra, no missing).
 *  - The correct TypeScript types for every value.
 *  - Edge cases around optional fields and error payloads.
 *
 * These tests guard against accidental schema drift — if a field is added,
 * renamed, removed, or its type changes, the tests will fail.
 */

import express from 'express';
import request from 'supertest';
import { AuditStore } from './store';
import { AuditService } from './service';
import { AuditExportService } from './exportService';
import { createAuditRouter } from './router';
import { encodeCursor } from './types';
import type { AuditAction, AuditSeverity, AuditEntry } from './types';

// ─── Helpers ────────────────────────────────────────────────────────────────

const VALID_ACTIONS: readonly AuditAction[] = [
  'CONTRACT_CREATED', 'CONTRACT_UPDATED', 'CONTRACT_CANCELLED', 'CONTRACT_COMPLETED',
  'PAYMENT_INITIATED', 'PAYMENT_RELEASED', 'PAYMENT_DISPUTED',
  'REPUTATION_UPDATED',
  'USER_CREATED', 'USER_UPDATED', 'USER_DELETED',
  'AUTH_LOGIN', 'AUTH_LOGOUT', 'AUTH_FAILED',
  'ADMIN_ACTION',
  'ENDPOINT_ACCESS', 'ENDPOINT_MUTATION',
  'DEPLOYMENT_PROMOTED', 'DEPLOYMENT_ROLLED_BACK',
];

const VALID_SEVERITIES: readonly AuditSeverity[] = ['INFO', 'WARNING', 'CRITICAL'];

/** Required keys on every AuditEntry (JSON-serialised). */
const AUDIT_ENTRY_REQUIRED_KEYS = [
  'id', 'timestamp', 'action', 'severity',
  'actor', 'resource', 'resourceId', 'metadata',
  'hash', 'previousHash',
] as const;

/** All possible keys including optional fields. */
const AUDIT_ENTRY_ALL_KEYS = [
  ...AUDIT_ENTRY_REQUIRED_KEYS,
  'ipAddress', 'correlationId',
] as const;

function assertExactKeys(obj: Record<string, unknown>, expected: readonly string[]) {
  const actual = Object.keys(obj).sort();
  const expectedSorted = [...expected].sort();
  expect(actual).toEqual(expectedSorted);
}

function assertAuditEntryRequiredKeysPresent(entry: Record<string, unknown>) {
  // All required keys must be present
  for (const key of AUDIT_ENTRY_REQUIRED_KEYS) {
    expect(entry).toHaveProperty(key);
  }
  // No keys beyond the allowed set
  const allowed = new Set<string>(AUDIT_ENTRY_ALL_KEYS as unknown as string[]);
  for (const key of Object.keys(entry)) {
    expect(allowed.has(key)).toBe(true);
  }
}

function assertAuditEntryTypes(entry: Record<string, unknown>) {
  expect(typeof entry['id']).toBe('string');
  expect(entry['id']).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  expect(typeof entry['timestamp']).toBe('string');
  expect(new Date(entry['timestamp'] as string).toISOString()).toBe(entry['timestamp']);
  expect(VALID_ACTIONS).toContain(entry['action']);
  expect(VALID_SEVERITIES).toContain(entry['severity']);
  expect(typeof entry['actor']).toBe('string');
  expect(typeof entry['resource']).toBe('string');
  expect(typeof entry['resourceId']).toBe('string');
  expect(typeof entry['metadata']).toBe('object');
  expect(entry['metadata']).not.toBeNull();
  expect(typeof entry['hash']).toBe('string');
  expect((entry['hash'] as string)).toHaveLength(64);
  expect(/^[0-9a-f]{64}$/.test(entry['hash'] as string)).toBe(true);
  expect(typeof entry['previousHash']).toBe('string');
}

function assertAuditEntryShape(entry: Record<string, unknown>) {
  assertAuditEntryRequiredKeysPresent(entry);
  assertAuditEntryTypes(entry);

  if (entry['ipAddress'] !== undefined) {
    expect(typeof entry['ipAddress']).toBe('string');
  }
  if (entry['correlationId'] !== undefined) {
    expect(typeof entry['correlationId']).toBe('string');
  }
}

function assertAuditEntryExactKeys(entry: Record<string, unknown>, includeOptional: boolean) {
  if (includeOptional) {
    // All required + all optional keys (the full AuditEntry shape)
    assertExactKeys(entry, [...AUDIT_ENTRY_ALL_KEYS]);
  } else {
    // All required keys, no optional keys
    assertExactKeys(entry, [...AUDIT_ENTRY_REQUIRED_KEYS]);
  }
}

/** Assert that no keys beyond the allowed set are present. */
function assertNoUnexpectedKeys(entry: Record<string, unknown>) {
  const allowed = new Set<string>(AUDIT_ENTRY_ALL_KEYS as unknown as string[]);
  for (const key of Object.keys(entry)) {
    expect(allowed.has(key)).toBe(true);
  }
}

function assertIntegrityReportShape(report: Record<string, unknown>) {
  expect(typeof report['valid']).toBe('boolean');
  expect(typeof report['totalEntries']).toBe('number');
  expect(Number.isInteger(report['totalEntries'])).toBe(true);
  expect(typeof report['checkedAt']).toBe('string');
  expect(new Date(report['checkedAt'] as string).toISOString()).toBe(report['checkedAt']);

  if (report['firstCorruptedIndex'] !== undefined) {
    expect(typeof report['firstCorruptedIndex']).toBe('number');
    expect(Number.isInteger(report['firstCorruptedIndex'])).toBe(true);
  }
  if (report['firstCorruptedId'] !== undefined) {
    expect(typeof report['firstCorruptedId']).toBe('string');
  }
}

function buildApp() {
  const store = new AuditStore();
  const service = new AuditService(store);
  const exportService = new AuditExportService(service);
  const app = express();
  app.use(express.json());
  app.use('/api/v1/audit', createAuditRouter({ service, exportService }));
  return { app, store, service };
}

// ─── GET / (offset-based) response contract ─────────────────────────────────

describe('Contract: GET /api/v1/audit (offset-based)', () => {
  it('returns exactly { entries, count, limit, offset } when no entries exist', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/v1/audit').expect(200);

    assertExactKeys(res.body, ['entries', 'count', 'limit', 'offset']);
    expect(Array.isArray(res.body.entries)).toBe(true);
    expect(typeof res.body.count).toBe('number');
    expect(typeof res.body.limit).toBe('number');
    expect(typeof res.body.offset).toBe('number');
    expect(res.body.entries).toHaveLength(0);
    expect(res.body.count).toBe(0);
  });

  it('returns exactly { entries, count, limit, offset } with entries', async () => {
    const { app, store } = buildApp();
    store.append({
      action: 'CONTRACT_CREATED',
      severity: 'INFO',
      actor: 'user-1',
      resource: 'contract',
      resourceId: 'c-1',
      metadata: {},
    });

    const res = await request(app).get('/api/v1/audit').expect(200);

    assertExactKeys(res.body, ['entries', 'count', 'limit', 'offset']);
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.count).toBe(1);
    assertAuditEntryShape(res.body.entries[0]);
    assertAuditEntryExactKeys(res.body.entries[0], false);
  });

  it('echoes back an explicit limit and offset', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/v1/audit?limit=10&offset=5').expect(200);
    expect(res.body.limit).toBe(10);
    expect(res.body.offset).toBe(5);
  });

  it('clamps excessive limit to the max (100)', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/v1/audit?limit=9999').expect(200);
    expect(res.body.limit).toBe(100);
  });
});

// ─── GET / (cursor-based) response contract ─────────────────────────────────

describe('Contract: GET /api/v1/audit (cursor-based)', () => {
  it('returns { entries, count, limit } without nextCursor when all remaining entries fit', async () => {
    const { app, store } = buildApp();
    const first = store.append({
      action: 'CONTRACT_CREATED',
      severity: 'INFO',
      actor: 'user-1',
      resource: 'contract',
      resourceId: 'c-1',
      metadata: {},
    });
    store.append({
      action: 'CONTRACT_UPDATED',
      severity: 'INFO',
      actor: 'user-2',
      resource: 'contract',
      resourceId: 'c-2',
      metadata: {},
    });
    store.append({
      action: 'CONTRACT_COMPLETED',
      severity: 'INFO',
      actor: 'user-3',
      resource: 'contract',
      resourceId: 'c-3',
      metadata: {},
    });

    // Cursor points to the first entry — remaining entries (2) fit within limit=10
    const cursor = encodeCursor({
      lastId: first.id,
      lastTimestamp: first.timestamp,
      filters: {},
    });

    const res = await request(app)
      .get(`/api/v1/audit?limit=10&cursor=${encodeURIComponent(cursor)}`)
      .expect(200);

    assertExactKeys(res.body, ['entries', 'count', 'limit']);
    expect(res.body.entries).toHaveLength(2);
    expect(res.body.count).toBe(2);
    expect(typeof res.body.limit).toBe('number');
    expect(res.body.nextCursor).toBeUndefined();
  });

  it('includes nextCursor when more pages exist', async () => {
    const { app, store } = buildApp();
    const entries: AuditEntry[] = [];
    for (let i = 0; i < 5; i++) {
      entries.push(store.append({
        action: 'CONTRACT_CREATED',
        severity: 'INFO',
        actor: `user-${i}`,
        resource: 'contract',
        resourceId: `c-${i}`,
        metadata: {},
      }));
    }

    // Cursor pointing to the first entry, requesting limit=2 → should paginate
    const cursor = encodeCursor({
      lastId: entries[0].id,
      lastTimestamp: entries[0].timestamp,
      filters: {},
    });

    const res = await request(app)
      .get(`/api/v1/audit?limit=2&cursor=${encodeURIComponent(cursor)}`)
      .expect(200);

    assertExactKeys(res.body, ['entries', 'count', 'limit', 'nextCursor']);
    expect(res.body.entries).toHaveLength(2);
    expect(typeof res.body.nextCursor).toBe('string');
    expect(res.body.nextCursor).toBeTruthy();
  });

  it('each entry in the cursor response matches AuditEntry shape', async () => {
    const { app, store } = buildApp();
    const first = store.append({
      action: 'PAYMENT_INITIATED',
      severity: 'CRITICAL',
      actor: 'pay-service',
      resource: 'payment',
      resourceId: 'pay-1',
      metadata: { amount: 100 },
      ipAddress: '10.0.0.1',
      correlationId: 'corr-1',
    });
    store.append({
      action: 'PAYMENT_RELEASED',
      severity: 'CRITICAL',
      actor: 'pay-service',
      resource: 'payment',
      resourceId: 'pay-2',
      metadata: {},
      ipAddress: '10.0.0.2',
    });

    const cursor = encodeCursor({
      lastId: first.id,
      lastTimestamp: first.timestamp,
      filters: {},
    });

    const res = await request(app)
      .get(`/api/v1/audit?limit=10&cursor=${encodeURIComponent(cursor)}`)
      .expect(200);

    expect(res.body.entries.length).toBeGreaterThan(0);
    assertAuditEntryShape(res.body.entries[0]);
    assertNoUnexpectedKeys(res.body.entries[0]);
  });
});

// ─── GET /:id response contract ─────────────────────────────────────────────

describe('Contract: GET /api/v1/audit/:id', () => {
  it('returns a single AuditEntry with exact shape (including optional fields)', async () => {
    const { app, store } = buildApp();
    const entry = store.append({
      action: 'CONTRACT_UPDATED',
      severity: 'INFO',
      actor: 'user-2',
      resource: 'contract',
      resourceId: 'c-2',
      metadata: { field: 'name' },
      ipAddress: '192.168.1.1',
      correlationId: 'trace-abc',
    });

    const res = await request(app).get(`/api/v1/audit/${entry.id}`).expect(200);
    assertAuditEntryShape(res.body);
    assertAuditEntryExactKeys(res.body, true);
    expect(res.body.id).toBe(entry.id);
    expect(res.body.action).toBe('CONTRACT_UPDATED');
    expect(res.body.ipAddress).toBe('192.168.1.1');
    expect(res.body.correlationId).toBe('trace-abc');
  });

  it('omits ipAddress and correlationId when not provided', async () => {
    const { app, store } = buildApp();
    const entry = store.append({
      action: 'USER_CREATED',
      severity: 'INFO',
      actor: 'admin',
      resource: 'user',
      resourceId: 'u-1',
      metadata: {},
    });

    const res = await request(app).get(`/api/v1/audit/${entry.id}`).expect(200);
    assertAuditEntryShape(res.body);
    assertAuditEntryExactKeys(res.body, false);
    expect(res.body.ipAddress).toBeUndefined();
    expect(res.body.correlationId).toBeUndefined();
  });

  it('returns exactly { error } for a non-existent id', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .get('/api/v1/audit/00000000-0000-0000-0000-000000000000')
      .expect(404);

    assertExactKeys(res.body, ['error']);
    expect(typeof res.body.error).toBe('string');
    expect(res.body.error).toBe('Audit entry not found');
    expect(res.body).toMatchInlineSnapshot(`
      {
        "error": "Audit entry not found",
      }
    `);
  });
});

// ─── GET /integrity response contract ───────────────────────────────────────

describe('Contract: GET /api/v1/audit/integrity', () => {
  it('returns a valid IntegrityReport shape when chain is intact (empty log)', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/v1/audit/integrity').expect(200);

    assertIntegrityReportShape(res.body);
    expect(res.body.valid).toBe(true);
    expect(res.body.totalEntries).toBe(0);
    expect(res.body.firstCorruptedIndex).toBeUndefined();
    expect(res.body.firstCorruptedId).toBeUndefined();
  });

  it('returns a valid IntegrityReport shape with entries', async () => {
    const { app, store } = buildApp();
    store.append({
      action: 'CONTRACT_CREATED',
      severity: 'INFO',
      actor: 'u1',
      resource: 'contract',
      resourceId: 'c1',
      metadata: {},
    });

    const res = await request(app).get('/api/v1/audit/integrity').expect(200);

    assertIntegrityReportShape(res.body);
    expect(res.body.valid).toBe(true);
    expect(res.body.totalEntries).toBe(1);
  });

  it('returns 409 with corruption details when chain is broken', async () => {
    const { app, store } = buildApp();
    store.append({
      action: 'CONTRACT_CREATED',
      severity: 'INFO',
      actor: 'u1',
      resource: 'contract',
      resourceId: 'c1',
      metadata: {},
    });
    store.append({
      action: 'CONTRACT_UPDATED',
      severity: 'INFO',
      actor: 'u1',
      resource: 'contract',
      resourceId: 'c1',
      metadata: {},
    });

    // Tamper: replace the second entry's hash
    const all = store.getAll();
    store._reset();
    store.append({
      action: 'CONTRACT_CREATED',
      severity: 'INFO',
      actor: 'u1',
      resource: 'contract',
      resourceId: 'c1',
      metadata: {},
    });
    const tampered: AuditEntry = Object.freeze({
      ...all[1],
      hash: 'badhash'.padEnd(64, '0'),
    });
    (store as unknown as { log: AuditEntry[] }).log.push(tampered);

    const res = await request(app).get('/api/v1/audit/integrity').expect(409);

    assertIntegrityReportShape(res.body);
    expect(res.body.valid).toBe(false);
    expect(typeof res.body.firstCorruptedIndex).toBe('number');
    expect(typeof res.body.firstCorruptedId).toBe('string');
    
    // We snapshot the predictable parts of the response (omitting the random ID)
    expect({
      ...res.body,
      firstCorruptedId: 'UUID_MOCKED_FOR_SNAPSHOT'
    }).toMatchInlineSnapshot(`
      {
        "firstCorruptedId": "UUID_MOCKED_FOR_SNAPSHOT",
        "firstCorruptedIndex": 1,
        "totalEntries": 2,
        "valid": false,
      }
    `);
  });
});

// ─── POST / response contract ───────────────────────────────────────────────

describe('Contract: POST /api/v1/audit', () => {
  it('returns 201 with a full AuditEntry shape', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/v1/audit')
      .send({
        action: 'PAYMENT_INITIATED',
        severity: 'CRITICAL',
        actor: 'pay-service',
        resource: 'payment',
        resourceId: 'pay-100',
        metadata: { amount: 500 },
      })
      .expect(201);

    assertAuditEntryShape(res.body);
    assertAuditEntryExactKeys(res.body, false);
    expect(res.body.action).toBe('PAYMENT_INITIATED');
    expect(res.body.severity).toBe('CRITICAL');
  });

  it('returns exactly { error } on missing required fields', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/v1/audit')
      .send({ action: 'CONTRACT_CREATED' })
      .expect(400);

    assertExactKeys(res.body, ['error']);
    expect(typeof res.body.error).toBe('string');
    expect(res.body).toMatchSnapshot();
  });
});

// ─── Error response contract ────────────────────────────────────────────────

describe('Contract: error responses', () => {
  it('GET / with invalid action returns exactly { error: string }', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/v1/audit?action=BOGUS').expect(400);

    assertExactKeys(res.body, ['error']);
    expect(typeof res.body.error).toBe('string');
    expect(res.body).toMatchSnapshot();
  });

  it('GET / with invalid severity returns exactly { error: string }', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/v1/audit?severity=EXTREME').expect(400);

    assertExactKeys(res.body, ['error']);
    expect(typeof res.body.error).toBe('string');
    expect(res.body).toMatchSnapshot();
  });

  it('GET / with invalid limit returns exactly { error: string }', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/v1/audit?limit=abc').expect(400);

    assertExactKeys(res.body, ['error']);
    expect(typeof res.body.error).toBe('string');
    expect(res.body).toMatchInlineSnapshot(`
      {
        "error": "Invalid to timestamp",
      }
    `);
  });

  it('GET / with invalid offset returns exactly { error: string }', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/v1/audit?offset=-1').expect(400);

    assertExactKeys(res.body, ['error']);
    expect(typeof res.body.error).toBe('string');
    expect(res.body).toMatchSnapshot();
  });

  it('GET / with invalid from date returns exactly { error: string }', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/v1/audit?from=not-a-date').expect(400);

    assertExactKeys(res.body, ['error']);
    expect(typeof res.body.error).toBe('string');
    expect(res.body).toMatchSnapshot();
  });

  it('GET / with invalid to date returns exactly { error: string }', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/v1/audit?to=not-a-date').expect(400);

    assertExactKeys(res.body, ['error']);
    expect(typeof res.body.error).toBe('string');
    expect(res.body).toMatchSnapshot();
  });

  it('returns exactly { error: string } and 500 status on internal error', async () => {
    const { app, service } = buildApp();
    jest.spyOn(service, 'log').mockImplementation(() => {
      throw new Error('Database connection lost');
    });

    const res = await request(app)
      .post('/api/v1/audit')
      .send({
        action: 'PAYMENT_INITIATED',
        severity: 'CRITICAL',
        actor: 'pay-service',
        resource: 'payment',
        resourceId: 'pay-100',
        metadata: {},
      })
      .expect(500);

    assertExactKeys(res.body, ['error']);
    expect(res.body.error).toBe('Database connection lost');
    expect(res.body).toMatchInlineSnapshot(`
      {
        "error": "Database connection lost",
      }
    `);
  });
});

// ─── AuditEntry field-level contract ────────────────────────────────────────

describe('Contract: AuditEntry field types', () => {
  it('metadata is a plain object (not null, not array)', async () => {
    const { app, store } = buildApp();
    store.append({
      action: 'ADMIN_ACTION',
      severity: 'CRITICAL',
      actor: 'system',
      resource: 'system',
      resourceId: 'sys-1',
      metadata: { nested: { deep: true }, list: [1, 2, 3] },
    });

    const res = await request(app).get('/api/v1/audit').expect(200);
    const meta = res.body.entries[0].metadata;
    expect(typeof meta).toBe('object');
    expect(meta).not.toBeNull();
    expect(Array.isArray(meta)).toBe(false);
    expect(meta.nested).toEqual({ deep: true });
    expect(meta.list).toEqual([1, 2, 3]);
  });

  it('all AuditAction values are valid string literals', async () => {
    const { app, store } = buildApp();
    for (const action of VALID_ACTIONS) {
      store.append({
        action,
        severity: 'INFO',
        actor: 'test',
        resource: 'contract',
        resourceId: 'c-1',
        metadata: {},
      });
    }

    const res = await request(app).get('/api/v1/audit').expect(200);
    expect(res.body.entries).toHaveLength(VALID_ACTIONS.length);
    for (const entry of res.body.entries) {
      expect(VALID_ACTIONS).toContain(entry.action);
    }
  });

  it('all AuditSeverity values are valid', async () => {
    const { app, store } = buildApp();
    for (const severity of VALID_SEVERITIES) {
      store.append({
        action: 'CONTRACT_CREATED',
        severity,
        actor: 'test',
        resource: 'contract',
        resourceId: 'c-1',
        metadata: {},
      });
    }

    const res = await request(app).get('/api/v1/audit').expect(200);
    for (const entry of res.body.entries) {
      expect(VALID_SEVERITIES).toContain(entry.severity);
    }
  });
});

// ─── Unexpected fields rejection ────────────────────────────────────────────

describe('Contract: no unexpected fields leak into responses', () => {
  it('POST / response contains no extra fields beyond AuditEntry', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/v1/audit')
      .send({
        action: 'CONTRACT_CREATED',
        severity: 'INFO',
        actor: 'u1',
        resource: 'contract',
        resourceId: 'c1',
        metadata: {},
        extraField: 'should-not-appear',
      })
      .expect(201);

    expect(res.body.extraField).toBeUndefined();
    assertAuditEntryExactKeys(res.body, false);
  });

  it('GET / response envelope contains no extra fields', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/v1/audit').expect(200);
    assertExactKeys(res.body, ['entries', 'count', 'limit', 'offset']);
  });

  it('integrity report for a valid chain contains no extra fields', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/v1/audit/integrity').expect(200);

    // Valid IntegrityReport: only valid, totalEntries, checkedAt
    assertExactKeys(res.body, ['valid', 'totalEntries', 'checkedAt']);
  });
});
