/**
 * @file disputes.edgecases.test.ts
 * @description Regression tests for previously-fixed disputes edge cases
 * (empty / boundary / malformed inputs) so they cannot silently regress.
 *
 * Unlike disputes.routes.test.ts (which mocks authorization to isolate
 * rate-limiting behaviour), these tests exercise the REAL requireAuth /
 * requirePermission middleware against real JWTs so that RBAC edge cases
 * on the disputes resource are actually covered.
 */

import express, { type Request, type Response } from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const TEST_SECRET = 'disputes-edgecase-test-secret';
process.env.JWT_SECRET = TEST_SECRET;

import disputesRouter from './disputes.routes';

function token(role: string, sub = 'user-1', overrides: Record<string, unknown> = {}) {
  return jwt.sign({ sub, email: `${sub}@example.com`, role, ...overrides }, TEST_SECRET, {
    algorithm: 'HS256',
  });
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((_req: Request, _res: Response, next) => next());
  app.use('/api/v1/disputes', disputesRouter);
  return app;
}

let ipCounter = 100;
/** Unique IP per request so the disputes rate limiter never interferes. */
function nextIp() {
  ipCounter += 1;
  return `50.0.${Math.floor(ipCounter / 250)}.${ipCounter % 250}`;
}

describe('Disputes endpoints — edge case regressions', () => {
  // ── Empty input edge cases ─────────────────────────────────────────────

  describe('empty inputs', () => {
    it('POST /api/v1/disputes with an empty body still creates a dispute stub (empty payload)', async () => {
      const app = buildApp();
      const res = await request(app)
        .post('/api/v1/disputes')
        .set('Authorization', `Bearer ${token('client')}`)
        .set('X-Forwarded-For', nextIp())
        .send({});
      expect(res.status).toBe(201);
      expect(res.body.dispute).toMatchObject({ status: 'open' });
    });

    it('POST /api/v1/disputes with no body at all does not crash (missing body edge case)', async () => {
      const app = buildApp();
      const res = await request(app)
        .post('/api/v1/disputes')
        .set('Authorization', `Bearer ${token('client')}`)
        .set('X-Forwarded-For', nextIp())
        .set('Content-Type', 'application/json');
      expect(res.status).toBe(201);
    });

    it('GET /api/v1/disputes/:id with an empty id segment falls through to list route (empty id edge case)', async () => {
      const app = buildApp();
      // '//' collapses to the list route in Express, not `:id` with ''.
      const res = await request(app)
        .get('/api/v1/disputes/')
        .set('Authorization', `Bearer ${token('admin')}`)
        .set('X-Forwarded-For', nextIp());
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ disputes: [], total: 0 });
    });
  });

  // ── Boundary edge cases ─────────────────────────────────────────────────

  describe('boundary inputs', () => {
    it('GET /api/v1/disputes/:id accepts a maximally long id without truncation (boundary length id)', async () => {
      const app = buildApp();
      const longId = 'd'.repeat(2048);
      const res = await request(app)
        .get(`/api/v1/disputes/${longId}`)
        .set('Authorization', `Bearer ${token('admin')}`)
        .set('X-Forwarded-For', nextIp());
      expect(res.status).toBe(200);
      expect(res.body.dispute.id).toBe(longId);
    });

    it('PATCH /api/v1/disputes/:id accepts a single-character id (minimum boundary id)', async () => {
      const app = buildApp();
      const res = await request(app)
        .patch('/api/v1/disputes/a')
        .set('Authorization', `Bearer ${token('admin')}`)
        .set('X-Forwarded-For', nextIp())
        .send({ status: 'resolved' });
      expect(res.status).toBe(200);
      expect(res.body.dispute.id).toBe('a');
    });

    it('DELETE /api/v1/disputes/:id is idempotent when called twice for the same id (boundary repeat-delete)', async () => {
      const app = buildApp();
      const id = 'dispute-boundary-1';
      const first = await request(app)
        .delete(`/api/v1/disputes/${id}`)
        .set('Authorization', `Bearer ${token('admin')}`)
        .set('X-Forwarded-For', nextIp());
      const second = await request(app)
        .delete(`/api/v1/disputes/${id}`)
        .set('Authorization', `Bearer ${token('admin')}`)
        .set('X-Forwarded-For', nextIp());
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
    });
  });

  // ── Malformed input edge cases ──────────────────────────────────────────

  describe('malformed inputs', () => {
    it('POST /api/v1/disputes with malformed JSON returns a 400, not a 500 (malformed body edge case)', async () => {
      const app = buildApp();
      const res = await request(app)
        .post('/api/v1/disputes')
        .set('Authorization', `Bearer ${token('client')}`)
        .set('X-Forwarded-For', nextIp())
        .set('Content-Type', 'application/json')
        .send('{ this is not valid json');
      expect(res.status).toBe(400);
    });

    it('rejects a malformed Authorization header with 401 (missing Bearer prefix)', async () => {
      const app = buildApp();
      const res = await request(app)
        .get('/api/v1/disputes')
        .set('Authorization', token('admin'))
        .set('X-Forwarded-For', nextIp());
      expect(res.status).toBe(401);
    });

    it('rejects a JWT carrying an unrecognised role (malformed role claim)', async () => {
      const app = buildApp();
      const res = await request(app)
        .get('/api/v1/disputes')
        .set('Authorization', `Bearer ${token('super-admin')}`)
        .set('X-Forwarded-For', nextIp());
      expect(res.status).toBe(401);
    });

    it('rejects a JWT missing the sub claim (malformed token payload)', async () => {
      const app = buildApp();
      const malformed = jwt.sign({ email: 'x@example.com', role: 'admin' }, TEST_SECRET, {
        algorithm: 'HS256',
      });
      const res = await request(app)
        .get('/api/v1/disputes')
        .set('Authorization', `Bearer ${malformed}`)
        .set('X-Forwarded-For', nextIp());
      expect(res.status).toBe(401);
    });
  });

  // ── RBAC edge cases on the disputes resource ────────────────────────────

  describe('RBAC — role matrix on disputes resource', () => {
    it('auditor is denied POST /api/v1/disputes (create not permitted for auditor)', async () => {
      const app = buildApp();
      const res = await request(app)
        .post('/api/v1/disputes')
        .set('Authorization', `Bearer ${token('auditor')}`)
        .set('X-Forwarded-For', nextIp())
        .send({ reason: 'test' });
      expect(res.status).toBe(403);
    });

    it('freelancer is denied DELETE /api/v1/disputes/:id (delete is admin-only)', async () => {
      const app = buildApp();
      const res = await request(app)
        .delete('/api/v1/disputes/dispute-1')
        .set('Authorization', `Bearer ${token('freelancer')}`)
        .set('X-Forwarded-For', nextIp());
      expect(res.status).toBe(403);
    });

    it('freelancer is denied PATCH /api/v1/disputes/:id (update is not freelancer-permitted)', async () => {
      const app = buildApp();
      const res = await request(app)
        .patch('/api/v1/disputes/dispute-1')
        .set('Authorization', `Bearer ${token('freelancer')}`)
        .set('X-Forwarded-For', nextIp())
        .send({ status: 'resolved' });
      expect(res.status).toBe(403);
    });

    // KNOWN BROKEN CASE (documented, not silently accepted):
    // The `disputes` permission matrix grants `client`/`freelancer` OWN-only
    // access to list/read/update, but disputes.routes.ts never supplies a
    // `getResourceOwnerId` resolver to `requirePermission`. Per
    // isAuthorized()'s deny-by-default rule for ownOnly cells ("no
    // resourceOwnerId supplied -> denied"), this means client/freelancer are
    // ALWAYS denied on GET /disputes, GET /disputes/:id and PATCH
    // /disputes/:id even for their own disputes. This test locks in the
    // current (broken) behaviour so a future fix is a deliberate, visible
    // change rather than a silent regression.
    it('client is unexpectedly denied GET /api/v1/disputes/:id due to missing owner resolution (known broken case)', async () => {
      const app = buildApp();
      const res = await request(app)
        .get('/api/v1/disputes/dispute-1')
        .set('Authorization', `Bearer ${token('client')}`)
        .set('X-Forwarded-For', nextIp());
      expect(res.status).toBe(403);
    });

    it('client is unexpectedly denied GET /api/v1/disputes (list) due to missing owner resolution (known broken case)', async () => {
      const app = buildApp();
      const res = await request(app)
        .get('/api/v1/disputes')
        .set('Authorization', `Bearer ${token('client')}`)
        .set('X-Forwarded-For', nextIp());
      expect(res.status).toBe(403);
    });

    it('admin bypasses ownership checks entirely on every disputes route (admin exemption)', async () => {
      const app = buildApp();
      const ip = nextIp();
      const list = await request(app)
        .get('/api/v1/disputes')
        .set('Authorization', `Bearer ${token('admin')}`)
        .set('X-Forwarded-For', ip);
      const read = await request(app)
        .get('/api/v1/disputes/dispute-1')
        .set('Authorization', `Bearer ${token('admin')}`)
        .set('X-Forwarded-For', ip);
      const update = await request(app)
        .patch('/api/v1/disputes/dispute-1')
        .set('Authorization', `Bearer ${token('admin')}`)
        .set('X-Forwarded-For', ip)
        .send({ status: 'resolved' });
      const del = await request(app)
        .delete('/api/v1/disputes/dispute-1')
        .set('Authorization', `Bearer ${token('admin')}`)
        .set('X-Forwarded-For', ip);
      expect([list.status, read.status, update.status, del.status]).toEqual([200, 200, 200, 200]);
    });
  });
});
