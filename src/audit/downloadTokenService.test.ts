/**
 * @file audit/downloadTokenService.test.ts
 * @description Unit and integration tests for the download-token system.
 *
 * Edge cases tested (per issue #1222 acceptance criteria):
 *   1. token_expired   — JWT exp in the past → 401
 *   2. token_reused    — second consume() of the same token → 410
 *   3. tenant_mismatch — token.tenantId ≠ caller tenantId → 403
 *   4. artifact_deleted — file absent at download time → 410
 *   5. download_interrupted — pipeline error mid-stream → connection closed
 *
 * Plus success paths, revocation, concurrent-use safety, and structured
 * error envelope assertions.
 */

import request from 'supertest';
import express, { type Express } from 'express';
import { promises as fsp } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import BetterSqlite3 from 'better-sqlite3';
import type { Database as DatabaseInstance } from 'better-sqlite3';
import { runMigrations } from '../db/migrations';
import { SqliteDownloadTokenStore } from './downloadTokenStore';
import { DownloadTokenService, DownloadTokenError } from './downloadTokenService';
import { createAuditRouter } from './router';
import { AuditService } from './service';
import { AuditExportService, type AuditExportResult } from './exportService';
import { AuditStore } from './store';
import { requestIdMiddleware } from '../middleware/requestId';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeMemoryDb(): DatabaseInstance {
  const db = new BetterSqlite3(':memory:');
  runMigrations(db);
  return db;
}

/** Creates an in-memory audit service with optional pre-populated entries. */
function makeAuditService() {
  const store = new AuditStore();
  return new AuditService(store, { cache: undefined });
}

/** Builds a minimal Express app with the audit router wired up. */
function makeApp(
  tokenSvc: DownloadTokenService,
  auditSvc?: AuditService,
  exportSvc?: AuditExportService,
): Express {
  const app = express();
  app.use(express.json());

  // Required by the router: populates res.locals.requestId
  app.use(requestIdMiddleware);

  // Simulate requireAuth middleware: attach req.user from header.
  app.use((req, _res, next) => {
    const userId = req.headers['x-test-user-id'];
    if (userId && typeof userId === 'string') {
      (req as any).user = { id: userId };
    }
    next();
  });

  const router = createAuditRouter({
    service: auditSvc ?? makeAuditService(),
    exportService: exportSvc,
    downloadTokenService: tokenSvc,
    accessMiddleware: [],
    exportMiddleware: [],
  });

  app.use('/api/v1/audit', router);
  return app;
}

// ─── SqliteDownloadTokenStore unit tests ────────────────────────────────────

describe('SqliteDownloadTokenStore', () => {
  let db: ReturnType<typeof makeMemoryDb>;
  let store: SqliteDownloadTokenStore;

  beforeEach(() => {
    db = makeMemoryDb();
    store = new SqliteDownloadTokenStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it('inserts and retrieves a token', () => {
    store.insert({
      jti: 'jti-1',
      tenantId: 'tenant-a',
      requesterId: 'user-1',
      artifactId: 'export.ndjson',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const row = store.findByJti('jti-1', 'tenant-a');
    expect(row).toBeDefined();
    expect(row!.requester_id).toBe('user-1');
    expect(row!.used_at).toBeNull();
    expect(row!.revoked_at).toBeNull();
  });

  it('returns undefined for wrong tenantId (tenant isolation)', () => {
    store.insert({
      jti: 'jti-2',
      tenantId: 'tenant-a',
      requesterId: 'user-1',
      artifactId: 'export.ndjson',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const row = store.findByJti('jti-2', 'tenant-b');
    expect(row).toBeUndefined();
  });

  it('markUsed returns true on first call and false on second (one-time use)', () => {
    store.insert({
      jti: 'jti-3',
      tenantId: 'tenant-a',
      requesterId: 'user-1',
      artifactId: 'export.ndjson',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    expect(store.markUsed('jti-3', 'tenant-a')).toBe(true);
    expect(store.markUsed('jti-3', 'tenant-a')).toBe(false);
  });

  it('revoke prevents subsequent markUsed', () => {
    store.insert({
      jti: 'jti-4',
      tenantId: 'tenant-a',
      requesterId: 'user-1',
      artifactId: 'export.ndjson',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    expect(store.revoke('jti-4', 'tenant-a')).toBe(true);
    expect(store.markUsed('jti-4', 'tenant-a')).toBe(false);
  });

  it('deleteExpired removes only past-expiry rows', () => {
    store.insert({
      jti: 'jti-expired',
      tenantId: 'tenant-a',
      requesterId: 'user-1',
      artifactId: 'export.ndjson',
      expiresAt: new Date(Date.now() - 1000).toISOString(), // expired
    });
    store.insert({
      jti: 'jti-active',
      tenantId: 'tenant-a',
      requesterId: 'user-1',
      artifactId: 'export.ndjson',
      expiresAt: new Date(Date.now() + 60_000).toISOString(), // active
    });

    const deleted = store.deleteExpired();
    expect(deleted).toBe(1);
    expect(store.findByJti('jti-active', 'tenant-a')).toBeDefined();
    expect(store.findByJti('jti-expired', 'tenant-a')).toBeUndefined();
  });
});

// ─── DownloadTokenService unit tests ────────────────────────────────────────

describe('DownloadTokenService', () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    process.env = { ...OLD_ENV, JWT_SECRET: 'test-secret-at-least-32-chars-long!!' };
  });

  afterEach(() => {
    process.env = OLD_ENV;
  });

  function makeService() {
    const db = makeMemoryDb();
    const store = new SqliteDownloadTokenStore(db);
    const svc = new DownloadTokenService(store);
    return { svc, db };
  }

  it('issues a token and verifies it successfully', () => {
    const { svc } = makeService();
    const token = svc.issue({
      requesterId: 'user-1',
      tenantId: 'tenant-a',
      artifactId: 'export.ndjson',
    });

    expect(typeof token).toBe('string');
    const result = svc.verify(token, 'tenant-a');
    expect(result.payload.sub).toBe('user-1');
    expect(result.payload.tenantId).toBe('tenant-a');
    expect(result.payload.artifactId).toBe('export.ndjson');
  });

  // Edge case 1: token expired
  it('throws token_expired when JWT exp is in the past', () => {
    const { svc } = makeService();
    // Issue with 1-second TTL then advance time via fake date
    const token = svc.issue({
      requesterId: 'user-1',
      tenantId: 'tenant-a',
      artifactId: 'export.ndjson',
      ttlSeconds: 1,
    });

    // Fake time past expiry
    jest.useFakeTimers();
    jest.setSystemTime(Date.now() + 10_000);

    try {
      expect(() => svc.verify(token, 'tenant-a')).toThrow(DownloadTokenError);
      expect(() => svc.verify(token, 'tenant-a')).toThrow(
        expect.objectContaining({ code: 'token_expired' }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  // Edge case 2: token reused
  it('throws token_reused on second consume()', () => {
    const { svc } = makeService();
    const token = svc.issue({
      requesterId: 'user-1',
      tenantId: 'tenant-a',
      artifactId: 'export.ndjson',
    });

    svc.consume(token, 'tenant-a'); // first use — should succeed

    expect(() => svc.consume(token, 'tenant-a')).toThrow(
      expect.objectContaining({ code: 'token_reused' }),
    );
  });

  // Edge case 3: tenant mismatch
  it('throws tenant_mismatch when tenantId does not match token', () => {
    const { svc } = makeService();
    const token = svc.issue({
      requesterId: 'user-1',
      tenantId: 'tenant-a',
      artifactId: 'export.ndjson',
    });

    expect(() => svc.verify(token, 'tenant-b')).toThrow(
      expect.objectContaining({ code: 'tenant_mismatch' }),
    );
  });

  it('throws token_invalid for a tampered JWT', () => {
    const { svc } = makeService();
    const token = svc.issue({
      requesterId: 'user-1',
      tenantId: 'tenant-a',
      artifactId: 'export.ndjson',
    });

    const tampered = token.slice(0, -4) + 'xxxx'; // corrupt signature
    expect(() => svc.verify(tampered, 'tenant-a')).toThrow(
      expect.objectContaining({ code: 'token_invalid' }),
    );
  });

  it('throws token_revoked after revocation', () => {
    const { svc } = makeService();
    const token = svc.issue({
      requesterId: 'user-1',
      tenantId: 'tenant-a',
      artifactId: 'export.ndjson',
    });

    const parts = token.split('.');
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString()) as { jti: string };
    svc.revoke(payload.jti, 'tenant-a');

    expect(() => svc.verify(token, 'tenant-a')).toThrow(
      expect.objectContaining({ code: 'token_revoked' }),
    );
  });

  it('consume() is safe under simulated concurrency (second wins false)', () => {
    const { svc } = makeService();
    const token = svc.issue({
      requesterId: 'user-1',
      tenantId: 'tenant-a',
      artifactId: 'export.ndjson',
    });

    // First consume succeeds
    expect(() => svc.consume(token, 'tenant-a')).not.toThrow();
    // Second consume fails with token_reused
    expect(() => svc.consume(token, 'tenant-a')).toThrow(
      expect.objectContaining({ code: 'token_reused' }),
    );
  });
});

// ─── Router integration tests ────────────────────────────────────────────────

describe('POST /api/v1/audit/export/token + GET /api/v1/audit/export/download/:token', () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    process.env = { ...OLD_ENV, JWT_SECRET: 'integration-test-secret-32chars!!!!' };
  });

  afterEach(() => {
    process.env = OLD_ENV;
  });

  function setup() {
    // JWT_SECRET must be set before constructing the service
    const db = makeMemoryDb();
    const store = new SqliteDownloadTokenStore(db);
    const tokenSvc = new DownloadTokenService(store);
    const auditSvc = makeAuditService();
    // Wire the export service to the same in-memory audit service so tests
    // don't depend on the global singleton.
    const exportSvc = new AuditExportService(auditSvc);
    const app = makeApp(tokenSvc, auditSvc, exportSvc);
    return { app, tokenSvc, auditSvc, db, exportSvc };
  }

  it('POST /export/token returns 201 with token, expiresAt, artifactId', async () => {
    const { app } = setup();
    const res = await request(app)
      .post('/api/v1/audit/export/token')
      .set('x-test-user-id', 'user-1');

    expect(res.status).toBe(201);
    expect(typeof res.body.token).toBe('string');
    expect(typeof res.body.expiresAt).toBe('string');
    expect(typeof res.body.artifactId).toBe('string');
    expect(res.body.requestId).toBeDefined();
  });

  it('GET /export/download/:token streams the file successfully on first use', async () => {
    const { app } = setup();

    const tokenRes = await request(app)
      .post('/api/v1/audit/export/token')
      .set('x-test-user-id', 'user-1');

    expect(tokenRes.status).toBe(201);
    const { token } = tokenRes.body as { token: string };

    const dlRes = await request(app)
      .get(`/api/v1/audit/export/download/${token}`)
      .set('x-test-user-id', 'user-1');

    expect(dlRes.status).toBe(200);
    expect(dlRes.headers['content-type']).toMatch(/ndjson/);
    expect(dlRes.headers['content-disposition']).toMatch(/attachment/);
  });

  // Edge case 1: expired token
  it('returns 401 with code token_expired for an expired token', async () => {
    const db = makeMemoryDb();
    const store = new SqliteDownloadTokenStore(db);
    const tokenSvc = new DownloadTokenService(store);
    const auditSvc = makeAuditService();
    const exportSvc = new AuditExportService(auditSvc);
    const app = makeApp(tokenSvc, auditSvc, exportSvc);

    // Issue a token with 1-second TTL
    const token = tokenSvc.issue({
      requesterId: 'user-1',
      tenantId: 'user-1',
      artifactId: 'export.ndjson',
      ttlSeconds: 1,
    });

    jest.useFakeTimers();
    jest.setSystemTime(Date.now() + 10_000);

    try {
      const res = await request(app)
        .get(`/api/v1/audit/export/download/${token}`)
        .set('x-test-user-id', 'user-1');

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('token_expired');
      // Structured error envelope
      expect(res.body.error.requestId).toBeDefined();
    } finally {
      jest.useRealTimers();
      db.close();
    }
  });

  // Edge case 2: token reused
  it('returns 410 with code token_reused on second download attempt', async () => {
    const { app } = setup();

    const tokenRes = await request(app)
      .post('/api/v1/audit/export/token')
      .set('x-test-user-id', 'user-1');
    const { token } = tokenRes.body as { token: string };

    // First download succeeds
    const first = await request(app)
      .get(`/api/v1/audit/export/download/${token}`)
      .set('x-test-user-id', 'user-1');
    expect(first.status).toBe(200);

    // Second download fails with token_reused
    const second = await request(app)
      .get(`/api/v1/audit/export/download/${token}`)
      .set('x-test-user-id', 'user-1');
    expect(second.status).toBe(410);
    expect(second.body.error.code).toBe('token_reused');
    expect(second.body.error.requestId).toBeDefined();
  });

  // Edge case 3: tenant mismatch
  it('returns 403 with code tenant_mismatch when a different user attempts to use the token', async () => {
    const { app } = setup();

    const tokenRes = await request(app)
      .post('/api/v1/audit/export/token')
      .set('x-test-user-id', 'user-1');
    const { token } = tokenRes.body as { token: string };

    // Different user (tenant B) tries to use user-1's token
    const res = await request(app)
      .get(`/api/v1/audit/export/download/${token}`)
      .set('x-test-user-id', 'user-2');

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('tenant_mismatch');
    expect(res.body.error.requestId).toBeDefined();
  });

  // Edge case 4: artifact deleted
  it('returns 410 with code artifact_deleted when the export file does not exist', async () => {
    const db = makeMemoryDb();
    const store = new SqliteDownloadTokenStore(db);
    const tokenSvc = new DownloadTokenService(store);
    const auditSvcLocal = makeAuditService();

    // Create a real temp dir but do NOT create the file — artifact is absent
    const fakeTmpDir = path.join(tmpdir(), `tt-test-${Date.now()}`);
    await fsp.mkdir(fakeTmpDir, { recursive: true });
    const fakeFilePath = path.join(fakeTmpDir, 'missing.ndjson');

    const mockResult: AuditExportResult = {
      filePath: fakeFilePath,
      fileName: 'missing.ndjson',
      bytesWritten: 0,
      recordCount: 0,
      openReadStream: () => { throw new Error('file not found'); },
      cleanup: jest.fn<Promise<void>, []>().mockResolvedValue(undefined),
    };

    // Spy on exportAuditLogs: token issuance and download both use it.
    // Both calls return a result pointing to the absent file.
    jest.spyOn(auditSvcLocal, 'exportAuditLogs').mockResolvedValue(mockResult);

    const exportSvc = new AuditExportService(auditSvcLocal);
    const app = makeApp(tokenSvc, auditSvcLocal, exportSvc);

    const tokenRes = await request(app)
      .post('/api/v1/audit/export/token')
      .set('x-test-user-id', 'user-1');
    expect(tokenRes.status).toBe(201);
    const { token } = tokenRes.body as { token: string };

    // Download attempt — file doesn't exist → 410 artifact_deleted
    const res = await request(app)
      .get(`/api/v1/audit/export/download/${token}`)
      .set('x-test-user-id', 'user-1');

    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe('artifact_deleted');
    expect(res.body.error.requestId).toBeDefined();

    await fsp.rm(fakeTmpDir, { recursive: true, force: true });
    db.close();
  });

  // Edge case 5: download interrupted
  it('closes the connection cleanly when the stream is interrupted mid-download', async () => {
    const db = makeMemoryDb();
    const store = new SqliteDownloadTokenStore(db);
    const tokenSvc = new DownloadTokenService(store);

    // Create a real temp file so the artifact-exists check passes
    const fakeTmpDir = path.join(tmpdir(), `tt-test-interrupted-${Date.now()}`);
    await fsp.mkdir(fakeTmpDir, { recursive: true });
    const fakeFilePath = path.join(fakeTmpDir, 'interrupted.ndjson');
    await fsp.writeFile(fakeFilePath, '{"id":"1"}\n');

    const { Readable } = await import('stream');

    // Mock export service that returns an existing file path but with a stream
    // that errors mid-way
    let cleanupCalled = false;
    const mockExportResult: AuditExportResult = {
      filePath: fakeFilePath,
      fileName: 'interrupted.ndjson',
      bytesWritten: 11,
      recordCount: 1,
      openReadStream: () => {
        const r = new Readable({
          read() {
            this.push('{"id":"1"}\n');
            // Emit error to simulate mid-stream interruption
            process.nextTick(() => this.destroy(new Error('connection reset')));
          },
        });
        return r as unknown as ReturnType<AuditExportResult['openReadStream']>;
      },
      cleanup: jest.fn<Promise<void>, []>().mockImplementation(async () => {
        cleanupCalled = true;
        await fsp.rm(fakeTmpDir, { recursive: true, force: true });
      }),
    };

    const auditSvc = makeAuditService();
    jest
      .spyOn(auditSvc, 'exportAuditLogs')
      .mockResolvedValue(mockExportResult);

    const exportSvc = new AuditExportService(auditSvc);
    const app = makeApp(tokenSvc, auditSvc, exportSvc);

    const tokenRes = await request(app)
      .post('/api/v1/audit/export/token')
      .set('x-test-user-id', 'user-1');
    expect(tokenRes.status).toBe(201);
    const { token } = tokenRes.body as { token: string };

    // The download request itself may error at the transport level
    try {
      await request(app)
        .get(`/api/v1/audit/export/download/${token}`)
        .set('x-test-user-id', 'user-1');
    } catch {
      // Expected — the stream may abort
    }

    // Token was consumed (one-time use enforced even on interruption)
    expect(() => tokenSvc.consume(token, 'user-1')).toThrow(
      expect.objectContaining({ code: 'token_reused' }),
    );

    // Cleanup is always called via the finally block
    expect(cleanupCalled).toBe(true);

    db.close();
  });

  it('returns 401 for a completely invalid (non-JWT) token string', async () => {
    const { app } = setup();
    const res = await request(app)
      .get('/api/v1/audit/export/download/not-a-jwt-at-all')
      .set('x-test-user-id', 'user-1');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('token_invalid');
  });

  it('error responses never contain stack traces or internal paths', async () => {
    const { app } = setup();

    // Use an expired token
    const db = makeMemoryDb();
    const store = new SqliteDownloadTokenStore(db);
    const tokenSvc2 = new DownloadTokenService(store);
    const expiredToken = tokenSvc2.issue({
      requesterId: 'user-1',
      tenantId: 'user-1',
      artifactId: 'export.ndjson',
      ttlSeconds: 1,
    });

    jest.useFakeTimers();
    jest.setSystemTime(Date.now() + 10_000);
    try {
      const res = await request(app)
        .get(`/api/v1/audit/export/download/${expiredToken}`)
        .set('x-test-user-id', 'user-1');

      const body = JSON.stringify(res.body);
      expect(body).not.toMatch(/at .+\.ts:/); // no stack trace
      expect(body).not.toMatch(/talenttrust-audit-exports/); // no internal path
      expect(body).not.toMatch(/JWT_SECRET/); // no secrets
    } finally {
      jest.useRealTimers();
      db.close();
    }
  });
});
