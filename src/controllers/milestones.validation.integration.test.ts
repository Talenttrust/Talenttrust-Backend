/**
 * @file milestones.validation.integration.test.ts
 * @description Integration tests for milestones request validation at HTTP boundary.
 *
 * These tests verify that the validation middleware correctly rejects invalid payloads
 * and accepts valid payloads for all milestone-related HTTP endpoints.
 */

process.env.JWT_SECRET = 'milestones-validation-test-secret';
process.env.DB_PATH = ':memory:';

import request from 'supertest';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { closeDb, getDb } from '../db/database';
import app from '../index';

const SECRET = process.env.JWT_SECRET as string;
const CLIENT_ID = '00000000-0000-0000-0000-000000000021';
const FREELANCER_ID = '00000000-0000-0000-0000-000000000022';

function makeToken(role: string, sub = 'admin-1'): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return jwt.sign({ sub, email: `${sub}@test.com`, role }, SECRET, { expiresIn: '1h' } as any) as string;
}

const adminToken = () => makeToken('admin', 'admin-1');
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

const basePayload = {
  title: 'Validation Test Contract',
  description: 'Contract used for milestones validation tests.',
  clientId: CLIENT_ID,
  freelancerId: FREELANCER_ID,
  budget: 50_000,
};

beforeAll(() => {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO users (id, username, email, role, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(CLIENT_ID, 'validationclient', 'validationclient@test.com', 'client', now);
  db.prepare(
    `INSERT OR IGNORE INTO users (id, username, email, role, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(FREELANCER_ID, 'validationfreelancer', 'validationfreelancer@test.com', 'freelancer', now);
});

beforeEach(() => {
  getDb().exec('DELETE FROM contracts');
});

afterAll(() => {
  closeDb();
});

async function createContract(overrides: Record<string, unknown> = {}) {
  const res = await request(app)
    .post('/api/v1/contracts')
    .set({ ...auth(adminToken()), 'Idempotency-Key': randomUUID() })
    .send({ ...basePayload, ...overrides });
  expect(res.status).toBe(201);
  return res.body.data.id as string;
}

describe('POST /:id/milestones — request validation', () => {
  let contractId: string;

  beforeEach(async () => {
    contractId = await createContract();
  });

  it('accepts valid milestone payload', async () => {
    const res = await request(app)
      .post(`/api/v1/contracts/${contractId}/milestones`)
      .set(auth(adminToken()))
      .send({
        title: 'Valid Milestone',
        description: 'A valid description',
        amount: 1000,
      });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('success');
    expect(res.body.data.milestone).toHaveProperty('id');
    expect(res.body.data.milestone.title).toBe('Valid Milestone');
    expect(res.body.data.milestone.amount).toBe(1000);
  });

  it('accepts minimal valid payload (title and amount only)', async () => {
    const res = await request(app)
      .post(`/api/v1/contracts/${contractId}/milestones`)
      .set(auth(adminToken()))
      .send({
        title: 'Minimal Milestone',
        amount: 500,
      });

    expect(res.status).toBe(201);
    expect(res.body.data.milestone.title).toBe('Minimal Milestone');
  });

  it('rejects missing title field', async () => {
    const res = await request(app)
      .post(`/api/v1/contracts/${contractId}/milestones`)
      .set(auth(adminToken()))
      .send({
        amount: 1000,
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
    expect(res.body.error.message).toBe('Request validation failed');
    expect(res.body.error.details).toBeDefined();
    expect(res.body.error.details.some((d: any) => d.path.includes('title'))).toBe(true);
  });

  it('rejects missing amount field', async () => {
    const res = await request(app)
      .post(`/api/v1/contracts/${contractId}/milestones`)
      .set(auth(adminToken()))
      .send({
        title: 'Test Milestone',
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
    expect(res.body.error.details.some((d: any) => d.path.includes('amount'))).toBe(true);
  });

  it('rejects empty title', async () => {
    const res = await request(app)
      .post(`/api/v1/contracts/${contractId}/milestones`)
      .set(auth(adminToken()))
      .send({
        title: '',
        amount: 1000,
      });

    expect(res.status).toBe(400);
    expect(res.body.error.details[0].message).toContain('at least');
  });

  it('rejects title exceeding maximum length', async () => {
    const res = await request(app)
      .post(`/api/v1/contracts/${contractId}/milestones`)
      .set(auth(adminToken()))
      .send({
        title: 'x'.repeat(101),
        amount: 1000,
      });

    expect(res.status).toBe(400);
    expect(res.body.error.details[0].message).toContain('not exceed');
  });

  it('rejects negative amount', async () => {
    const res = await request(app)
      .post(`/api/v1/contracts/${contractId}/milestones`)
      .set(auth(adminToken()))
      .send({
        title: 'Test Milestone',
        amount: -100,
      });

    expect(res.status).toBe(400);
    expect(res.body.error.details[0].message).toContain('positive');
  });

  it('rejects zero amount', async () => {
    const res = await request(app)
      .post(`/api/v1/contracts/${contractId}/milestones`)
      .set(auth(adminToken()))
      .send({
        title: 'Test Milestone',
        amount: 0,
      });

    expect(res.status).toBe(400);
    expect(res.body.error.details[0].message).toContain('positive');
  });

  it('rejects non-number amount', async () => {
    const res = await request(app)
      .post(`/api/v1/contracts/${contractId}/milestones`)
      .set(auth(adminToken()))
      .send({
        title: 'Test Milestone',
        amount: 'not-a-number',
      });

    expect(res.status).toBe(400);
    expect(res.body.error.details[0].message).toContain('must be a number');
  });

  it('rejects invalid datetime format for deadline', async () => {
    const res = await request(app)
      .post(`/api/v1/contracts/${contractId}/milestones`)
      .set(auth(adminToken()))
      .send({
        title: 'Test Milestone',
        amount: 1000,
        deadline: 'not-a-date',
      });

    expect(res.status).toBe(400);
    expect(res.body.error.details[0].message).toContain('ISO-8601');
  });

  it('accepts valid ISO-8601 datetime for deadline', async () => {
    const res = await request(app)
      .post(`/api/v1/contracts/${contractId}/milestones`)
      .set(auth(adminToken()))
      .send({
        title: 'Test Milestone',
        amount: 1000,
        deadline: '2026-12-31T23:59:59.000Z',
      });

    expect(res.status).toBe(201);
  });

  it('strips unknown fields from payload', async () => {
    const res = await request(app)
      .post(`/api/v1/contracts/${contractId}/milestones`)
      .set(auth(adminToken()))
      .send({
        title: 'Test Milestone',
        amount: 1000,
        unknownField: 'should be ignored',
      });

    expect(res.status).toBe(201);
    expect(res.body.data.milestone).not.toHaveProperty('unknownField');
  });
});

describe('DELETE /:id/milestones/:milestoneId — parameter validation', () => {
  let contractId: string;

  beforeEach(async () => {
    contractId = await createContract();
  });

  it('rejects invalid UUID for milestoneId', async () => {
    const res = await request(app)
      .delete(`/api/v1/contracts/${contractId}/milestones/not-a-uuid`)
      .set(auth(adminToken()));

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
    expect(res.body.error.details[0].message).toContain('valid UUID');
  });

  it('accepts valid UUID for milestoneId (returns 404 for non-existent milestone)', async () => {
    const res = await request(app)
      .delete(`/api/v1/contracts/${contractId}/milestones/550e8400-e29b-41d4-a716-446655440000`)
      .set(auth(adminToken()));

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('milestone_not_found');
  });
});

describe('POST /:id/milestones/:milestoneId/restore — parameter validation', () => {
  let contractId: string;

  beforeEach(async () => {
    contractId = await createContract();
  });

  it('rejects invalid UUID for milestoneId', async () => {
    const res = await request(app)
      .post(`/api/v1/contracts/${contractId}/milestones/not-a-uuid/restore`)
      .set(auth(adminToken()));

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
    expect(res.body.error.details[0].message).toContain('valid UUID');
  });

  it('accepts valid UUID for milestoneId (returns 404 for non-existent milestone)', async () => {
    const res = await request(app)
      .post(`/api/v1/contracts/${contractId}/milestones/550e8400-e29b-41d4-a716-446655440000/restore`)
      .set(auth(adminToken()));

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('milestone_not_found');
  });
});

describe('GET /:id/milestones — query parameter validation', () => {
  let contractId: string;

  beforeEach(async () => {
    contractId = await createContract();
  });

  it('accepts valid query parameters', async () => {
    const res = await request(app)
      .get(`/api/v1/contracts/${contractId}/milestones?includeDeleted=true`)
      .set(auth(adminToken()));

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
  });

  it('accepts empty query parameters', async () => {
    const res = await request(app)
      .get(`/api/v1/contracts/${contractId}/milestones`)
      .set(auth(adminToken()));

    expect(res.status).toBe(200);
  });

  it('strips unknown query parameters', async () => {
    const res = await request(app)
      .get(`/api/v1/contracts/${contractId}/milestones?unknown=param`)
      .set(auth(adminToken()));

    expect(res.status).toBe(200);
  });
});
