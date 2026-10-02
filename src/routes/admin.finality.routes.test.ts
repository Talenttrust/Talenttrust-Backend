/**
 * Admin provisional-events endpoint tests: authorization (401/403/admin)
 * and response shape (provisional payloads never leave the admin surface).
 */

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createAdminRouter } from './admin.routes';
import { EventAuditService, InMemoryEventAuditRepository } from '../repository/eventAuditRepository';
import { FinalityEvaluator } from '../finality/finalityEvaluator';
import { createFinalityPolicy } from '../finality/policy';

const JWT_SECRET = 'test-secret-for-admin-finality-routes-0123456789';

function signToken(role: string): string {
  return jwt.sign(
    { sub: 'user-1', email: 'user@example.com', role },
    JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '1h' },
  );
}

describe('Admin provisional events endpoint', () => {
  let service: EventAuditService;
  let app: express.Application;
  let head: number;

  beforeEach(async () => {
    process.env.JWT_SECRET = JWT_SECRET;
    head = 100;

    const policy = createFinalityPolicy(
      { depths: { stellar: 1, soroban: 3 }, defaultDepth: 6 },
      'test',
    );
    // Head 100, ledger 99 -> 2 confirmations < depth 3 -> provisional.
    const evaluator = new FinalityEvaluator(policy, async () => head);
    service = new EventAuditService(new InMemoryEventAuditRepository(), console, evaluator);

    await service.processEvent(
      {
        contractId: 'contract-1',
        eventId: 'release-1',
        sequence: 1,
        timestamp: '2026-03-24T00:00:00.000Z',
        type: 'MILESTONE_RELEASED',
        payload: { milestoneId: 'm-1', amount: 100 },
        network: 'soroban',
        ledger: 99,
      },
      'MILESTONE_RELEASED',
    );

    app = express();
    app.use(express.json());
    app.use('/api/v1/admin', createAdminRouter(service));
  });

  afterEach(() => {
    delete process.env.JWT_SECRET;
  });

  it('rejects unauthenticated requests with 401', async () => {
    const response = await request(app).get('/api/v1/admin/events/provisional');
    expect(response.status).toBe(401);
  });

  it('rejects non-admin roles with 403', async () => {
    const clientToken = signToken('client');
    const response = await request(app)
      .get('/api/v1/admin/events/provisional')
      .set('Authorization', `Bearer ${clientToken}`);
    expect(response.status).toBe(403);
  });

  it('allows admins and returns provisional events without payloads', async () => {
    const adminToken = signToken('admin');
    const response = await request(app)
      .get('/api/v1/admin/events/provisional')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('success');
    expect(response.body.data.provisional).toHaveLength(1);

    const entry = response.body.data.provisional[0];
    expect(entry).toEqual(
      expect.objectContaining({
        contractId: 'contract-1',
        eventId: 'release-1',
        sequence: 1,
        network: 'soroban',
        ledger: 99,
      }),
    );
    // Unconfirmed payloads and internal keys never leave the admin surface.
    expect(entry).not.toHaveProperty('payload');
    expect(entry).not.toHaveProperty('deduplicationKey');
    expect(entry).not.toHaveProperty('payloadHash');
    expect(JSON.stringify(response.body)).not.toContain('milestoneId');
  });

  it('returns an empty list when no provisional events exist', async () => {
    // Advance the head past the boundary and promote the seeded event.
    const adminToken = signToken('admin');
    head = 101; // ledger 99 -> 3 confirmations == depth 3
    await service.promoteProvisionalEvents('soroban');

    const response = await request(app)
      .get('/api/v1/admin/events/provisional')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(response.status).toBe(200);
    expect(response.body.data.provisional).toEqual([]);
  });
});
