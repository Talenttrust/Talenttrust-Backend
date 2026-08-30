/**
 * @file disputes.routes.test.ts
 * @description Route-level tests for legal dispute transition enforcement
 * (#1215): the PATCH endpoint validates transitions through the service
 * layer's centralized matrix, requires auth, and surfaces the same business
 * rules (evidence, close-twice, optimistic concurrency) as the service.
 */

process.env.JWT_SECRET = 'talenttrust-test-secret';

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createDisputesRouter } from './disputes.routes';
import { disputesService } from '../services/disputes.service';
import { requestIdMiddleware } from '../middleware/requestId';

const SECRET = process.env.JWT_SECRET;

function adminToken(): string {
  return jwt.sign({ sub: 'admin-1', email: 'admin-1@test.com', role: 'admin' }, SECRET, { expiresIn: '1h' });
}

function clientToken(id = 'client-1'): string {
  return jwt.sign({ sub: id, email: `${id}@test.com`, role: 'client' }, SECRET, { expiresIn: '1h' });
}

function makeApp() {
  const app = express();
  app.use(express.json());
  // Mirrors app.ts: requestIdMiddleware seeds res.locals.log used by the
  // disputes observability middleware.
  app.use(requestIdMiddleware);
  app.use('/api/v1/disputes', createDisputesRouter({}));
  return app;
}

function bearer(token: string) {
  return { Authorization: `Bearer ${token}` };
}

const UUID = '550e8400-e29b-41d4-a716-446655440000';

describe('Disputes API — transition enforcement', () => {
  let app: express.Application;

  beforeEach(() => {
    disputesService.clearStore();
    app = makeApp();
  });

  afterEach(() => {
    disputesService.clearStore();
  });

  it('requires authentication on every route', async () => {
    const noAuth = await request(app).get('/api/v1/disputes');
    expect(noAuth.status).toBe(401);

    const noAuthPatch = await request(app).patch(`/api/v1/disputes/${UUID}`).send({ status: 'resolved' });
    expect(noAuthPatch.status).toBe(401);
  });

  it('creates a dispute in the open state and lists it', async () => {
    const created = await request(app)
      .post('/api/v1/disputes')
      .set(bearer(adminToken()))
      .send({ contractId: UUID, reason: 'payment dispute' });
    expect(created.status).toBe(201);
    expect(created.body.data.status).toBe('open');

    const list = await request(app).get('/api/v1/disputes').set(bearer(adminToken()));
    expect(list.status).toBe(200);
    expect(list.body.data.total).toBe(1);
  });

  it('rejects a duplicate open for the same contract (409)', async () => {
    await request(app)
      .post('/api/v1/disputes')
      .set(bearer(adminToken()))
      .send({ contractId: UUID, reason: 'first' });

    const second = await request(app)
      .post('/api/v1/disputes')
      .set(bearer(adminToken()))
      .send({ contractId: UUID, reason: 'second' });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('dispute_already_open');
  });

  it('rejects resolving without evidence (400 resolution_required)', async () => {
    const created = await request(app)
      .post('/api/v1/disputes')
      .set(bearer(adminToken()))
      .send({ contractId: UUID, reason: 'r' });
    const id = created.body.data.id;

    const resolve = await request(app)
      .patch(`/api/v1/disputes/${id}`)
      .set(bearer(adminToken()))
      .send({ status: 'resolved' });
    expect(resolve.status).toBe(400);
    expect(resolve.body.error.code).toBe('resolution_required');
  });

  it('rejects illegal transitions (400 invalid_state_transition)', async () => {
    const created = await request(app)
      .post('/api/v1/disputes')
      .set(bearer(adminToken()))
      .send({ contractId: UUID, reason: 'r' });
    const id = created.body.data.id;

    await request(app)
      .patch(`/api/v1/disputes/${id}`)
      .set(bearer(adminToken()))
      .send({ status: 'resolved', resolution: 'evidence' });

    const reopen = await request(app)
      .patch(`/api/v1/disputes/${id}`)
      .set(bearer(adminToken()))
      .send({ status: 'open' });
    expect(reopen.status).toBe(400);
    expect(reopen.body.error.code).toBe('invalid_state_transition');
  });

  it('rejects a second close with different evidence (409 dispute_already_resolved)', async () => {
    const created = await request(app)
      .post('/api/v1/disputes')
      .set(bearer(adminToken()))
      .send({ contractId: UUID, reason: 'r' });
    const id = created.body.data.id;

    await request(app)
      .patch(`/api/v1/disputes/${id}`)
      .set(bearer(adminToken()))
      .send({ status: 'resolved', resolution: 'original evidence' });

    const secondClose = await request(app)
      .patch(`/api/v1/disputes/${id}`)
      .set(bearer(adminToken()))
      .send({ status: 'resolved', resolution: 'different evidence' });
    expect(secondClose.status).toBe(409);
    expect(secondClose.body.error.code).toBe('dispute_already_resolved');
  });

  it('rejects a stale expectedVersion (409 dispute_version_conflict)', async () => {
    const created = await request(app)
      .post('/api/v1/disputes')
      .set(bearer(adminToken()))
      .send({ contractId: UUID, reason: 'r' });
    const id = created.body.data.id;

    // Advance the dispute past version 1.
    await request(app)
      .patch(`/api/v1/disputes/${id}`)
      .set(bearer(adminToken()))
      .send({ status: 'under_review' });

    const stale = await request(app)
      .patch(`/api/v1/disputes/${id}`)
      .set(bearer(adminToken()))
      .send({ status: 'escalated', expectedVersion: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('dispute_version_conflict');
  });

  it('persists the acting user as statusChangedBy on the transition', async () => {
    const created = await request(app)
      .post('/api/v1/disputes')
      .set(bearer(clientToken('client-42')))
      .send({ contractId: UUID, reason: 'r' });
    const id = created.body.data.id;

    // client can create but not update; use admin for the transition.
    const updated = await request(app)
      .patch(`/api/v1/disputes/${id}`)
      .set(bearer(adminToken()))
      .send({ status: 'under_review' });
    expect(updated.status).toBe(200);
    expect(updated.body.data.status).toBe('under_review');
    expect(updated.body.data.statusChangedBy).toBe('admin-1');
    expect(updated.body.data.version).toBe(2);
  });

  it('applies a legal transition end to end', async () => {
    const created = await request(app)
      .post('/api/v1/disputes')
      .set(bearer(adminToken()))
      .send({ contractId: UUID, reason: 'r' });
    const id = created.body.data.id;

    const resolved = await request(app)
      .patch(`/api/v1/disputes/${id}`)
      .set(bearer(adminToken()))
      .send({ status: 'resolved', resolution: 'both parties agreed' });
    expect(resolved.status).toBe(200);
    expect(resolved.body.data.status).toBe('resolved');

    const read = await request(app).get(`/api/v1/disputes/${id}`).set(bearer(adminToken()));
    expect(read.status).toBe(200);
    expect(read.body.data.status).toBe('resolved');
  });
});
