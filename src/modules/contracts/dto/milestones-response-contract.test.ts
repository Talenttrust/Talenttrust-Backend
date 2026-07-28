/**
 * Schema / contract tests for milestones response shapes.
 *
 * These tests assert that every milestones-related HTTP response matches its
 * documented shape — required fields, correct types, and no unexpected extras.
 * They do NOT change behaviour; they lock the existing contract so accidental
 * regressions are caught immediately.
 *
 * Coverage:
 *   ✓ Success shape  – POST 201, PATCH 200, GET 200
 *   ✓ Error shape    – 400 validation, 404 not-found, 409 conflict, 422 bounds
 *   ✓ Optional fields – milestones absent vs present, requestId always present
 */

process.env.JWT_SECRET = 'contract-schema-test-secret';
process.env.DB_PATH = ':memory:';

import request from 'supertest';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { closeDb, getDb } from '../../../db/database';
import app from '../../../index';
import {
  MAX_MILESTONES_PER_CONTRACT,
  MAX_CONTRACT_AMOUNT_STROOPS,
} from '../../../contracts/bounds';

const SECRET = process.env.JWT_SECRET as string;
const CLIENT_ID = '00000000-0000-0000-0000-000000000021';
const FREELANCER_ID = '00000000-0000-0000-0000-000000000022';

function makeToken(role: string, sub = 'user-schema-test'): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return jwt.sign({ sub, email: `${sub}@test.com`, role }, SECRET, { expiresIn: '1h' } as any) as string;
}
const adminToken = () => makeToken('admin', 'admin-schema');
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

const basePayload = {
  title: 'Schema Contract Test',
  description: 'Contract used for response shape assertions.',
  clientId: CLIENT_ID,
  freelancerId: FREELANCER_ID,
  budget: 50_000,
};

beforeAll(() => {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO users (id, username, email, role, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(CLIENT_ID, 'schemaclient', 'schemaclient@test.com', 'client', now);
  db.prepare(
    `INSERT OR IGNORE INTO users (id, username, email, role, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(FREELANCER_ID, 'schemafreelancer', 'schemafreelancer@test.com', 'freelancer', now);
});

beforeEach(() => {
  getDb().exec('DELETE FROM contracts');
});

afterAll(() => {
  closeDb();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function createContract(overrides: Record<string, unknown> = {}) {
  const res = await request(app)
    .post('/api/v1/contracts')
    .set({ ...auth(adminToken()), 'Idempotency-Key': randomUUID() })
    .send({ ...basePayload, ...overrides });
  expect(res.status).toBe(201);
  return res;
}

/** Assert the standard success envelope shape. */
function assertSuccessEnvelope(body: Record<string, unknown>) {
  expect(body).toHaveProperty('status', 'success');
  expect(body).toHaveProperty('data');
  expect(typeof body.data).toBe('object');
  expect(body.data).not.toBeNull();
}

/** Assert the standard error envelope shape. */
function assertErrorEnvelope(body: Record<string, unknown>) {
  expect(body).toHaveProperty('error');
  const error = body.error as Record<string, unknown>;
  expect(typeof error.code).toBe('string');
  expect(error.code).not.toBe('');
  expect(typeof error.message).toBe('string');
  expect(error.message).not.toBe('');
  expect(typeof error.requestId).toBe('string');
}

/** Assert the required fields of a contract data object. */
function assertContractDataShape(data: Record<string, unknown>) {
  expect(typeof data.id).toBe('string');
  expect(typeof data.title).toBe('string');
  expect(typeof data.clientId).toBe('string');
  expect(typeof data.freelancerId).toBe('string');
  expect(typeof data.amount).toBe('number');
  expect(typeof data.status).toBe('string');
  expect(typeof data.createdAt).toBe('string');
  expect(typeof data.version).toBe('number');
  expect(Number.isInteger(data.version)).toBe(true);
  expect(data.version as number).toBeGreaterThanOrEqual(0);
}

/** Assert no unexpected top-level keys exist on the contract data object. */
const EXPECTED_CONTRACT_KEYS = new Set([
  'id', 'title', 'clientId', 'freelancerId', 'amount', 'status',
  'createdAt', 'version',
  // optional fields that may appear
  'description', 'deadline', 'terms', 'updatedAt',
]);

function assertNoExtraContractKeys(data: Record<string, unknown>) {
  for (const key of Object.keys(data)) {
    expect(EXPECTED_CONTRACT_KEYS.has(key)).toBe(true);
  }
}

// ─── POST /api/v1/contracts — success shape ───────────────────────────────────

describe('POST /api/v1/contracts — success response shape', () => {
  it('returns 201 with a well-formed success envelope', async () => {
    const res = await createContract();
    expect(res.status).toBe(201);
    assertSuccessEnvelope(res.body);
  });

  it('data object contains all required contract fields with correct types', async () => {
    const res = await createContract();
    assertContractDataShape(res.body.data as Record<string, unknown>);
  });

  it('version starts at 0 on a freshly created contract', async () => {
    const res = await createContract();
    expect((res.body.data as Record<string, unknown>).version).toBe(0);
  });

  it('status defaults to draft when not supplied', async () => {
    const res = await createContract();
    expect((res.body.data as Record<string, unknown>).status).toBe('draft');
  });

  it('data object does not contain unexpected extra keys', async () => {
    const res = await createContract();
    assertNoExtraContractKeys(res.body.data as Record<string, unknown>);
  });

  it('creates with milestones and response shape is unchanged (milestones not in response)', async () => {
    const milestones = [{ title: 'Phase 1', description: 'Start', amount: 1000 }];
    const res = await createContract({ milestones });
    expect(res.status).toBe(201);
    assertSuccessEnvelope(res.body);
    assertContractDataShape(res.body.data as Record<string, unknown>);
    // milestones are validated but not returned in the response data
    expect((res.body.data as Record<string, unknown>).milestones).toBeUndefined();
  });
});

// ─── GET /api/v1/contracts/:id — success shape ───────────────────────────────

describe('GET /api/v1/contracts/:id — success response shape', () => {
  it('returns 200 with a well-formed success envelope', async () => {
    const create = await createContract();
    const id = (create.body.data as Record<string, unknown>).id as string;

    const res = await request(app)
      .get(`/api/v1/contracts/${id}`)
      .set(auth(adminToken()));

    expect(res.status).toBe(200);
    assertSuccessEnvelope(res.body);
  });

  it('data object contains all required contract fields with correct types', async () => {
    const create = await createContract();
    const id = (create.body.data as Record<string, unknown>).id as string;

    const res = await request(app)
      .get(`/api/v1/contracts/${id}`)
      .set(auth(adminToken()));

    assertContractDataShape(res.body.data as Record<string, unknown>);
  });

  it('data object does not contain unexpected extra keys', async () => {
    const create = await createContract();
    const id = (create.body.data as Record<string, unknown>).id as string;

    const res = await request(app)
      .get(`/api/v1/contracts/${id}`)
      .set(auth(adminToken()));

    assertNoExtraContractKeys(res.body.data as Record<string, unknown>);
  });

  it('id in response matches the requested id', async () => {
    const create = await createContract();
    const id = (create.body.data as Record<string, unknown>).id as string;

    const res = await request(app)
      .get(`/api/v1/contracts/${id}`)
      .set(auth(adminToken()));

    expect((res.body.data as Record<string, unknown>).id).toBe(id);
  });
});

// ─── PATCH /api/v1/contracts/:id — success shape ─────────────────────────────

describe('PATCH /api/v1/contracts/:id — success response shape', () => {
  it('returns 200 with a well-formed success envelope', async () => {
    const create = await createContract();
    const { id, version } = create.body.data as { id: string; version: number };

    const res = await request(app)
      .patch(`/api/v1/contracts/${id}`)
      .set(auth(adminToken()))
      .send({ version, title: 'Updated Schema Title' });

    expect(res.status).toBe(200);
    assertSuccessEnvelope(res.body);
  });

  it('data object contains all required contract fields with correct types', async () => {
    const create = await createContract();
    const { id, version } = create.body.data as { id: string; version: number };

    const res = await request(app)
      .patch(`/api/v1/contracts/${id}`)
      .set(auth(adminToken()))
      .send({ version, title: 'Updated Schema Title' });

    assertContractDataShape(res.body.data as Record<string, unknown>);
  });

  it('version is incremented by exactly 1 after a successful patch', async () => {
    const create = await createContract();
    const { id, version } = create.body.data as { id: string; version: number };

    const res = await request(app)
      .patch(`/api/v1/contracts/${id}`)
      .set(auth(adminToken()))
      .send({ version, title: 'Version Bump Check' });

    expect((res.body.data as Record<string, unknown>).version).toBe(version + 1);
  });

  it('data object does not contain unexpected extra keys after patch', async () => {
    const create = await createContract();
    const { id, version } = create.body.data as { id: string; version: number };

    const res = await request(app)
      .patch(`/api/v1/contracts/${id}`)
      .set(auth(adminToken()))
      .send({ version, title: 'Extra Keys Check' });

    assertNoExtraContractKeys(res.body.data as Record<string, unknown>);
  });
});

// ─── Error shapes — 400 validation ───────────────────────────────────────────

describe('Error response shape — 400 validation_error', () => {
  it('missing title returns 400 with standard error envelope', async () => {
    const res = await request(app)
      .post('/api/v1/contracts')
      .set({ ...auth(adminToken()), 'Idempotency-Key': randomUUID() })
      .send({ ...basePayload, title: '' });

    expect(res.status).toBe(400);
    assertErrorEnvelope(res.body);
    expect((res.body.error as Record<string, unknown>).code).toBe('validation_error');
  });

  it('milestone with empty title returns 400 with standard error envelope', async () => {
    const res = await request(app)
      .post('/api/v1/contracts')
      .set({ ...auth(adminToken()), 'Idempotency-Key': randomUUID() })
      .send({ ...basePayload, milestones: [{ title: '', description: 'x', amount: 100 }] });

    expect(res.status).toBe(400);
    assertErrorEnvelope(res.body);
    expect((res.body.error as Record<string, unknown>).code).toBe('validation_error');
  });

  it('milestone with negative amount returns 400 with standard error envelope', async () => {
    const res = await request(app)
      .post('/api/v1/contracts')
      .set({ ...auth(adminToken()), 'Idempotency-Key': randomUUID() })
      .send({ ...basePayload, milestones: [{ title: 'Bad', description: 'x', amount: -1 }] });

    expect(res.status).toBe(400);
    assertErrorEnvelope(res.body);
  });

  it('validation error envelope contains a details array', async () => {
    const res = await request(app)
      .post('/api/v1/contracts')
      .set({ ...auth(adminToken()), 'Idempotency-Key': randomUUID() })
      .send({ ...basePayload, milestones: [{ title: '', description: 'x', amount: 100 }] });

    expect(res.status).toBe(400);
    const error = res.body.error as Record<string, unknown>;
    expect(Array.isArray(error.details)).toBe(true);
    expect((error.details as unknown[]).length).toBeGreaterThan(0);
  });
});

// ─── Error shapes — 404 not_found ────────────────────────────────────────────

describe('Error response shape — 404 not_found', () => {
  const GHOST_ID = '00000000-0000-0000-0000-000000000000';

  it('GET on non-existent contract returns 404 with standard error envelope', async () => {
    const res = await request(app)
      .get(`/api/v1/contracts/${GHOST_ID}`)
      .set(auth(adminToken()));

    expect(res.status).toBe(404);
    assertErrorEnvelope(res.body);
    expect((res.body.error as Record<string, unknown>).code).toBe('not_found');
  });

  it('PATCH on non-existent contract returns 404 with standard error envelope', async () => {
    const res = await request(app)
      .patch(`/api/v1/contracts/${GHOST_ID}`)
      .set(auth(adminToken()))
      .send({ version: 0, title: 'Ghost Patch' });

    expect(res.status).toBe(404);
    assertErrorEnvelope(res.body);
  });
});

// ─── Error shapes — 409 conflict ─────────────────────────────────────────────

describe('Error response shape — 409 conflict', () => {
  it('stale OCC version returns 409 ERR_CONFLICT with standard error envelope', async () => {
    const create = await createContract();
    const { id, version } = create.body.data as { id: string; version: number };

    // Consume version
    await request(app)
      .patch(`/api/v1/contracts/${id}`)
      .set(auth(adminToken()))
      .send({ version, title: 'First Patch' });

    // Replay with stale version
    const res = await request(app)
      .patch(`/api/v1/contracts/${id}`)
      .set(auth(adminToken()))
      .send({ version, title: 'Stale Patch' });

    expect(res.status).toBe(409);
    assertErrorEnvelope(res.body);
    expect((res.body.error as Record<string, unknown>).code).toBe('ERR_CONFLICT');
  });

  it('idempotency key reuse with different body returns 409 conflict with standard error envelope', async () => {
    const key = `schema-conflict-${randomUUID()}`;

    await request(app)
      .post('/api/v1/contracts')
      .set({ ...auth(adminToken()), 'Idempotency-Key': key })
      .send({ ...basePayload, milestones: [{ title: 'Original', description: 'x', amount: 100 }] });

    const res = await request(app)
      .post('/api/v1/contracts')
      .set({ ...auth(adminToken()), 'Idempotency-Key': key })
      .send({ ...basePayload, milestones: [{ title: 'Different', description: 'y', amount: 200 }] });

    expect(res.status).toBe(409);
    assertErrorEnvelope(res.body);
    expect((res.body.error as Record<string, unknown>).code).toBe('conflict');
  });
});

// ─── Error shapes — 422 contract_bounds_error ────────────────────────────────

describe('Error response shape — 422 contract_bounds_error', () => {
  it(`exceeding ${MAX_MILESTONES_PER_CONTRACT} milestones returns 422 with standard error envelope`, async () => {
    const milestones = Array.from({ length: MAX_MILESTONES_PER_CONTRACT + 1 }, (_, i) => ({
      title: `MS-${i + 1}`,
      description: `Desc ${i + 1}`,
      amount: 100,
    }));

    const res = await request(app)
      .post('/api/v1/contracts')
      .set({ ...auth(adminToken()), 'Idempotency-Key': randomUUID() })
      .send({ ...basePayload, milestones });

    expect(res.status).toBe(422);
    assertErrorEnvelope(res.body);
    expect((res.body.error as Record<string, unknown>).code).toBe('contract_bounds_error');
  });

  it('milestone total exceeding budget returns 422 with standard error envelope', async () => {
    const milestones = [{ title: 'Over Budget', description: 'Exceeds', amount: basePayload.budget + 1 }];

    const res = await request(app)
      .post('/api/v1/contracts')
      .set({ ...auth(adminToken()), 'Idempotency-Key': randomUUID() })
      .send({ ...basePayload, milestones });

    expect(res.status).toBe(422);
    assertErrorEnvelope(res.body);
    expect((res.body.error as Record<string, unknown>).code).toBe('contract_bounds_error');
  });

  it('milestone amount exceeding MAX_CONTRACT_AMOUNT_STROOPS returns 400 or 422 with error envelope', async () => {
    const milestones = [{ title: 'Huge', description: 'Overflows cap', amount: MAX_CONTRACT_AMOUNT_STROOPS + 1 }];

    const res = await request(app)
      .post('/api/v1/contracts')
      .set({ ...auth(adminToken()), 'Idempotency-Key': randomUUID() })
      .send({ ...basePayload, milestones });

    expect([400, 422]).toContain(res.status);
    assertErrorEnvelope(res.body);
  });

  it('bounds error message is a non-empty string', async () => {
    const milestones = Array.from({ length: MAX_MILESTONES_PER_CONTRACT + 1 }, (_, i) => ({
      title: `MS-${i + 1}`,
      description: `Desc ${i + 1}`,
      amount: 100,
    }));

    const res = await request(app)
      .post('/api/v1/contracts')
      .set({ ...auth(adminToken()), 'Idempotency-Key': randomUUID() })
      .send({ ...basePayload, milestones });

    const error = res.body.error as Record<string, unknown>;
    expect(typeof error.message).toBe('string');
    expect((error.message as string).length).toBeGreaterThan(0);
  });
});

// ─── Idempotent replay — response shape consistency ───────────────────────────

describe('Idempotent replay — response shape consistency', () => {
  it('replayed POST returns identical body shape to the original', async () => {
    const key = `schema-replay-${randomUUID()}`;
    const milestones = [{ title: 'Replay MS', description: 'Idempotent', amount: 500 }];

    const first = await request(app)
      .post('/api/v1/contracts')
      .set({ ...auth(adminToken()), 'Idempotency-Key': key })
      .send({ ...basePayload, milestones });

    const second = await request(app)
      .post('/api/v1/contracts')
      .set({ ...auth(adminToken()), 'Idempotency-Key': key })
      .send({ ...basePayload, milestones });

    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    assertSuccessEnvelope(second.body);
    assertContractDataShape(second.body.data as Record<string, unknown>);
  });
});
