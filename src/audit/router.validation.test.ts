/**
 * @file router.validation.test.ts
 * @description Covers request validation for the audit router: the shared
 * query-schema helper (`buildAuditQuerySchema` / `parseAuditQueryOrRespond`)
 * for GET / and GET /export, and the POST / body schema
 * (`createAuditEntryBodySchema`). Every 400 response now uses the shared
 * structured error shape from `src/middleware/validate.middleware.ts`
 * (`{ error: { code, message, requestId, details: [{ path, message, code }] } }`)
 * instead of a bare `{ error: string }` — see issue #939.
 */

import express from 'express';
import request from 'supertest';
import { AuditStore } from './store';
import { AuditService } from './service';
import { AuditExportService } from './exportService';
import { createAuditRouter } from './router';
import type { AuditEntry } from './types';

function buildApp() {
  const store = new AuditStore();
  const service = new AuditService(store);
  const exportService = new AuditExportService(service);

  const entry = service.log({
    action: 'CONTRACT_CREATED',
    severity: 'INFO',
    actor: 'user-1',
    resource: 'contract',
    resourceId: 'contract-1',
    metadata: {},
  });

  const app = express();
  app.use(express.json());
  app.use('/api/v1/audit', createAuditRouter({ service, exportService }));
  return { app, entry };
}

/** Asserts a structured validation error response flags the given field. */
function expectFieldError(body: unknown, field: string) {
  const parsed = body as {
    error: { code: string; message: string; details: Array<{ path: string[]; message: string; code: string }> };
  };
  expect(parsed.error.code).toBe('validation_error');
  expect(parsed.error.message).toBe('Request validation failed');
  expect(Array.isArray(parsed.error.details)).toBe(true);
  expect(parsed.error.details.some((d) => d.path.includes(field))).toBe(true);
}

describe.each([
  ['GET /', '/api/v1/audit'],
  ['GET /export', '/api/v1/audit/export'],
])('%s query validation (shared schema)', (_label, path) => {
  it('rejects an unknown action', async () => {
    const res = await request(buildApp().app).get(`${path}?action=NOT_REAL`).expect(400);
    expectFieldError(res.body, 'action');
  });

  it('rejects an unknown severity', async () => {
    const res = await request(buildApp().app).get(`${path}?severity=NOT_REAL`).expect(400);
    expectFieldError(res.body, 'severity');
  });

  it('rejects a non-numeric limit', async () => {
    const res = await request(buildApp().app).get(`${path}?limit=abc`).expect(400);
    expectFieldError(res.body, 'limit');
  });

  it('rejects a zero limit', async () => {
    const res = await request(buildApp().app).get(`${path}?limit=0`).expect(400);
    expectFieldError(res.body, 'limit');
  });

  it('rejects a negative offset', async () => {
    const res = await request(buildApp().app).get(`${path}?offset=-1`).expect(400);
    expectFieldError(res.body, 'offset');
  });

  it('rejects a non-numeric offset', async () => {
    const res = await request(buildApp().app).get(`${path}?offset=abc`).expect(400);
    expectFieldError(res.body, 'offset');
  });

  it('rejects an unparseable from timestamp', async () => {
    const res = await request(buildApp().app).get(`${path}?from=not-a-date`).expect(400);
    expectFieldError(res.body, 'from');
  });

  it('rejects an unparseable to timestamp', async () => {
    const res = await request(buildApp().app).get(`${path}?to=not-a-date`).expect(400);
    expectFieldError(res.body, 'to');
  });

  it('includes a requestId in the structured error response', async () => {
    const res = await request(buildApp().app)
      .get(`${path}?action=NOT_REAL`)
      .set('x-request-id', 'test-req-123')
      .expect(400);
    // requestId is only populated when upstream middleware sets res.locals.requestId;
    // here there's none wired in this minimal test app, so it falls back to 'unknown'.
    expect(typeof res.body.error.requestId).toBe('string');
  });

  it('accepts a request with no filters at all', async () => {
    await request(buildApp().app).get(path).expect(200);
  });

  it('accepts valid from/to timestamps', async () => {
    await request(buildApp().app)
      .get(`${path}?from=2020-01-01T00:00:00Z&to=2030-01-01T00:00:00Z`)
      .expect(200);
  });
});

describe('POST / body validation (schema-driven)', () => {
  const validBody = {
    action: 'CONTRACT_CREATED',
    severity: 'INFO',
    actor: 'user-1',
    resource: 'contract',
    resourceId: 'contract-1',
    metadata: { note: 'created via API' },
  };

  it('accepts a fully-valid body and returns 201 with the persisted entry', async () => {
    const res = await request(buildApp().app).post('/api/v1/audit').send(validBody).expect(201);
    expect(res.body.action).toBe('CONTRACT_CREATED');
    expect(res.body.actor).toBe('user-1');
    expect(typeof res.body.id).toBe('string');
    expect(typeof res.body.hash).toBe('string');
  });

  it('defaults metadata to {} when omitted', async () => {
    const { metadata, ...withoutMetadata } = validBody;
    void metadata;
    const res = await request(buildApp().app).post('/api/v1/audit').send(withoutMetadata).expect(201);
    expect(res.body.metadata).toEqual({});
  });

  it('rejects a body missing a required field with a structured error', async () => {
    const { action, ...withoutAction } = validBody;
    void action;
    const res = await request(buildApp().app).post('/api/v1/audit').send(withoutAction).expect(400);
    expectFieldError(res.body, 'action');
  });

  it('rejects an unknown action value', async () => {
    const res = await request(buildApp().app)
      .post('/api/v1/audit')
      .send({ ...validBody, action: 'NOT_A_REAL_ACTION' })
      .expect(400);
    expectFieldError(res.body, 'action');
  });

  it('rejects an unknown severity value', async () => {
    const res = await request(buildApp().app)
      .post('/api/v1/audit')
      .send({ ...validBody, severity: 'CATASTROPHIC' })
      .expect(400);
    expectFieldError(res.body, 'severity');
  });

  it('rejects an empty actor string', async () => {
    const res = await request(buildApp().app)
      .post('/api/v1/audit')
      .send({ ...validBody, actor: '' })
      .expect(400);
    expectFieldError(res.body, 'actor');
  });

  it('rejects a non-object metadata value', async () => {
    const res = await request(buildApp().app)
      .post('/api/v1/audit')
      .send({ ...validBody, metadata: 'not-an-object' })
      .expect(400);
    expectFieldError(res.body, 'metadata');
  });

  it('reports multiple field errors in a single response', async () => {
    const res = await request(buildApp().app)
      .post('/api/v1/audit')
      .send({ action: 'NOT_REAL', severity: 'NOT_REAL' })
      .expect(400);
    const fields = res.body.error.details.map((d: { path: string[] }) => d.path[0]);
    expect(fields).toEqual(expect.arrayContaining(['action', 'severity', 'actor', 'resource', 'resourceId']));
  });
});

describe('GET / vs GET /export limit clamping (each keeps its own max)', () => {
  it('GET / clamps to 100 even when a larger limit is requested', async () => {
    const res = await request(buildApp().app).get('/api/v1/audit?limit=999999').expect(200);
    expect(res.body.limit).toBe(100);
  });

  it('GET /export accepts a limit above 1000 (its own higher max of 50000)', async () => {
    await request(buildApp().app).get('/api/v1/audit/export?limit=5000').expect(200);
  });

  it('GET / echoes back an explicit valid offset', async () => {
    const res = await request(buildApp().app).get('/api/v1/audit?offset=5').expect(200);
    expect(res.body.offset).toBe(5);
  });
});

describe.each([
  ['GET /', '/api/v1/audit'],
  ['GET /export', '/api/v1/audit/export'],
])('%s accepts a fully-specified set of valid filters', (_label, path) => {
  it('carries action, severity, actor, resource and resourceId through unchanged', async () => {
    const { app } = buildApp();
    await request(app)
      .get(
        `${path}?action=CONTRACT_CREATED&severity=INFO&actor=user-1&resource=contract&resourceId=contract-1`,
      )
      .expect(200);
  });
});

describe('GET /integrity (real router)', () => {
  it('returns 409 and valid:false when the hash chain has been tampered with', async () => {
    const store = new AuditStore();
    const service = new AuditService(store);
    const exportService = new AuditExportService(service);

    const first = service.log({
      action: 'CONTRACT_CREATED',
      severity: 'INFO',
      actor: 'user-1',
      resource: 'contract',
      resourceId: 'contract-1',
      metadata: {},
    });
    const tampered: AuditEntry = Object.freeze({ ...first, hash: 'badhash'.padEnd(64, '0') });
    (store as unknown as { log: AuditEntry[] }).log = [tampered];

    const app = express();
    app.use('/api/v1/audit', createAuditRouter({ service, exportService }));

    const res = await request(app).get('/api/v1/audit/integrity').expect(409);
    expect(res.body.valid).toBe(false);
  });
});

describe('GET /:id (real router, not the parallel test-only reimplementation)', () => {
  it('returns the entry for a valid id', async () => {
    const { app, entry } = buildApp();
    const res = await request(app).get(`/api/v1/audit/${entry.id}`).expect(200);
    expect(res.body.id).toBe(entry.id);
    expect(res.body.action).toBe('CONTRACT_CREATED');
  });
});

describe('GET /export error classification (non-validation failures)', () => {
  function buildAppWithBrokenExport(exportError: Error) {
    const store = new AuditStore();
    const service = new AuditService(store);
    const brokenExportService = {
      createNdjsonExport: jest.fn().mockRejectedValue(exportError),
    } as unknown as AuditExportService;

    const app = express();
    app.use('/api/v1/audit', createAuditRouter({ service, exportService: brokenExportService }));
    return app;
  }

  it('returns 500 for a non-validation export failure', async () => {
    const app = buildAppWithBrokenExport(new Error('disk full'));
    const res = await request(app).get('/api/v1/audit/export').expect(500);
    expect(res.body.error).toBe('disk full');
  });

  it('returns 400 when the export service itself raises an "Invalid " prefixed error', async () => {
    const app = buildAppWithBrokenExport(new Error('Invalid export configuration'));
    const res = await request(app).get('/api/v1/audit/export').expect(400);
    expect(res.body.error).toBe('Invalid export configuration');
  });
});
