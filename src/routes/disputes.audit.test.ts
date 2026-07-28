/**
 * @file disputes.audit.test.ts
 * @description Comprehensive tests for audit logging on disputes mutations.
 *
 * Coverage targets:
 * - POST  /api/v1/disputes → audit entry with DISPUTE_CREATED
 * - PATCH /api/v1/disputes/:id → audit entry with DISPUTE_UPDATED + before/after
 * - DELETE /api/v1/disputes/:id → audit entry with DISPUTE_DELETED + before state
 * - GET   /api/v1/disputes → does NOT generate audit entries (read-only)
 * - GET   /api/v1/disputes/:id → does NOT generate audit entries (read-only)
 * - Actor resolved from req.user.userId when authenticated
 * - Sensitive fields in request body are redacted from audit metadata
 * - 404 for non-existent dispute does NOT generate mutation audit entry
 * - Redaction: apiKey, secret, token, credential, password masked in metadata
 * - Redaction: email addresses partially masked in metadata
 */

import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { auditStore } from '../audit/store';
import { REDACTED } from '../audit/redact';

// ── Mock auth middleware — applied BEFORE we import the router ────────────
jest.mock('../middleware/authorization', () => ({
  requireAuth: (_req: Request, _res: Response, next: NextFunction) => next(),
  requirePermission: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));

// Import the actual disputes router AFTER mocks are registered
import disputesRouter from './disputes.routes';

// ── Helpers ───────────────────────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/disputes', disputesRouter);
  return app;
}

function getAuditEntries() {
  return auditStore.getAll();
}

describe('Disputes — mutation audit logging', () => {
  let app: express.Application;

  beforeEach(() => {
    auditStore._reset();
    app = buildApp();
  });

  afterEach(() => {
    auditStore._reset();
  });

  // ── POST — create ─────────────────────────────────────────────────────

  describe('POST /api/v1/disputes', () => {
    it('emits a DISPUTE_CREATED audit entry on successful creation', async () => {
      const res = await request(app)
        .post('/api/v1/disputes')
        .send({ reason: 'Work not delivered', amount: 500, currency: 'USD' })
        .expect(201);

      const dispute = res.body.dispute;
      const entries = getAuditEntries();
      expect(entries).toHaveLength(1);

      const entry = entries[0];
      expect(entry.action).toBe('DISPUTE_CREATED');
      expect(entry.severity).toBe('INFO');
      expect(entry.resource).toBe('dispute');
      expect(entry.resourceId).toBe(dispute.id);
      expect(entry.metadata).toHaveProperty('after');
    });

    it('records the authenticated actor from req.user', async () => {
      const appWithUser = express();
      appWithUser.use(express.json());
      appWithUser.use((req, _res, next) => {
        (req as any).user = { userId: 'user-99', role: 'client' };
        next();
      });
      appWithUser.use('/api/v1/disputes', disputesRouter);

      await request(appWithUser)
        .post('/api/v1/disputes')
        .send({ reason: 'Defective work' })
        .expect(201);

      const entries = getAuditEntries();
      expect(entries[0].actor).toBe('user-99');
    });

    it('uses "anonymous" as actor when req.user is absent', async () => {
      await request(app)
        .post('/api/v1/disputes')
        .send({ reason: 'Testing' })
        .expect(201);

      const entries = getAuditEntries();
      expect(entries[0].actor).toBe('anonymous');
    });

    it('redacts sensitive fields (apiKey, secret) from audit metadata', async () => {
      await request(app)
        .post('/api/v1/disputes')
        .send({
          reason: 'Dispute reason',
          apiKey: 'sk-1234567890abcdef',
          secretKey: 'my-secret-value',
        })
        .expect(201);

      const entries = getAuditEntries();
      const metadata = entries[0].metadata as Record<string, unknown>;
      const requestBody = metadata['requestBody'] as Record<string, unknown>;
      expect(requestBody['apiKey']).toBe(REDACTED);
      expect(requestBody['secretKey']).toBe(REDACTED);
      expect(requestBody['reason']).toBe('Dispute reason');
    });
  });

  // ── PATCH — update ────────────────────────────────────────────────────

  describe('PATCH /api/v1/disputes/:id', () => {
    it('emits a DISPUTE_UPDATED audit entry with before/after summary', async () => {
      const createRes = await request(app)
        .post('/api/v1/disputes')
        .send({ reason: 'Original reason', amount: 300 })
        .expect(201);
      const disputeId = createRes.body.dispute.id;

      // Clear the create audit entry so we only see the update
      auditStore._reset();

      await request(app)
        .patch(`/api/v1/disputes/${disputeId}`)
        .send({ reason: 'Updated reason', amount: 500 })
        .expect(200);

      const entries = getAuditEntries();
      expect(entries).toHaveLength(1);

      const entry = entries[0];
      expect(entry.action).toBe('DISPUTE_UPDATED');
      expect(entry.severity).toBe('WARNING');
      expect(entry.resource).toBe('dispute');
      expect(entry.resourceId).toBe(disputeId);

      const metadata = entry.metadata as Record<string, unknown>;
      expect(metadata).toHaveProperty('before');
      expect(metadata).toHaveProperty('after');
      expect(metadata).toHaveProperty('changes');
    });

    it('includes before and after state in audit metadata', async () => {
      const createRes = await request(app)
        .post('/api/v1/disputes')
        .send({ reason: 'Initial reason', amount: 100, status: 'open' })
        .expect(201);
      const disputeId = createRes.body.dispute.id;

      auditStore._reset();

      await request(app)
        .patch(`/api/v1/disputes/${disputeId}`)
        .send({ status: 'resolved', amount: 200 })
        .expect(200);

      const metadata = getAuditEntries()[0].metadata as Record<string, unknown>;
      const before = metadata['before'] as Record<string, unknown>;
      const after = metadata['after'] as Record<string, unknown>;

      expect(before['status']).toBe('open');
      expect(before['amount']).toBe(100);
      expect(after['status']).toBe('resolved');
      expect(after['amount']).toBe(200);
    });

    it('returns 404 and does NOT emit mutation audit entry when dispute does not exist', async () => {
      await request(app)
        .patch('/api/v1/disputes/non-existent-id')
        .send({ reason: 'Anything' })
        .expect(404);

      expect(getAuditEntries()).toHaveLength(0);
    });
  });

  // ── DELETE — delete ───────────────────────────────────────────────────

  describe('DELETE /api/v1/disputes/:id', () => {
    it('emits a DISPUTE_DELETED audit entry with the deleted state', async () => {
      const createRes = await request(app)
        .post('/api/v1/disputes')
        .send({ reason: 'To be deleted', amount: 250 })
        .expect(201);
      const disputeId = createRes.body.dispute.id;

      auditStore._reset();

      await request(app)
        .delete(`/api/v1/disputes/${disputeId}`)
        .expect(200);

      const entries = getAuditEntries();
      expect(entries).toHaveLength(1);

      const entry = entries[0];
      expect(entry.action).toBe('DISPUTE_DELETED');
      expect(entry.severity).toBe('INFO');
      expect(entry.resource).toBe('dispute');
      expect(entry.resourceId).toBe(disputeId);

      const metadata = entry.metadata as Record<string, unknown>;
      expect(metadata).toHaveProperty('before');

      const before = metadata['before'] as Record<string, unknown>;
      expect(before['reason']).toBe('To be deleted');
      expect(before['amount']).toBe(250);
    });

    it('returns 404 and does NOT emit mutation audit entry when dispute does not exist', async () => {
      await request(app)
        .delete('/api/v1/disputes/non-existent-id')
        .expect(404);

      expect(getAuditEntries()).toHaveLength(0);
    });
  });

  // ── GET — read routes do NOT emit audit entries ───────────────────────

  describe('GET /api/v1/disputes (read-only — no audit entry)', () => {
    it('does NOT emit an audit entry when listing disputes', async () => {
      await request(app)
        .get('/api/v1/disputes')
        .expect(200);

      expect(getAuditEntries()).toHaveLength(0);
    });

    it('does NOT emit an audit entry when fetching a single dispute', async () => {
      const createRes = await request(app)
        .post('/api/v1/disputes')
        .send({ reason: 'Test' })
        .expect(201);
      const disputeId = createRes.body.dispute.id;

      auditStore._reset();

      await request(app)
        .get(`/api/v1/disputes/${disputeId}`)
        .expect(200);

      expect(getAuditEntries()).toHaveLength(0);
    });

    it('returns 404 for non-existent dispute without audit entry', async () => {
      await request(app)
        .get('/api/v1/disputes/non-existent')
        .expect(404);

      expect(getAuditEntries()).toHaveLength(0);
    });
  });

  // ── Redaction edge cases ──────────────────────────────────────────────

  describe('redaction — sensitive fields in dispute audit metadata', () => {
    it('redacts "token" and "credential" fields from metadata', async () => {
      await request(app)
        .post('/api/v1/disputes')
        .send({
          reason: 'Test',
          token: 'my-jwt-token',
          credential: 'super-secret-cred',
        })
        .expect(201);

      const body = (getAuditEntries()[0].metadata as Record<string, unknown>)['requestBody'] as Record<string, unknown>;
      expect(body['token']).toBe(REDACTED);
      expect(body['credential']).toBe(REDACTED);
    });

    it('redacts "password" fields from metadata', async () => {
      await request(app)
        .post('/api/v1/disputes')
        .send({
          reason: 'Test',
          password: 'hunter2',
        })
        .expect(201);

      const body = (getAuditEntries()[0].metadata as Record<string, unknown>)['requestBody'] as Record<string, unknown>;
      expect(body['password']).toBe(REDACTED);
    });

    it('partially masks email addresses in metadata', async () => {
      await request(app)
        .post('/api/v1/disputes')
        .send({
          reason: 'Test',
          contactEmail: 'alice@example.com',
        })
        .expect(201);

      const body = (getAuditEntries()[0].metadata as Record<string, unknown>)['requestBody'] as Record<string, unknown>;
      expect(body['contactEmail']).toBe('ali***@example.com');
    });

    it('does NOT mutate non-sensitive dispute metadata', async () => {
      await request(app)
        .post('/api/v1/disputes')
        .send({
          reason: 'Valid dispute reason',
          amount: 1500,
          currency: 'USD',
        })
        .expect(201);

      const body = (getAuditEntries()[0].metadata as Record<string, unknown>)['requestBody'] as Record<string, unknown>;
      expect(body['reason']).toBe('Valid dispute reason');
      expect(body['amount']).toBe(1500);
      expect(body['currency']).toBe('USD');
    });
  });
});
