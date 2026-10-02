/**
 * @file audit/router.contract.test.ts
 * @description Public HTTP contract tests for `createAuditRouter` (issue #1360).
 *
 * These tests pin the *observable* REST contract so that no refactor can
 * silently change a status code, response key, or the legacy error shape that
 * existing clients depend on:
 *
 *   1. Every success response carries `requestId` (and `correlationId` when the
 *      caller supplied `X-Correlation-Id`).
 *   2. Client-input failures keep the documented legacy shapes — a plain
 *      string `error` for the collection/recent routes and a structured
 *      `{ error: { code, details } }` for body validation.
 *   3. Infrastructure failures are reported as `500` with a stable
 *      `internal_error` code and a *safe* message; raw driver text (SQL,
 *      table names, file paths) must never reach the caller.
 *   4. Route precedence (`/export`, `/integrity`, `/:id`) stays intact.
 *
 * The suite drives the real router through Express and a real in-memory
 * `AuditService`/`AuditStore`; failures are injected with `jest.spyOn` so the
 * happy path is exercised against production wiring.
 */

import request from 'supertest';
import express, { type Express } from 'express';
import { createReadStream } from 'fs';
import { createAuditRouter } from './router';
import { AuditService } from './service';
import { AuditStore } from './store';
import { requestIdMiddleware } from '../middleware/requestId';
import type { AuditExportResult } from './exportService';

function makeService(): { service: AuditService; store: AuditStore } {
  const store = new AuditStore();
  return { service: new AuditService(store, { cache: undefined }), store };
}

function makeApp(service: AuditService): Express {
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  app.use(
    '/api/v1/audit',
    createAuditRouter({
      service,
      accessMiddleware: [],
      exportMiddleware: [],
      integrityMiddleware: [],
      bulkMiddleware: [],
    }),
  );
  return app;
}

function validEntryBody(overrides: Record<string, unknown> = {}) {
  return {
    action: 'CONTRACT_CREATED',
    severity: 'INFO',
    actor: 'user-1',
    resource: 'contract',
    resourceId: 'contract-1',
    metadata: { note: 'contract test' },
    ...overrides,
  };
}

// ─── GET / ──────────────────────────────────────────────────────────────────

describe('GET /api/v1/audit — contract', () => {
  it('returns the paginated result with requestId and correlationId', async () => {
    const { service, store } = makeService();
    store.append({
      action: 'CONTRACT_CREATED',
      severity: 'INFO',
      actor: 'user-1',
      resource: 'contract',
      resourceId: 'contract-1',
      metadata: {},
    });

    const res = await request(makeApp(service))
      .get('/api/v1/audit')
      .set('X-Correlation-Id', 'corr-abc-123');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.entries)).toBe(true);
    expect(typeof res.body.count).toBe('number');
    expect(res.body.requestId).toBeDefined();
    expect(res.body.correlationId).toBe('corr-abc-123');
  });

  it('preserves the documented legacy validation error shape for an invalid action', async () => {
    const { service } = makeService();
    const res = await request(makeApp(service)).get('/api/v1/audit?action=NOPE');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid action: NOPE');
    expect(res.body.code).toBe('validation_error');
    expect(res.body.requestId).toBeDefined();
  });

  it('returns a safe 500 (not a 400) when the repository fails', async () => {
    const { service } = makeService();
    jest.spyOn(service, 'queryLogs').mockImplementation(() => {
      throw new Error('SQLITE_BUSY: database is locked while reading /var/lib/audit.db');
    });

    const res = await request(makeApp(service)).get('/api/v1/audit');

    expect(res.status).toBe(500);
    expect(res.body.error).toMatchObject({
      code: 'internal_error',
      message: 'Failed to query audit log',
    });
    expect(res.body.error.requestId).toBeDefined();

    const serialised = JSON.stringify(res.body);
    expect(serialised).not.toContain('SQLITE_BUSY');
    expect(serialised).not.toContain('/var/lib/audit.db');
    expect(serialised).not.toMatch(/at .+\.ts:/);
  });
});

// ─── POST / ─────────────────────────────────────────────────────────────────

describe('POST /api/v1/audit — contract', () => {
  it('accepts a valid entry and returns 201', async () => {
    const { service } = makeService();
    const res = await request(makeApp(service))
      .post('/api/v1/audit')
      .send(validEntryBody());

    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.action).toBe('CONTRACT_CREATED');
  });

  it('rejects a malformed body with a structured validation error', async () => {
    const { service } = makeService();
    const res = await request(makeApp(service))
      .post('/api/v1/audit')
      .send({ action: 'NOPE' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
    expect(Array.isArray(res.body.error.details)).toBe(true);
    expect(res.body.error.requestId).toBeDefined();
  });

  it('keeps the legacy string error for a missing-field rejection', async () => {
    const { service } = makeService();
    jest
      .spyOn(service, 'log')
      .mockImplementation(() => {
        throw new Error('Missing required fields: action, severity');
      });

    const res = await request(makeApp(service))
      .post('/api/v1/audit')
      .send(validEntryBody());

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Missing required fields: action, severity');
    expect(res.body.code).toBe('validation_error');
  });

  it('returns a safe 500 when persistence fails', async () => {
    const { service } = makeService();
    jest.spyOn(service, 'log').mockImplementation(() => {
      throw new Error('disk I/O error writing to /srv/audit/talenttrust-audit.db');
    });

    const res = await request(makeApp(service))
      .post('/api/v1/audit')
      .send(validEntryBody());

    expect(res.status).toBe(500);
    expect(res.body.error).toMatchObject({
      code: 'internal_error',
      message: 'Failed to write audit entry',
    });

    const serialised = JSON.stringify(res.body);
    expect(serialised).not.toContain('disk I/O error');
    expect(serialised).not.toContain('/srv/audit');
  });
});

// ─── GET /:id ───────────────────────────────────────────────────────────────

describe('GET /api/v1/audit/:id — contract', () => {
  it('returns the entry with correlation metadata on the success path', async () => {
    const { service, store } = makeService();
    const entry = store.append({
      action: 'CONTRACT_CREATED',
      severity: 'INFO',
      actor: 'user-1',
      resource: 'contract',
      resourceId: 'contract-1',
      metadata: {},
    });

    const res = await request(makeApp(service))
      .get(`/api/v1/audit/${entry.id}`)
      .set('X-Correlation-Id', 'corr-get-1');

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(entry.id);
    expect(res.body.requestId).toBeDefined();
    expect(res.body.correlationId).toBe('corr-get-1');
  });

  it('returns 404 for an unknown id without echoing internals', async () => {
    const { service } = makeService();
    const res = await request(makeApp(service)).get('/api/v1/audit/does-not-exist');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Audit entry not found');
    expect(res.body.requestId).toBeDefined();
  });
});

// ─── GET /integrity ─────────────────────────────────────────────────────────

describe('GET /api/v1/audit/integrity — contract', () => {
  it('reports a valid chain with 200', async () => {
    const { service } = makeService();
    const res = await request(makeApp(service)).get('/api/v1/audit/integrity');

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.requestId).toBeDefined();
  });

  it('reports a broken chain with 409', async () => {
    const { service } = makeService();
    jest.spyOn(service, 'checkIntegrity').mockReturnValue({
      report: {
        valid: false,
        totalEntries: 1,
        firstCorruptedIndex: 0,
        firstCorruptedId: 'id-0',
        checkedAt: '2026-01-01T00:00:00.000Z',
      },
      status: 409,
    });

    const res = await request(makeApp(service)).get('/api/v1/audit/integrity');
    expect(res.status).toBe(409);
    expect(res.body.valid).toBe(false);
  });

  it('returns a safe 500 when verification throws', async () => {
    const { service } = makeService();
    jest.spyOn(service, 'checkIntegrity').mockImplementation(() => {
      throw new Error('no such table: audit_log_entries');
    });

    const res = await request(makeApp(service)).get('/api/v1/audit/integrity');

    expect(res.status).toBe(500);
    expect(res.body.error).toMatchObject({
      code: 'internal_error',
      message: 'Failed to verify audit integrity',
    });
    expect(JSON.stringify(res.body)).not.toContain('audit_log_entries');
  });
});

// ─── GET /export ────────────────────────────────────────────────────────────

describe('GET /api/v1/audit/export — contract', () => {
  it('streams NDJSON and sets the export headers on success', async () => {
    const { service } = makeService();
    const fakeResult: AuditExportResult = {
      filePath: __filename,
      fileName: 'audit-log-test.ndjson',
      bytesWritten: 2,
      recordCount: 1,
      openReadStream: () => createReadStream(__filename),
      cleanup: jest.fn().mockResolvedValue(undefined),
    };
    jest.spyOn(service, 'exportAuditLogs').mockResolvedValue(fakeResult);

    const res = await request(makeApp(service)).get('/api/v1/audit/export');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/ndjson/);
    expect(res.headers['content-disposition']).toMatch(/attachment/);
    expect(res.headers['x-audit-export-records']).toBe('1');
  });

  it('returns a safe 500 without leaking the driver message', async () => {
    const { service } = makeService();
    jest.spyOn(service, 'exportAuditLogs').mockRejectedValue(
      new Error('ENOENT: no such file or directory, open /srv/audit-exports/tmp.ndjson'),
    );

    const res = await request(makeApp(service)).get('/api/v1/audit/export');

    expect(res.status).toBe(500);
    expect(res.body.error).toEqual(['Failed to export audit log']);
    expect(res.body.code).toBe('internal_error');
    expect(res.body.requestId).toBeDefined();
    expect(JSON.stringify(res.body)).not.toContain('/srv/audit-exports');
  });
});

// ─── Route precedence ───────────────────────────────────────────────────────

describe('audit router — route precedence', () => {
  it('does not treat reserved sub-paths as an :id lookup', async () => {
    const { service } = makeService();
    const unknown = await request(makeApp(service)).get('/api/v1/audit/integrity');
    expect(unknown.status).toBe(200);

    const exportRes = await request(makeApp(service)).get('/api/v1/audit/export');
    // No export service wired to throw, so a real (empty) export streams.
    expect([200, 500]).toContain(exportRes.status);
  });
});
