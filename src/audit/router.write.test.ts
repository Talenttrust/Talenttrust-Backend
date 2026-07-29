/**
 * @file router.write.test.ts
 * @description Integration tests for POST /api/v1/audit.
 *
 * These exercise the endpoint as a client sees it — through `express.json()`,
 * the validation middleware, and the real store — proving that:
 *  - a valid body is appended and returned with its hash chain fields;
 *  - every rejected body produces the standard `validation_error` envelope;
 *  - nothing rejected ever reaches the store.
 *
 * Field-level bound coverage lives in `inputValidation.test.ts`; this file
 * covers the wiring and the response contract.
 */

import express from 'express';
import request from 'supertest';
import { AuditStore } from './store';
import { AuditService } from './service';
import { AuditExportService } from './exportService';
import { createAuditRouter } from './router';
import { notFoundHandler, errorHandler } from '../middleware/errorHandlers';
import { clearIdempotencyStore } from '../middleware/idempotency';
import {
  AUDIT_VALIDATION_CODES,
  MAX_ID_LENGTH,
  MAX_METADATA_BYTES,
  MAX_METADATA_DEPTH,
  MAX_METADATA_ENTRIES,
} from './inputValidation';

interface Harness {
  app: express.Application;
  service: AuditService;
}

/**
 * @param options.terminalHandlers - Register the app's 404/error handlers, so
 *   body-parser failures are mapped the same way they are in production.
 */
function buildHarness(options: { terminalHandlers?: boolean } = {}): Harness {
  const service = new AuditService(new AuditStore());
  const exportService = new AuditExportService(service);

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    res.locals.requestId = 'req-test-id';
    next();
  });
  app.use('/api/v1/audit', createAuditRouter({ service, exportService }));
  if (options.terminalHandlers) {
    app.use(notFoundHandler);
    app.use(errorHandler);
  }

  return { app, service };
}

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: 'PAYMENT_RELEASED',
    severity: 'CRITICAL',
    actor: 'admin-7',
    resource: 'payment',
    resourceId: 'pay-123',
    metadata: { amount: 2500, currency: 'USD' },
    ...overrides,
  };
}

// ── Accepted writes ───────────────────────────────────────────────────────────

describe('POST /api/v1/audit — accepted writes', () => {
  it('appends the entry and returns 201 with the hash chain fields', async () => {
    const { app, service } = buildHarness();

    const res = await request(app).post('/api/v1/audit').send(validBody()).expect(201);

    expect(res.body).toMatchObject({
      action: 'PAYMENT_RELEASED',
      severity: 'CRITICAL',
      actor: 'admin-7',
      resource: 'payment',
      resourceId: 'pay-123',
      metadata: { amount: 2500, currency: 'USD' },
      previousHash: 'GENESIS',
    });
    expect(res.body.id).toEqual(expect.any(String));
    expect(res.body.timestamp).toEqual(expect.any(String));
    expect(res.body.hash).toEqual(expect.any(String));
    expect(service.count()).toBe(1);
  });

  it('persists the entry so it can be read back', async () => {
    const { app } = buildHarness();

    const created = await request(app).post('/api/v1/audit').send(validBody()).expect(201);
    const fetched = await request(app).get(`/api/v1/audit/${created.body.id}`).expect(200);

    expect(fetched.body).toEqual(created.body);
  });

  it('keeps the hash chain valid across several writes', async () => {
    const { app } = buildHarness();

    for (let i = 0; i < 3; i += 1) {
      await request(app)
        .post('/api/v1/audit')
        .send(validBody({ resourceId: `pay-${i}` }))
        .expect(201);
    }

    const integrity = await request(app).get('/api/v1/audit/integrity').expect(200);
    expect(integrity.body).toMatchObject({ valid: true, totalEntries: 3 });
  });

  it('defaults metadata to an empty object when omitted', async () => {
    const { app } = buildHarness();
    const body = validBody();
    delete body['metadata'];

    const res = await request(app).post('/api/v1/audit').send(body).expect(201);

    expect(res.body.metadata).toEqual({});
  });

  it('stores the optional ipAddress and correlationId', async () => {
    const { app } = buildHarness();

    const res = await request(app)
      .post('/api/v1/audit')
      .send(validBody({ ipAddress: '198.51.100.9', correlationId: 'corr-1' }))
      .expect(201);

    expect(res.body).toMatchObject({ ipAddress: '198.51.100.9', correlationId: 'corr-1' });
  });

  it('accepts a body at the exact edge of every bound', async () => {
    const { app } = buildHarness();

    await request(app)
      .post('/api/v1/audit')
      .send(
        validBody({
          actor: 'a'.repeat(MAX_ID_LENGTH),
          resource: 'r'.repeat(MAX_ID_LENGTH),
          resourceId: 'i'.repeat(MAX_ID_LENGTH),
          metadata: Object.fromEntries(
            Array.from({ length: MAX_METADATA_ENTRIES }, (_, i) => [`k${i}`, i]),
          ),
        }),
      )
      .expect(201);
  });
});

// ── Rejected writes ───────────────────────────────────────────────────────────

describe('POST /api/v1/audit — rejected writes', () => {
  const cases: Array<[string, Record<string, unknown> | unknown[] | null, string, string]> = [
    [
      'a missing required field',
      { severity: 'INFO', actor: 'a', resource: 'r', resourceId: 'i' },
      'action',
      AUDIT_VALIDATION_CODES.MISSING_FIELD,
    ],
    [
      'an unknown field',
      validBody({ hash: 'forged' }),
      'hash',
      AUDIT_VALIDATION_CODES.UNKNOWN_FIELD,
    ],
    [
      'a wrong-typed field',
      validBody({ actor: 99 }),
      'actor',
      AUDIT_VALIDATION_CODES.INVALID_TYPE,
    ],
    [
      'an invalid action',
      validBody({ action: 'CONTRACT_EXPLODED' }),
      'action',
      AUDIT_VALIDATION_CODES.INVALID_ENUM,
    ],
    [
      'an invalid severity',
      validBody({ severity: 'FATAL' }),
      'severity',
      AUDIT_VALIDATION_CODES.INVALID_ENUM,
    ],
    [
      'an oversized identifier',
      validBody({ actor: 'a'.repeat(MAX_ID_LENGTH + 1) }),
      'actor',
      AUDIT_VALIDATION_CODES.TOO_BIG,
    ],
    [
      'a blank identifier',
      validBody({ resource: '   ' }),
      'resource',
      AUDIT_VALIDATION_CODES.BLANK,
    ],
    [
      'a malformed ipAddress',
      validBody({ ipAddress: 'not-an-ip' }),
      'ipAddress',
      AUDIT_VALIDATION_CODES.INVALID_FORMAT,
    ],
    [
      'a correlationId with a newline',
      validBody({ correlationId: 'corr-1\nlevel=fatal' }),
      'correlationId',
      AUDIT_VALIDATION_CODES.INVALID_FORMAT,
    ],
    [
      'non-object metadata',
      validBody({ metadata: 'amount=1' }),
      'metadata',
      AUDIT_VALIDATION_CODES.INVALID_TYPE,
    ],
    [
      'metadata with too many keys',
      validBody({
        metadata: Object.fromEntries(
          Array.from({ length: MAX_METADATA_ENTRIES + 1 }, (_, i) => [`k${i}`, i]),
        ),
      }),
      'metadata',
      AUDIT_VALIDATION_CODES.METADATA_TOO_MANY_KEYS,
    ],
    [
      'an empty body',
      {},
      'action',
      AUDIT_VALIDATION_CODES.MISSING_FIELD,
    ],
    [
      'an array body',
      [validBody()],
      '(root)',
      AUDIT_VALIDATION_CODES.INVALID_TYPE,
    ],
  ];

  it.each(cases)('rejects %s with a 400', async (_label, body, field, code) => {
    const { app, service } = buildHarness();

    const res = await request(app).post('/api/v1/audit').send(body).expect(400);

    expect(res.body.error.code).toBe('validation_error');
    expect(res.body.error.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ field, code })]),
    );
    expect(service.count()).toBe(0);
  });

  it('rejects metadata nested past the depth bound', async () => {
    const { app, service } = buildHarness();
    let metadata: Record<string, unknown> = {};
    for (let i = 0; i <= MAX_METADATA_DEPTH; i += 1) {
      metadata = { nested: metadata };
    }

    const res = await request(app).post('/api/v1/audit').send(validBody({ metadata })).expect(400);

    expect(res.body.error.details.map((d: { code: string }) => d.code)).toContain(
      AUDIT_VALIDATION_CODES.METADATA_TOO_DEEP,
    );
    expect(service.count()).toBe(0);
  });

  it('rejects metadata past the serialised size bound', async () => {
    const { app, service } = buildHarness();
    const metadata = Object.fromEntries(
      Array.from({ length: 8 }, (_, i) => [`chunk${i}`, 'x'.repeat(4_000)]),
    );
    expect(Buffer.byteLength(JSON.stringify(metadata))).toBeGreaterThan(MAX_METADATA_BYTES);

    const res = await request(app).post('/api/v1/audit').send(validBody({ metadata })).expect(400);

    expect(res.body.error.details.map((d: { code: string }) => d.code)).toContain(
      AUDIT_VALIDATION_CODES.METADATA_TOO_LARGE,
    );
    expect(service.count()).toBe(0);
  });

  it('rejects a non-finite number produced by a JSON overflow literal', async () => {
    const { app, service } = buildHarness();

    const res = await request(app)
      .post('/api/v1/audit')
      .set('Content-Type', 'application/json')
      .send('{"action":"AUTH_LOGIN","severity":"INFO","actor":"a","resource":"r","resourceId":"i","metadata":{"ratio":1e400}}')
      .expect(400);

    expect(res.body.error.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'metadata.ratio',
          code: AUDIT_VALIDATION_CODES.NOT_FINITE,
        }),
      ]),
    );
    expect(service.count()).toBe(0);
  });

  it('rejects a prototype-polluting metadata key', async () => {
    const { app, service } = buildHarness();

    const res = await request(app)
      .post('/api/v1/audit')
      .set('Content-Type', 'application/json')
      .send('{"action":"AUTH_LOGIN","severity":"INFO","actor":"a","resource":"r","resourceId":"i","metadata":{"__proto__":{"admin":true}}}')
      .expect(400);

    expect(res.body.error.details.map((d: { code: string }) => d.code)).toContain(
      AUDIT_VALIDATION_CODES.METADATA_FORBIDDEN_KEY,
    );
    expect(service.count()).toBe(0);
    expect(({} as Record<string, unknown>)['admin']).toBeUndefined();
  });

  it('reports every problem in one response rather than the first', async () => {
    const { app } = buildHarness();

    const res = await request(app)
      .post('/api/v1/audit')
      .send({ action: 'NOPE', severity: 'NOPE', actor: '', extra: 1 })
      .expect(400);

    const fields = res.body.error.details.map((d: { field: string }) => d.field);
    expect(fields).toEqual(
      expect.arrayContaining(['action', 'severity', 'actor', 'resource', 'resourceId', 'extra']),
    );
  });

  it('returns a details entry shaped { path, field, code, message }', async () => {
    const { app } = buildHarness();

    const res = await request(app).post('/api/v1/audit').send({}).expect(400);

    for (const detail of res.body.error.details) {
      expect(Object.keys(detail).sort()).toEqual(['code', 'field', 'message', 'path']);
      expect(Array.isArray(detail.path)).toBe(true);
      expect(detail.message).not.toHaveLength(0);
    }
  });

  it('includes the request id in the envelope', async () => {
    const { app } = buildHarness();

    const res = await request(app).post('/api/v1/audit').send({}).expect(400);

    expect(res.body.error).toHaveProperty('requestId');
  });

  it('rejects malformed JSON through the app error handler', async () => {
    const { app, service } = buildHarness({ terminalHandlers: true });

    const res = await request(app)
      .post('/api/v1/audit')
      .set('Content-Type', 'application/json')
      .send('{"action": "AUTH_LOGIN",')
      .expect(400);

    expect(res.body.error.code).toBe('invalid_json');
    expect(service.count()).toBe(0);
  });
});

// ── Interaction with the idempotency layer ────────────────────────────────────

describe('POST /api/v1/audit — validation ahead of idempotency', () => {
  beforeEach(() => {
    clearIdempotencyStore();
  });

  afterEach(() => {
    clearIdempotencyStore();
  });

  it('does not cache a rejected body, so the same key still works once corrected', async () => {
    const { app, service } = buildHarness();

    const rejected = await request(app)
      .post('/api/v1/audit')
      .set('Idempotency-Key', 'key-recovered')
      .send(validBody({ action: 'NOT_AN_ACTION' }))
      .expect(400);
    expect(rejected.body.error.code).toBe('validation_error');

    // Had the 400 been cached, this retry would replay it with a 200.
    const accepted = await request(app)
      .post('/api/v1/audit')
      .set('Idempotency-Key', 'key-recovered')
      .send(validBody())
      .expect(201);

    expect(accepted.body.id).toEqual(expect.any(String));
    expect(service.count()).toBe(1);
  });

  it('still deduplicates a valid retry under the same key', async () => {
    const { app, service } = buildHarness();

    const first = await request(app)
      .post('/api/v1/audit')
      .set('Idempotency-Key', 'key-dedup')
      .send(validBody())
      .expect(201);

    const replay = await request(app)
      .post('/api/v1/audit')
      .set('Idempotency-Key', 'key-dedup')
      .send(validBody())
      .expect(200);

    expect(replay.body.id).toBe(first.body.id);
    expect(replay.body.idempotencyHeader).toBe('replay-detected');
    expect(service.count()).toBe(1);
  });

  it('leaves req.body untouched, so the metadata default does not change the payload hash', async () => {
    const { app } = buildHarness();
    const body = validBody();
    delete body['metadata'];

    // The first write is stored under a hash of the body as sent, without the
    // injected `metadata: {}` default; an identical retry must therefore match.
    await request(app)
      .post('/api/v1/audit')
      .set('Idempotency-Key', 'key-default')
      .send(body)
      .expect(201);

    const replay = await request(app)
      .post('/api/v1/audit')
      .set('Idempotency-Key', 'key-default')
      .send(body)
      .expect(200);

    expect(replay.body.idempotencyHeader).toBe('replay-detected');
  });

  it('returns 409 when a key is reused with a different valid payload', async () => {
    const { app } = buildHarness();

    await request(app)
      .post('/api/v1/audit')
      .set('Idempotency-Key', 'key-conflicting')
      .send(validBody({ actor: 'admin-1' }))
      .expect(201);

    const conflict = await request(app)
      .post('/api/v1/audit')
      .set('Idempotency-Key', 'key-conflicting')
      .send(validBody({ actor: 'admin-2' }))
      .expect(409);

    expect(conflict.body.error.code).toBe('idempotency_payload_conflict');
  });
});

// ── Access control wiring ─────────────────────────────────────────────────────

describe('POST /api/v1/audit — middleware ordering', () => {
  it('runs access middleware before validation, so an unauthorised caller learns nothing about the schema', async () => {
    const service = new AuditService(new AuditStore());
    const app = express();
    app.use(express.json());
    app.use(
      '/api/v1/audit',
      createAuditRouter({
        service,
        accessMiddleware: [
          (_req, res, _next) => {
            res.status(403).json({ error: 'forbidden' });
          },
        ],
      }),
    );

    const res = await request(app).post('/api/v1/audit').send({ nonsense: true }).expect(403);

    expect(res.body).toEqual({ error: 'forbidden' });
    expect(service.count()).toBe(0);
  });
});
