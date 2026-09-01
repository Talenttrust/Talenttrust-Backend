/**
 * @file overrideRequest.routes.test.ts
 * @description Integration tests for the override requests HTTP API.
 *
 * Tests run against a real Express app with an in-memory SQLite database,
 * so every layer (router → service → repository → SQLite) is exercised.
 *
 * Edge cases tested:
 *  - Unauthenticated access → 401
 *  - Insufficient role → 403
 *  - Request by operator (201 with requested status)
 *  - Self-approval → 403
 *  - Expired request → 409
 *  - Rejected request → 409 on further transitions
 *  - Apply twice → 409
 *  - Full happy path: create → approve → apply
 *  - Validation errors → 400
 */

process.env.JWT_SECRET = 'talenttrust-test-secret';

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db/migrations';
import { createOverrideRequestsRouter } from '../overrideRequests/overrideRequest.routes';
import { OverrideRequestService } from '../overrideRequests/overrideRequest.service';
import { AuditService } from '../../audit/service';
import { createDefaultAuditRepository } from '../../audit/repository';
import { requestIdMiddleware } from '../../middleware/requestId';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SECRET = process.env.JWT_SECRET!;

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function adminToken(id = 'admin-user-001'): string {
  return jwt.sign({ sub: id, email: `${id}@test.com`, role: 'admin' }, SECRET, { expiresIn: '1h' });
}

function auditorToken(id = 'auditor-user-001'): string {
  return jwt.sign({ sub: id, email: `${id}@test.com`, role: 'auditor' }, SECRET, { expiresIn: '1h' });
}

function clientToken(id = 'client-user-001'): string {
  return jwt.sign({ sub: id, email: `${id}@test.com`, role: 'client' }, SECRET, { expiresIn: '1h' });
}

function bearer(token: string) {
  return { Authorization: `Bearer ${token}` };
}

function makeApp(db: Database.Database): express.Application {
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  const auditSvc = new AuditService(createDefaultAuditRepository());
  const service = new OverrideRequestService(db, auditSvc);
  app.use('/api/v1/override-requests', createOverrideRequestsRouter(service));
  return app;
}

const validBody = {
  resourceType: 'contract',
  resourceId: 'contract-abc-123',
  action: 'force_release',
  reason: 'Emergency release required due to client emergency circumstances',
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Override Requests API', () => {
  let db: Database.Database;
  let app: express.Application;
  const ADMIN_ID = 'admin-user-001';
  const ADMIN2_ID = 'admin-user-002';

  // Helper: create an override request via HTTP
  async function httpCreate(
    tokenId = ADMIN_ID,
    body = validBody,
  ): Promise<request.Response> {
    return request(app)
      .post('/api/v1/override-requests')
      .set(bearer(adminToken(tokenId)))
      .send(body);
  }

  beforeEach(() => {
    db = makeDb();
    app = makeApp(db);
  });

  afterEach(() => {
    db.close();
  });

  // ── Authentication ──────────────────────────────────────────────────────────

  describe('authentication', () => {
    it('returns 401 on GET / without a token', async () => {
      const res = await request(app).get('/api/v1/override-requests');
      expect(res.status).toBe(401);
    });

    it('returns 401 on POST / without a token', async () => {
      const res = await request(app).post('/api/v1/override-requests').send(validBody);
      expect(res.status).toBe(401);
    });

    it('returns 401 on GET /:id without a token', async () => {
      const res = await request(app).get('/api/v1/override-requests/nonexistent');
      expect(res.status).toBe(401);
    });
  });

  // ── Authorization ───────────────────────────────────────────────────────────

  describe('role-based authorization', () => {
    it('returns 403 when a non-admin tries to approve', async () => {
      const created = await httpCreate();
      const id = created.body.data.id;

      const res = await request(app)
        .post(`/api/v1/override-requests/${id}/approve`)
        .set(bearer(clientToken()));
      expect(res.status).toBe(403);
    });

    it('returns 403 when a non-admin tries to reject', async () => {
      const created = await httpCreate();
      const id = created.body.data.id;

      const res = await request(app)
        .post(`/api/v1/override-requests/${id}/reject`)
        .set(bearer(clientToken()));
      expect(res.status).toBe(403);
    });

    it('returns 403 when a non-admin tries to apply', async () => {
      const created = await httpCreate();
      const id = created.body.data.id;

      const res = await request(app)
        .post(`/api/v1/override-requests/${id}/apply`)
        .set(bearer(clientToken()));
      expect(res.status).toBe(403);
    });

    it('returns 403 when a non-admin/auditor tries to list', async () => {
      const res = await request(app)
        .get('/api/v1/override-requests')
        .set(bearer(clientToken()));
      expect(res.status).toBe(403);
    });

    it('allows auditor to list override requests', async () => {
      await httpCreate();
      const res = await request(app)
        .get('/api/v1/override-requests')
        .set(bearer(auditorToken()));
      expect(res.status).toBe(200);
    });
  });

  // ── Edge case: request by operator ─────────────────────────────────────────

  describe('POST / — create (request by operator)', () => {
    it('creates a request in the requested state (201)', async () => {
      const res = await httpCreate();

      expect(res.status).toBe(201);
      expect(res.body.data.status).toBe('requested');
      expect(res.body.data.requesterId).toBe(ADMIN_ID);
      expect(res.body.data.approverId).toBeNull();
    });

    it('returns 400 when reason is too short', async () => {
      const res = await httpCreate(ADMIN_ID, { ...validBody, reason: 'short' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('validation_error');
    });

    it('returns 400 when required fields are missing', async () => {
      const res = await request(app)
        .post('/api/v1/override-requests')
        .set(bearer(adminToken()))
        .send({ reason: 'Only reason no other fields given here' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('validation_error');
    });
  });

  // ── Full happy path ─────────────────────────────────────────────────────────

  describe('happy path: create → approve → apply', () => {
    it('returns 200 on each step and transitions state correctly', async () => {
      // Create
      const created = await httpCreate(ADMIN_ID);
      expect(created.status).toBe(201);
      const id = created.body.data.id;

      // Approve (different admin)
      const approved = await request(app)
        .post(`/api/v1/override-requests/${id}/approve`)
        .set(bearer(adminToken(ADMIN2_ID)));
      expect(approved.status).toBe(200);
      expect(approved.body.data.status).toBe('approved');
      expect(approved.body.data.approverId).toBe(ADMIN2_ID);

      // Apply
      const applied = await request(app)
        .post(`/api/v1/override-requests/${id}/apply`)
        .set(bearer(adminToken(ADMIN2_ID)));
      expect(applied.status).toBe(200);
      expect(applied.body.data.status).toBe('applied');
      expect(applied.body.data.appliedAt).toBeTruthy();
    });
  });

  // ── Edge case: self-approval ────────────────────────────────────────────────

  describe('self-approval prevention', () => {
    it('returns 403 when the requester tries to approve their own request', async () => {
      const created = await httpCreate(ADMIN_ID);
      const id = created.body.data.id;

      // Same admin attempts to approve
      const res = await request(app)
        .post(`/api/v1/override-requests/${id}/approve`)
        .set(bearer(adminToken(ADMIN_ID)));

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('forbidden');
      expect(res.body.error.message).toMatch(/self-approval/i);
    });
  });

  // ── Edge case: expired request ──────────────────────────────────────────────

  describe('expired request', () => {
    it('returns 409 when trying to approve an expired request', async () => {
      const created = await httpCreate(ADMIN_ID);
      const id = created.body.data.id;

      // Force past expiry in the DB
      db.prepare(
        `UPDATE override_requests SET expires_at = ? WHERE id = ?`,
      ).run('2000-01-01T00:00:00.000Z', id);

      const res = await request(app)
        .post(`/api/v1/override-requests/${id}/approve`)
        .set(bearer(adminToken(ADMIN2_ID)));

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('conflict');
      expect(res.body.error.message).toMatch(/expired/i);
    });

    it('returns the expired status on GET when TTL has elapsed', async () => {
      const created = await httpCreate(ADMIN_ID);
      const id = created.body.data.id;

      db.prepare(
        `UPDATE override_requests SET expires_at = ? WHERE id = ?`,
      ).run('2000-01-01T00:00:00.000Z', id);

      const res = await request(app)
        .get(`/api/v1/override-requests/${id}`)
        .set(bearer(adminToken(ADMIN_ID)));

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('expired');
    });
  });

  // ── Edge case: rejected request ─────────────────────────────────────────────

  describe('rejected request', () => {
    it('returns 200 and rejected status when request is rejected', async () => {
      const created = await httpCreate(ADMIN_ID);
      const id = created.body.data.id;

      const res = await request(app)
        .post(`/api/v1/override-requests/${id}/reject`)
        .set(bearer(adminToken(ADMIN2_ID)))
        .send({ rejectionReason: 'Not justified per policy' });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('rejected');
    });

    it('returns 409 when trying to approve a rejected request', async () => {
      const created = await httpCreate(ADMIN_ID);
      const id = created.body.data.id;

      await request(app)
        .post(`/api/v1/override-requests/${id}/reject`)
        .set(bearer(adminToken(ADMIN2_ID)));

      const res = await request(app)
        .post(`/api/v1/override-requests/${id}/approve`)
        .set(bearer(adminToken(ADMIN2_ID)));

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('conflict');
    });

    it('returns 409 when trying to apply a rejected request', async () => {
      const created = await httpCreate(ADMIN_ID);
      const id = created.body.data.id;

      await request(app)
        .post(`/api/v1/override-requests/${id}/reject`)
        .set(bearer(adminToken(ADMIN2_ID)));

      const res = await request(app)
        .post(`/api/v1/override-requests/${id}/apply`)
        .set(bearer(adminToken(ADMIN2_ID)));

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('conflict');
    });
  });

  // ── Edge case: apply twice ───────────────────────────────────────────────────

  describe('apply twice', () => {
    it('returns 409 on a second apply attempt', async () => {
      const created = await httpCreate(ADMIN_ID);
      const id = created.body.data.id;

      await request(app)
        .post(`/api/v1/override-requests/${id}/approve`)
        .set(bearer(adminToken(ADMIN2_ID)));

      await request(app)
        .post(`/api/v1/override-requests/${id}/apply`)
        .set(bearer(adminToken(ADMIN2_ID)));

      const second = await request(app)
        .post(`/api/v1/override-requests/${id}/apply`)
        .set(bearer(adminToken(ADMIN2_ID)));

      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe('conflict');
      expect(second.body.error.message).toMatch(/already been applied/i);
    });
  });

  // ── Not found ───────────────────────────────────────────────────────────────

  describe('not found', () => {
    it('returns 404 when request does not exist', async () => {
      const res = await request(app)
        .get('/api/v1/override-requests/nonexistent-id')
        .set(bearer(adminToken()));

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('not_found');
    });
  });

  // ── List ────────────────────────────────────────────────────────────────────

  describe('GET / — list', () => {
    it('lists created override requests', async () => {
      await httpCreate(ADMIN_ID);
      await httpCreate(ADMIN_ID, { ...validBody, resourceId: 'resource-2' });

      const res = await request(app)
        .get('/api/v1/override-requests')
        .set(bearer(adminToken(ADMIN_ID)));

      expect(res.status).toBe(200);
      expect(res.body.data.total).toBeGreaterThanOrEqual(2);
    });

    it('filters by status query param', async () => {
      const created = await httpCreate(ADMIN_ID);
      await httpCreate(ADMIN_ID, { ...validBody, resourceId: 'r2' });
      const id = created.body.data.id;

      await request(app)
        .post(`/api/v1/override-requests/${id}/approve`)
        .set(bearer(adminToken(ADMIN2_ID)));

      const res = await request(app)
        .get('/api/v1/override-requests?status=approved')
        .set(bearer(adminToken(ADMIN_ID)));

      expect(res.status).toBe(200);
      expect(res.body.data.items.every((i: { status: string }) => i.status === 'approved')).toBe(true);
    });
  });

  // ── Error envelope ───────────────────────────────────────────────────────────

  describe('error envelope', () => {
    it('always includes requestId in error responses', async () => {
      const res = await request(app)
        .get('/api/v1/override-requests/nonexistent')
        .set(bearer(adminToken()));

      expect(res.status).toBe(404);
      expect(res.body.error.requestId).toBeDefined();
    });

    it('does not leak stack traces in error responses', async () => {
      const res = await request(app)
        .get('/api/v1/override-requests/nonexistent')
        .set(bearer(adminToken()));

      const body = JSON.stringify(res.body);
      expect(body).not.toMatch(/at \w+ \(/); // No stack frames
      expect(body).not.toMatch(/node_modules/);
    });
  });
});
