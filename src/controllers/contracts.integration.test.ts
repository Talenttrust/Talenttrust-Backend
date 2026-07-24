/**
 * Integration tests for Contract CRUD routes — JWT auth and RBAC.
 *
 * Covers:
 *  - 401 when no token / malformed header / expired token
 *  - 403 when authenticated but wrong role or non-owner
 *  - 200 / 201 for authorised callers
 *  - Owner-only enforcement on PATCH and DELETE
 *  - No information leakage in 401/403 responses
 *  - Error envelope shape { error: { code, message, requestId } }
 */

// Set env vars BEFORE any imports so singletons pick them up.
process.env.JWT_SECRET = 'contracts-test-secret';
process.env.DB_PATH = ':memory:';

import request from 'supertest';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { closeDb, getDb } from '../db/database';
import app from '../index';

// ─── Token helpers ────────────────────────────────────────────────────────────

const SECRET = process.env.JWT_SECRET as string;

// UUIDs that match the seeded users created in beforeAll.
const CLIENT_ID     = '00000000-0000-0000-0000-000000000001';
const FREELANCER_ID = '00000000-0000-0000-0000-000000000002';

function makeToken(role: string, sub = 'user-1', expiresIn: number | string = '1h'): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return jwt.sign({ sub, email: `${sub}@test.com`, role }, SECRET, { expiresIn } as any) as string;
}

const adminToken      = () => makeToken('admin', 'admin-1');
const clientToken     = (id = CLIENT_ID) => makeToken('client', id);
const freelancerToken = (id = FREELANCER_ID) => makeToken('freelancer', id);

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

// ─── Shared contract payload ───────────────────────────────────────────────

const validPayload = {

  title: 'Test Contract Title',
  description: 'This is a valid long enough description for testing.',
  clientId: CLIENT_ID,
  freelancerId: FREELANCER_ID,
  budget: 5000,
};

// ─── Seed users for FK constraints ──────────────────────────────────────────

beforeAll(() => {
  const db = getDb();
  const now = new Date().toISOString();
  // Insert with specific IDs so our tokens (which carry these as `sub`) match
  db.prepare(
    `INSERT OR IGNORE INTO users (id, username, email, role, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(CLIENT_ID, 'testclient', 'testclient@test.com', 'client', now);
  db.prepare(
    `INSERT OR IGNORE INTO users (id, username, email, role, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(FREELANCER_ID, 'testfreelancer', 'testfreelancer@test.com', 'freelancer', now);
});

beforeEach(() => {
  const db = getDb();
  db.exec('DELETE FROM contracts');
});

// ─── Helper: create a contract as admin ─────────────────────────────────────

async function createContractAsAdmin(): Promise<string> {
  const res = await request(app)
    .post('/api/v1/contracts')
    .set({ ...auth(adminToken()), 'Idempotency-Key': randomUUID() })
    .send(validPayload);
  expect(res.status).toBe(201);
  return (res.body as { data: { id: string } }).data.id;
}

// ─── GET /api/v1/contracts ────────────────────────────────────────────────────

describe('GET /api/v1/contracts', () => {
  it('returns 401 when no Authorization header', async () => {
    const res = await request(app).get('/api/v1/contracts');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatchObject({ code: 'unauthorized' });
  });

  it('returns 401 for malformed Authorization header (no Bearer prefix)', async () => {
    const res = await request(app).get('/api/v1/contracts').set('Authorization', 'Token not-a-jwt');
    expect(res.status).toBe(401);
  });

  it('returns 401 for an expired token', async () => {
    const expired = makeToken('admin', 'u1', -1);
    const res = await request(app).get('/api/v1/contracts').set(auth(expired));
    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).toMatch(/expired/i);
  });

  it('returns 401 for a token signed with the wrong secret', async () => {
    const forged = jwt.sign({ sub: 'x', email: 'x@x.com', role: 'admin' }, 'wrong-secret');
    const res = await request(app).get('/api/v1/contracts').set(auth(forged));
    expect(res.status).toBe(401);
  });

  it('returns 200 for admin', async () => {
    const res = await request(app).get('/api/v1/contracts').set(auth(adminToken()));
    expect(res.status).toBe(200);
  });

  it('returns 403 for client (list is ownOnly; no owner resolver on collection route)', async () => {
    // The permission matrix marks client.contracts.list as ownOnly.
    // A collection route has no single resource id to resolve ownership against,
    // so requirePermission correctly denies access.
    const res = await request(app).get('/api/v1/contracts').set(auth(clientToken()));
    expect(res.status).toBe(403);
  });

  it('returns 403 for freelancer (list is ownOnly)', async () => {
    const res = await request(app).get('/api/v1/contracts').set(auth(freelancerToken()));
    expect(res.status).toBe(403);
  });

  it('does not leak user id or token contents on 401', async () => {
    const forged = jwt.sign({ sub: 'secret-id', email: 'x@x.com', role: 'admin' }, 'wrong-secret');
    const res = await request(app).get('/api/v1/contracts').set(auth(forged));
    expect(res.status).toBe(401);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('secret-id');
    expect(body).not.toContain(forged);
  });

  it('returns paginated list with pagination metadata', async () => {
    await createContractAsAdmin();
    await createContractAsAdmin();
    const res = await request(app)
      .get('/api/v1/contracts?page=1&limit=1')
      .set(auth(adminToken()));
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.meta).toMatchObject({
      page: 1,
      limit: 1,
      total: 2,
      totalPages: 2,
    });
  });

  it('returns 400 for invalid page parameter', async () => {
    const res = await request(app)
      .get('/api/v1/contracts?page=-1')
      .set(auth(adminToken()));
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid limit parameter', async () => {
    const res = await request(app)
      .get('/api/v1/contracts?limit=abc')
      .set(auth(adminToken()));
    expect(res.status).toBe(400);
  });

  it('returns 200 with empty data array when no contracts exist', async () => {
    const res = await request(app)
      .get('/api/v1/contracts')
      .set(auth(adminToken()));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'success',
      data: [],
      meta: expect.objectContaining({
        total: 0,
        page: 1,
        limit: expect.any(Number),
        totalPages: 0,
      }),
    });
    expect(res.body).toHaveProperty('requestId');
  });

  it('supports cursor-based pagination with valid cursor', async () => {
    await createContractAsAdmin();
    await createContractAsAdmin();
    await createContractAsAdmin();

    const first = await request(app)
      .get('/api/v1/contracts?limit=2')
      .set(auth(adminToken()));
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      status: 'success',
      data: expect.objectContaining({
        data: expect.any(Array),
        nextCursor: expect.any(String),
        hasNextPage: true,
        limit: 2,
      }),
    });

    const cursor = first.body.data.nextCursor;

    const second = await request(app)
      .get(`/api/v1/contracts?limit=2&cursor=${cursor}`)
      .set(auth(adminToken()));
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({
      status: 'success',
      data: expect.objectContaining({
        data: expect.any(Array),
        hasNextPage: expect.any(Boolean),
      }),
    });
  });

  it('returns 200 on success with expected envelope shape for paginated list', async () => {
    await createContractAsAdmin();
    const res = await request(app)
      .get('/api/v1/contracts?page=1&limit=10')
      .set(auth(adminToken()));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'success',
      data: expect.any(Array),
      meta: expect.objectContaining({
        page: 1,
        limit: 10,
        total: expect.any(Number),
        totalPages: expect.any(Number),
      }),
    });
    expect(res.body).toHaveProperty('requestId');
  });
});

// ─── POST /api/v1/contracts ───────────────────────────────────────────────────

describe('POST /api/v1/contracts', () => {
  it('returns 401 without a token', async () => {
    const res = await request(app).post('/api/v1/contracts').send(validPayload);
    expect(res.status).toBe(401);
  });

  it('returns 201 for admin with valid payload', async () => {
    const res = await request(app)
      .post('/api/v1/contracts')
      .set({ ...auth(adminToken()), 'Idempotency-Key': randomUUID() })
      .send(validPayload);
    expect(res.status).toBe(201);
    expect(res.body.data).toHaveProperty('id');
    expect(res.body.data.title).toBe(validPayload.title);
  });

  it('returns 201 for client (create is permitted)', async () => {
    const res = await request(app)
      .post('/api/v1/contracts')
      .set({ ...auth(clientToken()), 'Idempotency-Key': randomUUID() })
      .send(validPayload);
    expect(res.status).toBe(201);
  });

  it('returns 403 for freelancer (create not in permission matrix)', async () => {
    const res = await request(app)
      .post('/api/v1/contracts')
      .set(auth(freelancerToken()))
      .send(validPayload);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'forbidden' });
  });

  it('returns 400 for admin with invalid payload (missing title)', async () => {
    const { title: _t, ...noTitle } = validPayload;
    const res = await request(app)
      .post('/api/v1/contracts')
      .set(auth(adminToken()))
      .send(noTitle);
    expect(res.status).toBe(400);
  });

  it('returns 400 for admin with negative budget', async () => {
    const res = await request(app)
      .post('/api/v1/contracts')
      .set(auth(adminToken()))
      .send({ ...validPayload, budget: -100 });
    expect(res.status).toBe(400);
  });

  it('returns 400 for budget exceeding maximum contract amount (validation)', async () => {
    const res = await request(app)
      .post('/api/v1/contracts')
      .set({ ...auth(adminToken()), 'Idempotency-Key': randomUUID() })
      .send({ ...validPayload, budget: 999_000_000_000_000_000 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: 'validation_error' });
  });

  it('returns 400 when clientId is missing', async () => {
    const { clientId: _c, ...noClient } = validPayload;
    const res = await request(app)
      .post('/api/v1/contracts')
      .set({ ...auth(adminToken()), 'Idempotency-Key': randomUUID() })
      .send(noClient);
    expect(res.status).toBe(400);
  });

  it('returns 400 when clientId is not a valid UUID', async () => {
    const res = await request(app)
      .post('/api/v1/contracts')
      .set({ ...auth(adminToken()), 'Idempotency-Key': randomUUID() })
      .send({ ...validPayload, clientId: 'not-a-uuid' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when description is missing', async () => {
    const { description: _d, ...noDesc } = validPayload;
    const res = await request(app)
      .post('/api/v1/contracts')
      .set({ ...auth(adminToken()), 'Idempotency-Key': randomUUID() })
      .send(noDesc);
    expect(res.status).toBe(400);
  });

  it('returns 400 when description is too short', async () => {
    const res = await request(app)
      .post('/api/v1/contracts')
      .set({ ...auth(adminToken()), 'Idempotency-Key': randomUUID() })
      .send({ ...validPayload, description: 'Short' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when title is too short', async () => {
    const res = await request(app)
      .post('/api/v1/contracts')
      .set({ ...auth(adminToken()), 'Idempotency-Key': randomUUID() })
      .send({ ...validPayload, title: 'Hi' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when budget is zero', async () => {
    const res = await request(app)
      .post('/api/v1/contracts')
      .set({ ...auth(adminToken()), 'Idempotency-Key': randomUUID() })
      .send({ ...validPayload, budget: 0 });
    expect(res.status).toBe(400);
  });

  it('returns 400 when budget is missing', async () => {
    const { budget: _b, ...noBudget } = validPayload;
    const res = await request(app)
      .post('/api/v1/contracts')
      .set({ ...auth(adminToken()), 'Idempotency-Key': randomUUID() })
      .send(noBudget);
    expect(res.status).toBe(400);
  });

  it('returns 400 when freelancerId is not a valid UUID', async () => {
    const res = await request(app)
      .post('/api/v1/contracts')
      .set({ ...auth(adminToken()), 'Idempotency-Key': randomUUID() })
      .send({ ...validPayload, freelancerId: 'not-a-uuid' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when milestone has negative amount', async () => {
    const res = await request(app)
      .post('/api/v1/contracts')
      .set({ ...auth(adminToken()), 'Idempotency-Key': randomUUID() })
      .send({
        ...validPayload,
        milestones: [{ title: 'Bad Milestone', description: 'Negative amount', amount: -100 }],
      });
    expect(res.status).toBe(400);
  });

  it('returns 201 on success with expected envelope shape', async () => {
    const res = await request(app)
      .post('/api/v1/contracts')
      .set({ ...auth(adminToken()), 'Idempotency-Key': randomUUID() })
      .send(validPayload);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      status: 'success',
      data: expect.objectContaining({
        title: validPayload.title,
        clientId: CLIENT_ID,
        status: 'draft',
      }),
    });
    expect(res.body).toHaveProperty('requestId');
    expect(res.body.data).toHaveProperty('id');
    expect(res.body.data).toHaveProperty('version', 0);
    expect(res.body.data).toHaveProperty('createdAt');
  });

  it('returns 422 for milestone count exceeding maximum limit', async () => {
    const excessiveMilestones = Array.from({ length: 25 }, (_, i) => ({
      title: `Milestone ${i}`,
      description: `Description ${i}`,
      amount: 100,
    }));
    const res = await request(app)
      .post('/api/v1/contracts')
      .set({ ...auth(adminToken()), 'Idempotency-Key': randomUUID() })
      .send({ ...validPayload, milestones: excessiveMilestones });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({ code: 'contract_bounds_error' });
  });

  it('returns 422 for total milestone amount exceeding bounds', async () => {
    const excessiveAmountMilestones = [
      {
        title: 'Milestone 1',
        description: 'Valid description',
        amount: 999_000_000_000_000_000,
      },
    ];
    const res = await request(app)
      .post('/api/v1/contracts')
      .set({ ...auth(adminToken()), 'Idempotency-Key': randomUUID() })
      .send({ ...validPayload, milestones: excessiveAmountMilestones });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({ code: 'contract_bounds_error' });
  });
});

describe('POST /api/v1/contracts idempotency', () => {
  it('returns 400 when Idempotency-Key header is missing', async () => {
    const res = await request(app)
      .post('/api/v1/contracts')
      .set(auth(adminToken()))
      .send(validPayload);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: 'bad_request' });
  });

  it('replay with same key returns the same response and does not create a duplicate contract', async () => {
    const idempotencyKey = 'idem-create-1';

    const first = await request(app)
      .post('/api/v1/contracts')
      .set({ ...auth(adminToken()), 'Idempotency-Key': idempotencyKey })
      .send(validPayload);
    expect(first.status).toBe(201);

    const second = await request(app)
      .post('/api/v1/contracts')
      .set({ ...auth(adminToken()), 'Idempotency-Key': idempotencyKey })
      .send(validPayload);

    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
  });

  it('replay with same key but different body returns 409 Conflict', async () => {
    const idempotencyKey = 'idem-create-2';

    const first = await request(app)
      .post('/api/v1/contracts')
      .set({ ...auth(adminToken()), 'Idempotency-Key': idempotencyKey })
      .send(validPayload);
    expect(first.status).toBe(201);

    const differentBody = { ...validPayload, title: 'Different Title' };
    const replay = await request(app)
      .post('/api/v1/contracts')
      .set({ ...auth(adminToken()), 'Idempotency-Key': idempotencyKey })
      .send(differentBody);

    expect(replay.status).toBe(409);
    expect(replay.body.error).toMatchObject({ code: 'conflict' });
  });
});

// ─── GET /api/v1/contracts/:id ────────────────────────────────────────────────


describe('GET /api/v1/contracts/:id', () => {
  let contractId: string;

  beforeEach(async () => {
    contractId = await createContractAsAdmin();
  });

  it('returns 401 without a token', async () => {
    const res = await request(app).get(`/api/v1/contracts/${contractId}`);
    expect(res.status).toBe(401);
  });

  it('returns 200 for admin', async () => {
    const res = await request(app)
      .get(`/api/v1/contracts/${contractId}`)
      .set(auth(adminToken()));
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(contractId);
  });

  it('returns 200 for the owning client (sub === clientId)', async () => {
    const res = await request(app)
      .get(`/api/v1/contracts/${contractId}`)
      .set(auth(clientToken(CLIENT_ID)));
    expect(res.status).toBe(200);
  });

  it('returns 403 for a non-owning client', async () => {
    const res = await request(app)
      .get(`/api/v1/contracts/${contractId}`)
      .set(auth(clientToken('00000000-0000-0000-0000-000000000099')));
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'forbidden' });
  });

  it('returns 404 for a non-existent contract id', async () => {
    const res = await request(app)
      .get('/api/v1/contracts/00000000-0000-0000-0000-000000000000')
      .set(auth(adminToken()));
    expect(res.status).toBe(404);
  });

  it('does not reveal resource existence to non-owner (returns 403, not 200/404)', async () => {
    const nonOwner = clientToken('00000000-0000-0000-0000-000000000099');
    const res = await request(app)
      .get(`/api/v1/contracts/${contractId}`)
      .set(auth(nonOwner));
    expect(res.status).toBe(403);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(contractId);
    expect(body).not.toContain(CLIENT_ID);
  });

  it('returns 404 for a non-existent id (non-UUID string)', async () => {
    const res = await request(app)
      .get('/api/v1/contracts/not-a-valid-uuid')
      .set(auth(adminToken()));
    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({ code: 'not_found' });
  });

  it('returns 200 on success with expected response shape', async () => {
    const res = await request(app)
      .get(`/api/v1/contracts/${contractId}`)
      .set(auth(adminToken()));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'success',
      data: expect.objectContaining({
        id: contractId,
        title: 'Test Contract Title',
      }),
    });
    expect(res.body).toHaveProperty('requestId');
    expect(res.body.data).toHaveProperty('version');
    expect(res.body.data).toHaveProperty('createdAt');
  });
});

// ─── PATCH /api/v1/contracts/:id ─────────────────────────────────────────────

describe('PATCH /api/v1/contracts/:id', () => {
  let contractId: string;
  let contractVersion: number;

  beforeEach(async () => {
    contractId = await createContractAsAdmin();
    const fetched = await request(app)
      .get(`/api/v1/contracts/${contractId}`)
      .set(auth(adminToken()));
    contractVersion = (fetched.body as { data: { version: number } }).data.version;
  });

  it('returns 401 without a token', async () => {
    const res = await request(app)
      .patch(`/api/v1/contracts/${contractId}`)
      .send({ version: contractVersion, title: 'No Auth Update' });
    expect(res.status).toBe(401);
  });

  it('returns 200 for admin', async () => {
    const res = await request(app)
      .patch(`/api/v1/contracts/${contractId}`)
      .set(auth(adminToken()))
      .send({ version: contractVersion, title: 'Admin Updated Title' });
    expect(res.status).toBe(200);
    contractVersion = (res.body as { data: { version: number } }).data.version;
  });

  it('returns 200 for the owning client', async () => {
    const res = await request(app)
      .patch(`/api/v1/contracts/${contractId}`)
      .set(auth(clientToken(CLIENT_ID)))
      .send({ version: contractVersion, title: 'Client Updated Title' });
    expect(res.status).toBe(200);
    contractVersion = (res.body as { data: { version: number } }).data.version;
  });

  it('returns 403 for a non-owning client', async () => {
    const res = await request(app)
      .patch(`/api/v1/contracts/${contractId}`)
      .set(auth(clientToken('00000000-0000-0000-0000-000000000099')))
      .send({ version: contractVersion, title: 'Malicious Update' });
    expect(res.status).toBe(403);
  });

  it('returns 403 for a freelancer (not the owner by clientId)', async () => {
    const res = await request(app)
      .patch(`/api/v1/contracts/${contractId}`)
      .set(auth(freelancerToken(FREELANCER_ID)))
      .send({ version: contractVersion, title: 'Freelancer Update' });
    expect(res.status).toBe(403);
  });

  it('returns 404 for a non-existent contract id', async () => {
    const res = await request(app)
      .patch('/api/v1/contracts/00000000-0000-0000-0000-000000000000')
      .set(auth(adminToken()))
      .send({ version: 0, title: 'Ghost Update' });
    expect(res.status).toBe(404);
  });

  it('returns 400 for admin with invalid body (missing version)', async () => {
    const res = await request(app)
      .patch(`/api/v1/contracts/${contractId}`)
      .set(auth(adminToken()))
      .send({ title: 'No version field' });
    expect(res.status).toBe(400);
  });

  it('returns 409 for version conflict (stale version)', async () => {
    const res = await request(app)
      .patch(`/api/v1/contracts/${contractId}`)
      .set(auth(adminToken()))
      .send({ version: contractVersion + 999, title: 'Stale Update' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'ERR_CONFLICT' });
  });

  it('returns 400 for budget update exceeding bounds (validation)', async () => {
    const res = await request(app)
      .patch(`/api/v1/contracts/${contractId}`)
      .set(auth(adminToken()))
      .send({ version: contractVersion, budget: 999_000_000_000_000_000 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: 'validation_error' });
  });

  it('returns 400 for negative version', async () => {
    const res = await request(app)
      .patch(`/api/v1/contracts/${contractId}`)
      .set(auth(adminToken()))
      .send({ version: -1, title: 'Negative version' });
    expect(res.status).toBe(400);
  });

  it('returns 400 for non-integer version', async () => {
    const res = await request(app)
      .patch(`/api/v1/contracts/${contractId}`)
      .set(auth(adminToken()))
      .send({ version: 1.5, title: 'Float version' });
    expect(res.status).toBe(400);
  });

  it('returns 400 for budget of zero on update', async () => {
    const res = await request(app)
      .patch(`/api/v1/contracts/${contractId}`)
      .set(auth(adminToken()))
      .send({ version: contractVersion, budget: 0 });
    expect(res.status).toBe(400);
  });

  it('returns 200 on success and response has expected envelope shape', async () => {
    const res = await request(app)
      .patch(`/api/v1/contracts/${contractId}`)
      .set(auth(adminToken()))
      .send({ version: contractVersion, title: 'Shape Test Update' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'success',
      data: expect.objectContaining({
        id: contractId,
        title: 'Shape Test Update',
        version: contractVersion + 1,
      }),
    });
    expect(res.body).toHaveProperty('requestId');
  });
});

// ─── DELETE /api/v1/contracts/:id ────────────────────────────────────────────

describe('DELETE /api/v1/contracts/:id', () => {
  it('returns 401 without a token', async () => {
    const id = await createContractAsAdmin();
    const res = await request(app).delete(`/api/v1/contracts/${id}`);
    expect(res.status).toBe(401);
  });

  it('returns 403 for a client (delete not in client permission matrix)', async () => {
    const id = await createContractAsAdmin();
    const res = await request(app)
      .delete(`/api/v1/contracts/${id}`)
      .set(auth(clientToken(CLIENT_ID)));
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'forbidden' });
  });

  it('returns 403 for a freelancer', async () => {
    const id = await createContractAsAdmin();
    const res = await request(app)
      .delete(`/api/v1/contracts/${id}`)
      .set(auth(freelancerToken()));
    expect(res.status).toBe(403);
  });

  it('returns 200 for admin', async () => {
    const id = await createContractAsAdmin();
    const res = await request(app)
      .delete(`/api/v1/contracts/${id}`)
      .set(auth(adminToken()));
    expect(res.status).toBe(200);
  });

  it('returns 404 for a non-existent contract id (admin)', async () => {
    const res = await request(app)
      .delete('/api/v1/contracts/00000000-0000-0000-0000-000000000000')
      .set(auth(adminToken()));
    expect(res.status).toBe(404);
  });

  it('returns 404 for an already-deleted contract on second delete', async () => {
    const id = await createContractAsAdmin();
    const first = await request(app).delete(`/api/v1/contracts/${id}`).set(auth(adminToken()));
    expect(first.status).toBe(200);

    const second = await request(app).delete(`/api/v1/contracts/${id}`).set(auth(adminToken()));
    expect(second.status).toBe(404);
    expect(second.body.error).toMatchObject({ code: 'not_found' });
  });

  it('returns 200 on success and response has expected envelope shape', async () => {
    const id = await createContractAsAdmin();
    const res = await request(app).delete(`/api/v1/contracts/${id}`).set(auth(adminToken()));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'success',
      data: { message: 'Contract deleted successfully' },
    });
    expect(res.body).toHaveProperty('requestId');
  });
});

// ─── GET /api/v1/contracts/stats ─────────────────────────────────────────────

describe('GET /api/v1/contracts/stats', () => {
  it('returns 401 without a token', async () => {
    const res = await request(app).get('/api/v1/contracts/stats');
    expect(res.status).toBe(401);
  });

  it('returns 200 for admin', async () => {
    const res = await request(app).get('/api/v1/contracts/stats').set(auth(adminToken()));
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('total');
  });

  it('returns expected envelope shape with stats data', async () => {
    await createContractAsAdmin();
    const res = await request(app).get('/api/v1/contracts/stats').set(auth(adminToken()));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'success',
      data: expect.objectContaining({
        total: expect.any(Number),
        totalBudget: expect.any(Number),
        byStatus: expect.any(Object),
      }),
    });
    expect(res.body).toHaveProperty('requestId');
  });
});

// ─── GET /api/v1/contracts/bounds ────────────────────────────────────────────

describe('GET /api/v1/contracts/bounds', () => {
  it('returns 401 without a token', async () => {
    const res = await request(app).get('/api/v1/contracts/bounds');
    expect(res.status).toBe(401);
  });

  it('returns 200 for admin', async () => {
    const res = await request(app).get('/api/v1/contracts/bounds').set(auth(adminToken()));
    expect(res.status).toBe(200);
  });

  it('returns expected envelope shape with bounds data', async () => {
    const res = await request(app).get('/api/v1/contracts/bounds').set(auth(adminToken()));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'success',
      data: expect.objectContaining({
        maxMilestonesPerContract: expect.any(Number),
        maxContractAmountStroops: expect.any(Number),
      }),
    });
    expect(res.body).toHaveProperty('requestId');
  });
});

// ─── Error envelope shape ─────────────────────────────────────────────────────

describe('Error envelope', () => {
  it('401 response has { error: { code, message, requestId } }', async () => {
    const res = await request(app).get('/api/v1/contracts');
    expect(res.status).toBe(401);
    expect(res.body.error).toHaveProperty('code');
    expect(res.body.error).toHaveProperty('message');
    expect(res.body.error).toHaveProperty('requestId');
  });

  it('403 response has { error: { code, message, requestId } }', async () => {
    const res = await request(app)
      .post('/api/v1/contracts')
      .set(auth(freelancerToken()))
      .send(validPayload);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'forbidden' });
    expect(res.body.error).toHaveProperty('message');
    expect(res.body.error).toHaveProperty('requestId');
  });
});

afterAll(() => {
  closeDb();
});
