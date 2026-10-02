/**
 * @file audit/router.recovery.test.ts
 * @description Failure-recovery tests for the export download-token flow
 * (issue #1358).
 *
 * The download endpoint has exactly one irreversible side effect: spending a
 * single-use token. The tests below pin the *ordering* invariant that makes
 * failure recovery deterministic:
 *
 *   verify (non-destructive) -> generate artifact -> confirm readable
 *   -> consume token -> stream
 *
 * and assert the properties that ordering buys:
 *
 *   1. A dependency/disk failure *before* the commit point returns a safe 500
 *      and leaves the token reusable, so the caller can retry the same token.
 *   2. A missing artifact returns 410 and also leaves the token reusable.
 *   3. Once streaming starts, the token is spent: an interrupted stream cannot
 *      be replayed, and a concurrent second request loses with token_reused.
 *   4. Temp-file cleanup runs on every failure path, and a cleanup failure is
 *      swallowed (but logged) rather than corrupting the response.
 *   5. Operators get a structured, non-sensitive log record for download
 *      failures — no token, no filesystem paths, no SQL.
 *
 * Harness notes: a real SQLite-backed `DownloadTokenService` and a real
 * `AuditService`/`AuditExportService` are used so the tests exercise production
 * wiring; failures are injected with one-shot `jest.spyOn` mocks.
 */

import request from 'supertest';
import express, { type Express } from 'express';
import { promises as fsp, createReadStream } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import BetterSqlite3 from 'better-sqlite3';
import type { Database as DatabaseInstance } from 'better-sqlite3';
import { runMigrations } from '../db/migrations';
import { SqliteDownloadTokenStore } from './downloadTokenStore';
import { DownloadTokenService } from './downloadTokenService';
import { createAuditRouter } from './router';
import { AuditService } from './service';
import { AuditExportService, type AuditExportResult } from './exportService';
import { AuditStore } from './store';
import { requestIdMiddleware } from '../middleware/requestId';
import { setWriteRecordImpl, type LogRecord } from '../logger';

const OLD_ENV = process.env;

function makeMemoryDb(): DatabaseInstance {
  const db = new BetterSqlite3(':memory:');
  runMigrations(db);
  return db;
}

interface Harness {
  app: Express;
  service: AuditService;
  tokenSvc: DownloadTokenService;
  db: DatabaseInstance;
}

function setup(): Harness {
  const db = makeMemoryDb();
  const tokenSvc = new DownloadTokenService(new SqliteDownloadTokenStore(db));
  const service = new AuditService(new AuditStore(), { cache: undefined });
  const exportService = new AuditExportService(service);

  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  app.use((req, _res, next) => {
    const userId = req.headers['x-test-user-id'];
    if (typeof userId === 'string') {
      (req as unknown as { user?: { id: string } }).user = { id: userId };
    }
    next();
  });
  app.use(
    '/api/v1/audit',
    createAuditRouter({
      service,
      exportService,
      downloadTokenService: tokenSvc,
      accessMiddleware: [],
      exportMiddleware: [],
      integrityMiddleware: [],
      bulkMiddleware: [],
    }),
  );

  return { app, service, tokenSvc, db };
}

/** Issues a token bound to `user-1` via the real endpoint. */
async function issueToken(app: Express): Promise<string> {
  const res = await request(app)
    .post('/api/v1/audit/export/token')
    .set('x-test-user-id', 'user-1');
  expect(res.status).toBe(201);
  return (res.body as { token: string }).token;
}

/** An export result pointing at a non-existent file. */
function missingArtifactResult(cleanup = jest.fn<Promise<void>, []>().mockResolvedValue(undefined)): AuditExportResult {
  return {
    filePath: path.join(tmpdir(), `tt-recovery-missing-${Date.now()}.ndjson`),
    fileName: 'missing.ndjson',
    bytesWritten: 0,
    recordCount: 0,
    openReadStream: () => {
      throw new Error('file not found');
    },
    cleanup,
  };
}

let logRecords: LogRecord[];

/** Wait for server-side `finally` blocks (which run after the response ends). */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  process.env = { ...OLD_ENV, JWT_SECRET: 'recovery-test-secret-at-least-32-characters!!' };
  logRecords = [];
  setWriteRecordImpl((record) => {
    logRecords.push(record);
  });
});

afterEach(() => {
  process.env = OLD_ENV;
});

// ─── 1. Dependency failure is recoverable ───────────────────────────────────

describe('recovery — dependency failure is retryable', () => {
  it('returns a safe 500 on a generation failure but keeps the token reusable', async () => {
    const { app, service } = setup();
    const token = await issueToken(app);

    jest
      .spyOn(service, 'exportAuditLogs')
      .mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked at /srv/audit.db'));

    const failed = await request(app)
      .get(`/api/v1/audit/export/download/${token}`)
      .set('x-test-user-id', 'user-1');

    expect(failed.status).toBe(500);
    expect(failed.body.error.code).toBe('download_error');
    expect(JSON.stringify(failed.body)).not.toContain('SQLITE_BUSY');
    expect(JSON.stringify(failed.body)).not.toContain('/srv/audit.db');

    // The same single-use token still works once the dependency recovers.
    const retried = await request(app)
      .get(`/api/v1/audit/export/download/${token}`)
      .set('x-test-user-id', 'user-1');

    expect(retried.status).toBe(200);
    expect(retried.headers['content-type']).toMatch(/ndjson/);
  });

  it('emits an operator-visible, non-sensitive log record on failure', async () => {
    const { app, service } = setup();
    const token = await issueToken(app);
    logRecords = [];

    jest
      .spyOn(service, 'exportAuditLogs')
      .mockRejectedValueOnce(new Error('ENOENT: /srv/secret/exports/tmp.ndjson'));

    await request(app)
      .get(`/api/v1/audit/export/download/${token}`)
      .set('x-test-user-id', 'user-1');

    const failure = logRecords.find((r) => r.message === 'Audit export download failed');
    expect(failure).toBeDefined();
    expect(failure).toMatchObject({ level: 'error', code: 'download_error' });
    expect(failure?.requestId).toBeDefined();

    const serialised = JSON.stringify(logRecords);
    expect(serialised).not.toContain('/srv/secret/exports');
    expect(serialised).not.toContain(token);
  });
});

// ─── 2. Missing artifact is recoverable ─────────────────────────────────────

describe('recovery — missing artifact is retryable', () => {
  it('returns 410 but does not spend the token, so a later retry succeeds', async () => {
    const { app, service } = setup();
    const token = await issueToken(app);

    const cleanup = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);
    jest
      .spyOn(service, 'exportAuditLogs')
      .mockResolvedValueOnce(missingArtifactResult(cleanup));

    const missing = await request(app)
      .get(`/api/v1/audit/export/download/${token}`)
      .set('x-test-user-id', 'user-1');

    expect(missing.status).toBe(410);
    expect(missing.body.error.code).toBe('artifact_deleted');
    expect(cleanup).toHaveBeenCalledTimes(1);

    const retried = await request(app)
      .get(`/api/v1/audit/export/download/${token}`)
      .set('x-test-user-id', 'user-1');
    expect(retried.status).toBe(200);
  });
});

// ─── 3. Commit point: one-time use survives partial completion ──────────────

describe('recovery — token is spent only at the commit point', () => {
  it('does not replay a token after a mid-stream interruption', async () => {
    const db = makeMemoryDb();
    const tokenSvc = new DownloadTokenService(new SqliteDownloadTokenStore(db));
    const service = new AuditService(new AuditStore(), { cache: undefined });

    const tempDir = path.join(tmpdir(), `tt-recovery-stream-${Date.now()}`);
    await fsp.mkdir(tempDir, { recursive: true });
    const filePath = path.join(tempDir, 'interrupted.ndjson');
    await fsp.writeFile(filePath, '{"id":"1"}\n');

    const { Readable } = await import('stream');
    const mockResult: AuditExportResult = {
      filePath,
      fileName: 'interrupted.ndjson',
      bytesWritten: 11,
      recordCount: 1,
      openReadStream: () => {
        const readable = new Readable({
          read() {
            this.push('{"id":"1"}\n');
            process.nextTick(() => this.destroy(new Error('connection reset')));
          },
        });
        return readable as unknown as ReturnType<AuditExportResult['openReadStream']>;
      },
      cleanup: jest.fn().mockImplementation(async () => {
        await fsp.rm(tempDir, { recursive: true, force: true });
      }),
    };
    jest.spyOn(service, 'exportAuditLogs').mockResolvedValue(mockResult);

    const app = express();
    app.use(express.json());
    app.use(requestIdMiddleware);
    app.use((req, _res, next) => {
      (req as unknown as { user?: { id: string } }).user = { id: 'user-1' };
      next();
    });
    app.use(
      '/api/v1/audit',
      createAuditRouter({
        service,
        exportService: new AuditExportService(service),
        downloadTokenService: tokenSvc,
        accessMiddleware: [],
        exportMiddleware: [],
      }),
    );

    const token = tokenSvc.issue({ requesterId: 'user-1', tenantId: 'user-1', artifactId: 'x.ndjson' });

    try {
      await request(app)
        .get(`/api/v1/audit/export/download/${token}`)
        .set('x-test-user-id', 'user-1');
    } catch {
      // Transport-level abort is expected.
    }

    // Streaming began, so the token is spent — replay must fail.
    expect(() => tokenSvc.consume(token, 'user-1')).toThrow(
      expect.objectContaining({ code: 'token_reused' }),
    );

    db.close();
  });

  it('lets exactly one of two concurrent downloads win', async () => {
    const { app } = setup();
    const token = await issueToken(app);

    const [a, b] = await Promise.all([
      request(app)
        .get(`/api/v1/audit/export/download/${token}`)
        .set('x-test-user-id', 'user-1'),
      request(app)
        .get(`/api/v1/audit/export/download/${token}`)
        .set('x-test-user-id', 'user-1'),
    ]);

    const statuses = [a.status, b.status].sort((x, y) => x - y);
    expect(statuses).toEqual([200, 410]);

    const loser = a.status === 410 ? a : b;
    expect(loser.body.error.code).toBe('token_reused');
  });
});

// ─── 4. Cleanup is best-effort but observable ───────────────────────────────

describe('recovery — cleanup failures are contained', () => {
  it('still returns 200 when temp-file cleanup rejects, and logs a warning', async () => {
    const { app, service } = setup();
    const token = await issueToken(app);
    logRecords = [];

    const tempDir = path.join(tmpdir(), `tt-recovery-cleanup-${Date.now()}`);
    await fsp.mkdir(tempDir, { recursive: true });
    const filePath = path.join(tempDir, 'cleanup.ndjson');
    await fsp.writeFile(filePath, '{"id":"1"}\n');

    const result: AuditExportResult = {
      filePath,
      fileName: 'cleanup.ndjson',
      bytesWritten: 11,
      recordCount: 1,
      openReadStream: () => createReadStream(filePath),
      cleanup: jest.fn().mockRejectedValue(new Error('EBUSY: /srv/exports/locked')),
    };
    jest.spyOn(service, 'exportAuditLogs').mockResolvedValue(result);

    const res = await request(app)
      .get(`/api/v1/audit/export/download/${token}`)
      .set('x-test-user-id', 'user-1');

    expect(res.status).toBe(200);

    await flush();

    const warn = logRecords.find((r) => r.message === 'Audit export cleanup failed');
    expect(warn).toBeDefined();
    expect(warn).toMatchObject({ level: 'warn', route: 'GET /export/download/:token' });
    expect(JSON.stringify(logRecords)).not.toContain('/srv/exports');

    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  it('does not turn a successful token issuance into an error when cleanup fails', async () => {
    const { app, service } = setup();

    const result: AuditExportResult = {
      filePath: path.join(tmpdir(), 'issued.ndjson'),
      fileName: 'issued.ndjson',
      bytesWritten: 0,
      recordCount: 0,
      openReadStream: () => {
        throw new Error('not needed');
      },
      cleanup: jest.fn().mockRejectedValue(new Error('EACCES')),
    };
    jest.spyOn(service, 'exportAuditLogs').mockResolvedValue(result);

    const res = await request(app)
      .post('/api/v1/audit/export/token')
      .set('x-test-user-id', 'user-1');

    expect(res.status).toBe(201);
    expect(typeof res.body.token).toBe('string');

    await flush();
    expect(logRecords.some((r) => r.message === 'Audit export cleanup failed')).toBe(true);
  });
});
