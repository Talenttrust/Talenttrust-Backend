/**
 * @file router.validation.test.ts
 * @description Covers the shared query-validation helper extracted from
 * `createAuditRouter` (`parseAuditQueryOrRespond` / `parseAuditQuery`).
 * Every case here is run against both GET / and GET /export to prove the
 * two routes reject identically now that they share one validation path.
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
  app.use('/api/v1/audit', createAuditRouter({ service, exportService }));
  return { app, entry };
}

describe.each([
  ['GET /', '/api/v1/audit'],
  ['GET /export', '/api/v1/audit/export'],
])('%s query validation (shared helper)', (_label, path) => {
  it('rejects an unknown action', async () => {
    const res = await request(buildApp().app).get(`${path}?action=NOT_REAL`).expect(400);
    expect(res.body.error).toBe('Invalid action: NOT_REAL');
  });

  it('rejects an unknown severity', async () => {
    const res = await request(buildApp().app).get(`${path}?severity=NOT_REAL`).expect(400);
    expect(res.body.error).toBe('Invalid severity: NOT_REAL');
  });

  it('rejects a non-numeric limit', async () => {
    const res = await request(buildApp().app).get(`${path}?limit=abc`).expect(400);
    expect(res.body.error).toBe('Invalid limit');
  });

  it('rejects a zero limit', async () => {
    const res = await request(buildApp().app).get(`${path}?limit=0`).expect(400);
    expect(res.body.error).toBe('Invalid limit');
  });

  it('rejects a negative offset', async () => {
    const res = await request(buildApp().app).get(`${path}?offset=-1`).expect(400);
    expect(res.body.error).toBe('Invalid offset');
  });

  it('rejects a non-numeric offset', async () => {
    const res = await request(buildApp().app).get(`${path}?offset=abc`).expect(400);
    expect(res.body.error).toBe('Invalid offset');
  });

  it('rejects an unparseable from timestamp', async () => {
    const res = await request(buildApp().app).get(`${path}?from=not-a-date`).expect(400);
    expect(res.body.error).toBe('Invalid from timestamp');
  });

  it('rejects an unparseable to timestamp', async () => {
    const res = await request(buildApp().app).get(`${path}?to=not-a-date`).expect(400);
    expect(res.body.error).toBe('Invalid to timestamp');
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
