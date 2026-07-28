/**
 * Integration tests for the Milestones endpoint family.
 *
 * Milestones in TalentTrust are a first-class field on the Contract resource.
 * They are created, updated, and validated as part of:
 *   POST   /api/v1/contracts        (create with milestones)
 *   PATCH  /api/v1/contracts/:id    (update milestones on an existing contract)
 *   GET    /api/v1/contracts/:id    (read back the stored milestone shape)
 *
 * Test coverage:
 *   ✓ Success paths          – create and update with valid milestone arrays
 *   ✓ Not-found paths        – milestone operations on non-existent contracts
 *   ✓ Validation-failure     – structural (Zod) and business-rule (bounds) rejections
 *   ✓ Idempotent-repeat      – replaying the same PATCH returns consistent results
 */

// Must be set before any import so singletons pick them up.
process.env.JWT_SECRET = 'milestones-test-secret';
process.env.DB_PATH = ':memory:';

import request from 'supertest';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { closeDb, getDb } from '../db/database';
import app from '../index';
import {
  MAX_MILESTONES_PER_CONTRACT,
  MAX_CONTRACT_AMOUNT_STROOPS,
} from '../contracts/bounds';

// ─── Token helpers ─────────────────────────────────────────────────────────────

const SECRET = process.env.JWT_SECRET as string;

const CLIENT_ID     = '00000000-0000-0000-0000-000000000011';
const FREELANCER_ID = '00000000-0000-0000-0000-000000000012';

function makeToken(role: string, sub = 'user-1'): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return jwt.sign({ sub, email: `${sub}@test.com`, role }, SECRET, { expiresIn: '1h' } as any) as string;
}

const adminToken     = () => makeToken('admin', 'admin-1');
const clientToken    = (id = CLIENT_ID) => makeToken('client', id);

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

// ─── Shared contract payload ────────────────────────────────────────────────────

const basePayload = {
  title: 'Milestones Integration Test Contract',
  description: 'Contract used exclusively for milestone-focused integration tests.',
  clientId: CLIENT_ID,
  freelancerId: FREELANCER_ID,
  budget: 10_000,
};

// ─── Seed users so FK constraints pass ──────────────────────────────────────────

beforeAll(() => {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO users (id, username, email, role, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(CLIENT_ID, 'milclient', 'milclient@test.com', 'client', now);
  db.prepare(
    `INSERT OR IGNORE INTO users (id, username, email, role, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(FREELANCER_ID, 'milfreelancer', 'milfreelancer@test.com', 'freelancer', now);
});

beforeEach(() => {
  getDb().exec('DELETE FROM contracts');
});

afterAll(() => {
  closeDb();
});

// ─── Helpers ────────────────────────────────────────────────────────────────────

async function createContract(
  overrides: Record<string, unknown> = {},
): Promise<{ id: string; version: number }> {
  const res = await request(app)
    .post('/api/v1/contracts')
    .set({ ...auth(adminToken()), 'Idempotency-Key': randomUUID() })
    .send({ ...basePayload, ...overrides });
  expect(res.status).toBe(201);
  return { id: res.body.data.id as string, version: res.body.data.version as number };
}

async function fetchContract(id: string): Promise<{ id: string; version: number; milestones?: unknown }> {
  const res = await request(app)
    .get(`/api/v1/contracts/${id}`)
    .set(auth(adminToken()));
  expect(res.status).toBe(200);
  return res.body.data as { id: string; version: number };
}

async function patchContract(
  id: string,
  version: number,
  fields: Record<string, unknown>,
): Promise<request.Response> {
  return request(app)
    .patch(`/api/v1/contracts/${id}`)
    .set(auth(adminToken()))
    .send({ version, ...fields });
}

// ─── Success paths ─────────────────────────────────────────────────────────────

describe('Milestone success paths', () => {
  it('creates a contract with a single valid milestone and returns 201', async () => {
    const milestones = [{ title: 'Kickoff', description: 'Project start', amount: 1000 }];
    const res = await request(app)
      .post('/api/v1/contracts')
      .set({ ...auth(adminToken()), 'Idempotency-Key': randomUUID() })
      .send({ ...basePayload, milestones });
    expect(res.status).toBe(201);
    expect(res.body.data).toHaveProperty('id');
  });

  it('creates a contract with multiple valid milestones where total < budget', async () => {
    const milestones = [
      { title: 'Phase 1', description: 'Design', amount: 2000 },
      { title: 'Phase 2', description: 'Development', amount: 5000 },
      { title: 'Phase 3', description: 'Testing', amount: 2000 },
    ];
    const res = await request(app)
      .post('/api/v1/contracts')
      .set({ ...auth(adminToken()), 'Idempotency-Key': randomUUID() })
      .send({ ...basePayload, milestones });
    expect(res.status).toBe(201);
    expect(res.body.data).toHaveProperty('id');
  });

  it(`accepts exactly ${MAX_MILESTONES_PER_CONTRACT} milestones (the maximum allowed)`, async () => {
    const milestones = Array.from({ length: MAX_MILESTONES_PER_CONTRACT }, (_, i) => ({
      title: `MS-${i + 1}`,
      description: `Milestone ${i + 1}`,
      amount: Math.floor(basePayload.budget / MAX_MILESTONES_PER_CONTRACT),
    }));
    const res = await request(app)
      .post('/api/v1/contracts')
      .set({ ...auth(adminToken()), 'Idempotency-Key': randomUUID() })
      .send({ ...basePayload, milestones });
    expect(res.status).toBe(201);
  });

  it('creates a contract with milestones totalling exactly the budget', async () => {
    const milestones = [
      { title: 'Full budget milestone', description: 'Entire budget allocated', amount: basePayload.budget },
    ];
    const res = await request(app)
      .post('/api/v1/contracts')
      .set({ ...auth(adminToken()), 'Idempotency-Key': randomUUID() })
      .send({ ...basePayload, milestones });
    expect(res.status).toBe(201);
  });

  it('creates a contract without milestones (milestones field is optional)', async () => {
    const { id } = await createContract();
    const contract = await fetchContract(id);
    expect(contract.id).toBe(id);
  });

  it('patches a contract to update title and returns 200 with incremented version', async () => {
    const { id, version } = await createContract();
    const res = await patchContract(id, version, { title: 'Updated Title Here' });
    expect(res.status).toBe(200);
    expect(res.body.data.version).toBe(version + 1);
  });

  it('patches a contract to add milestones and returns 200', async () => {
    const { id, version } = await createContract();
    const milestones = [
      { title: 'Added MS', description: 'Post-create milestone', amount: 500 },
    ];
    const res = await patchContract(id, version, { milestones });
    expect(res.status).toBe(200);
  });

  it('client owner can patch milestones on their own contract', async () => {
    const res = await request(app)
      .post('/api/v1/contracts')
      .set({ ...auth(clientToken(CLIENT_ID)), 'Idempotency-Key': randomUUID() })
      .send({ ...basePayload, milestones: [{ title: 'Initial MS', description: 'Start', amount: 100 }] });
    expect(res.status).toBe(201);

    const { id, version } = { id: res.body.data.id as string, version: res.body.data.version as number };

    const patch = await request(app)
      .patch(`/api/v1/contracts/${id}`)
      .set(auth(clientToken(CLIENT_ID)))
      .send({ version, milestones: [{ title: 'Updated MS', description: 'Revised', amount: 200 }] });
    expect(patch.status).toBe(200);
  });

  it('returns compressed response when response is above threshold and Accept-Encoding is gzip', async () => {
    // Generate a large payload by fetching multiple contracts
    const promises = Array.from({ length: 15 }).map((_, i) =>
      request(app)
        .post('/api/v1/contracts')
        .set({ ...auth(clientToken(CLIENT_ID)), 'Idempotency-Key': randomUUID() })
        .send({ ...basePayload, title: `Title ${i}`, description: 'A very long description '.repeat(20) })
    );
    await Promise.all(promises);

    const res = await request(app)
      .get('/api/v1/contracts?limit=20')
      .set({ ...auth(adminToken()), 'Accept-Encoding': 'gzip' });
      
    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBe('gzip');
  });

  it('returns uncompressed response when response is below threshold', async () => {
    const milestones = [
      { title: 'Small MS', description: 'Tiny', amount: 100 }
    ];
    const res = await request(app)
      .post('/api/v1/contracts')
      .set({ ...auth(adminToken()), 'Idempotency-Key': randomUUID(), 'Accept-Encoding': 'gzip' })
      .send({ ...basePayload, milestones });
    expect(res.status).toBe(201);
    expect(res.headers['content-encoding']).toBeUndefined();
  });
});

// ─── Not-found paths ──────────────────────────────────────────────────────────

describe('Milestone not-found paths', () => {
  const GHOST_ID = '00000000-0000-0000-0000-000000000000';

  it('returns 404 when patching milestones on a non-existent contract', async () => {
    const res = await patchContract(GHOST_ID, 0, {
      milestones: [{ title: 'Ghost MS', description: 'Ghost description', amount: 100 }],
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toHaveProperty('code');
    expect(res.body.error).toHaveProperty('message');
  });

  it('returns 404 when fetching a contract that does not exist', async () => {
    const res = await request(app)
      .get(`/api/v1/contracts/${GHOST_ID}`)
      .set(auth(adminToken()));
    expect(res.status).toBe(404);
    expect(res.body.error).toHaveProperty('code');
    expect(res.body.error).toHaveProperty('requestId');
  });

  it('error envelope on 404 contains code, message, and requestId', async () => {
    const res = await patchContract(GHOST_ID, 0, { title: 'No Such Contract' });
    expect(res.status).toBe(404);
    expect(res.body.error).toHaveProperty('code');
    expect(res.body.error).toHaveProperty('message');
    expect(res.body.error).toHaveProperty('requestId');
  });
});

// ─── Validation-failure paths ─────────────────────────────────────────────────

describe('Milestone validation-failure paths', () => {
  it('returns 400 when a milestone title is empty string', async () => {
    const milestones = [{ title: '', description: 'Empty title', amount: 500 }];
    const res = await request(app)
      .post('/api/v1/contracts')
      .set({ ...auth(adminToken()), 'Idempotency-Key': randomUUID() })
      .send({ ...basePayload, milestones });
    expect(res.status).toBe(400);
  });

  it('returns 400 when a milestone amount is negative', async () => {
    const milestones = [{ title: 'Bad Amount', description: 'Negative amount', amount: -500 }];
    const res = await request(app)
      .post('/api/v1/contracts')
      .set({ ...auth(adminToken()), 'Idempotency-Key': randomUUID() })
      .send({ ...basePayload, milestones });
    expect(res.status).toBe(400);
  });

  it('returns 400 when a milestone amount is zero', async () => {
    const milestones = [{ title: 'Zero Amount', description: 'Zero amount', amount: 0 }];
    const res = await request(app)
      .post('/api/v1/contracts')
      .set({ ...auth(adminToken()), 'Idempotency-Key': randomUUID() })
      .send({ ...basePayload, milestones });
    expect(res.status).toBe(400);
  });

  it('returns 400 when a milestone is missing its title field', async () => {
    const milestones = [{ description: 'No title field', amount: 500 }];
    const res = await request(app)
      .post('/api/v1/contracts')
      .set({ ...auth(adminToken()), 'Idempotency-Key': randomUUID() })
      .send({ ...basePayload, milestones });
    expect(res.status).toBe(400);
  });

  it('returns 400 when a milestone is missing its amount field', async () => {
    const milestones = [{ title: 'No Amount', description: 'Missing amount' }];
    const res = await request(app)
      .post('/api/v1/contracts')
      .set({ ...auth(adminToken()), 'Idempotency-Key': randomUUID() })
      .send({ ...basePayload, milestones });
    expect(res.status).toBe(400);
  });

  it(`returns 422 with contract_bounds_error when milestone count exceeds ${MAX_MILESTONES_PER_CONTRACT}`, async () => {
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
    expect(res.body.error).toMatchObject({ code: 'contract_bounds_error' });
  });

  it('returns 422 when total milestone amount exceeds MAX_CONTRACT_AMOUNT_STROOPS', async () => {
    const milestones = [{ title: 'Huge MS', description: 'Overflows cap', amount: MAX_CONTRACT_AMOUNT_STROOPS + 1 }];
    const res = await request(app)
      .post('/api/v1/contracts')
      // budget must itself pass the per-field Zod max; use an overridden large budget via service layer
      .set({ ...auth(adminToken()), 'Idempotency-Key': randomUUID() })
      .send({ ...basePayload, milestones });
    // Either Zod (400) or bounds layer (422) rejects — both are correct rejections
    expect([400, 422]).toContain(res.status);
    expect(res.body.error).toHaveProperty('code');
  });

  it('returns 422 when milestone total exceeds the contract budget', async () => {
    const milestones = [
      { title: 'Exceeds Budget', description: 'Total over budget', amount: basePayload.budget + 1 },
    ];
    const res = await request(app)
      .post('/api/v1/contracts')
      .set({ ...auth(adminToken()), 'Idempotency-Key': randomUUID() })
      .send({ ...basePayload, milestones });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({ code: 'contract_bounds_error' });
  });

  it('returns 422 when patching milestones pushes count over the limit', async () => {
    const { id, version } = await createContract();
    const tooMany = Array.from({ length: MAX_MILESTONES_PER_CONTRACT + 1 }, (_, i) => ({
      title: `MS-${i + 1}`,
      description: `Desc ${i + 1}`,
      amount: 100,
    }));
    const res = await patchContract(id, version, { milestones: tooMany });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({ code: 'contract_bounds_error' });
  });

  it('validation error envelope has code, message, and requestId', async () => {
    const milestones = [{ title: '', description: 'Empty title', amount: 500 }];
    const res = await request(app)
      .post('/api/v1/contracts')
      .set({ ...auth(adminToken()), 'Idempotency-Key': randomUUID() })
      .send({ ...basePayload, milestones });
    expect(res.status).toBe(400);
    expect(res.body.error).toHaveProperty('code');
    expect(res.body.error).toHaveProperty('message');
    expect(res.body.error).toHaveProperty('requestId');
  });

  // ── Regression: malformed milestones shape (issue #923) ───────────────
  //
  // These document that the DTO/Zod layer rejects malformed `milestones`
  // shapes before the request ever reaches validateContractBounds — the
  // same malformed shapes that, at the unit level (src/contracts/bounds.test.ts),
  // previously threw an uncaught TypeError instead of a graceful result when
  // passed directly to that function. Two independent layers now guard
  // against the same class of malformed input.
  it('returns 400 (not a 500 crash) when milestones is null', async () => {
    const res = await request(app)
      .post('/api/v1/contracts')
      .set({ ...auth(adminToken()), 'Idempotency-Key': randomUUID() })
      .send({ ...basePayload, milestones: null });
    expect(res.status).toBe(400);
  });

  it('returns 400 (not a 500 crash) when milestones is a string, not an array', async () => {
    const res = await request(app)
      .post('/api/v1/contracts')
      .set({ ...auth(adminToken()), 'Idempotency-Key': randomUUID() })
      .send({ ...basePayload, milestones: 'not-an-array' });
    expect(res.status).toBe(400);
  });

  it('returns 400 (not a 500 crash) when the milestones array contains a null entry', async () => {
    const res = await request(app)
      .post('/api/v1/contracts')
      .set({ ...auth(adminToken()), 'Idempotency-Key': randomUUID() })
      .send({ ...basePayload, milestones: [null] });
    expect(res.status).toBe(400);
  });

  it('returns 400 (not a 500 crash) when a milestone amount is NaN-producing (non-numeric string)', async () => {
    const milestones = [{ title: 'Bad Amount', description: 'Non-numeric amount', amount: 'lots' }];
    const res = await request(app)
      .post('/api/v1/contracts')
      .set({ ...auth(adminToken()), 'Idempotency-Key': randomUUID() })
      .send({ ...basePayload, milestones });
    expect(res.status).toBe(400);
  });
});

// ─── Idempotent-repeat paths ──────────────────────────────────────────────────

describe('Milestone idempotent-repeat paths', () => {
  it('replaying POST with same Idempotency-Key returns identical body (idempotent create with milestones)', async () => {
    const idempotencyKey = `ms-idem-${randomUUID()}`;
    const milestones = [{ title: 'Idem MS', description: 'Idempotent milestone', amount: 1000 }];

    const first = await request(app)
      .post('/api/v1/contracts')
      .set({ ...auth(adminToken()), 'Idempotency-Key': idempotencyKey })
      .send({ ...basePayload, milestones });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post('/api/v1/contracts')
      .set({ ...auth(adminToken()), 'Idempotency-Key': idempotencyKey })
      .send({ ...basePayload, milestones });
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
  });

  it('replaying POST with same key but different milestones returns 409 Conflict', async () => {
    const idempotencyKey = `ms-conflict-${randomUUID()}`;
    const milestones1 = [{ title: 'Original MS', description: 'Original', amount: 1000 }];
    const milestones2 = [{ title: 'Different MS', description: 'Different', amount: 2000 }];

    const first = await request(app)
      .post('/api/v1/contracts')
      .set({ ...auth(adminToken()), 'Idempotency-Key': idempotencyKey })
      .send({ ...basePayload, milestones: milestones1 });
    expect(first.status).toBe(201);

    const replay = await request(app)
      .post('/api/v1/contracts')
      .set({ ...auth(adminToken()), 'Idempotency-Key': idempotencyKey })
      .send({ ...basePayload, milestones: milestones2 });
    expect(replay.status).toBe(409);
    expect(replay.body.error).toMatchObject({ code: 'conflict' });
  });

  it('patching the same milestone data with correct version succeeds each time', async () => {
    const { id, version: v0 } = await createContract();

    const patch1 = await patchContract(id, v0, {
      milestones: [{ title: 'Phase A', description: 'First patch', amount: 500 }],
    });
    expect(patch1.status).toBe(200);
    const v1 = (patch1.body as { data: { version: number } }).data.version;

    const patch2 = await patchContract(id, v1, {
      milestones: [{ title: 'Phase B', description: 'Second patch', amount: 800 }],
    });
    expect(patch2.status).toBe(200);
    const v2 = (patch2.body as { data: { version: number } }).data.version;

    expect(v1).toBe(v0 + 1);
    expect(v2).toBe(v1 + 1);
  });

  it('replaying a PATCH with a stale version returns 409 (version conflict)', async () => {
    const { id, version } = await createContract();

    // First PATCH succeeds, consuming this version
    const first = await patchContract(id, version, { title: 'First Patch Title' });
    expect(first.status).toBe(200);

    // Replay with the now-stale version → 409
    const replay = await patchContract(id, version, { title: 'Replay Patch Title' });
    expect(replay.status).toBe(409);
    expect(replay.body.error).toMatchObject({ code: 'ERR_CONFLICT' });
  });

  it('patching with the correct refreshed version after a conflict succeeds', async () => {
    const { id, version: v0 } = await createContract();

    // Consume v0
    const first = await patchContract(id, v0, { title: 'First Patch Again' });
    expect(first.status).toBe(200);
    const v1 = (first.body as { data: { version: number } }).data.version;

    // Retry with correct version v1
    const retry = await patchContract(id, v1, { title: 'Retry Patch Title' });
    expect(retry.status).toBe(200);
  });
});
