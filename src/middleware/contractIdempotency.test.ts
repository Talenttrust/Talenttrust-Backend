/**
 * Integration tests for contract creation idempotency middleware.
 *
 * Covers:
 * - 401 when req.user is missing (security: fail closed)
 * - 400 when Idempotency-Key header is missing
 * - 400 when Idempotency-Key header is empty/whitespace
 * - 201 + stores response on first request
 * - 200 + replays cached response on retry with same key + same body
 * - 409 when same key is reused with different body
 * - Idempotency-Replayed header is set on replay
 * - Scoped keys: different users with same key get independent results
 * - Regression: two unauthenticated callers cannot collide (both get 401)
 * - Payload hash is computed correctly (order-independent JSON)
 */

// Set env vars before any module import
process.env.JWT_SECRET = 'idempotency-test-secret';
process.env.DB_PATH = ':memory:';

import request from 'supertest';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { createApp } from '../app';
import { getDb, closeDb } from '../db/database';
import { defaultIdempotencyStore } from '../db/idempotencyStore';

// ─── Constants ────────────────────────────────────────────────────────────────

const SECRET = process.env.JWT_SECRET as string;
const BASE = '/api/v1/contracts';

// ─── Token helpers ────────────────────────────────────────────────────────────

function makeToken(
  role: string,
  sub = 'user-1',
  expiresIn: string | number = '1h',
): string {
  return jwt.sign({ sub, email: `${sub}@test.com`, role }, SECRET, {
    expiresIn,
  } as jwt.SignOptions) as string;
}

const adminToken = (sub = 'admin-1') => makeToken('admin', sub);
const clientToken = (sub = 'client-1') => makeToken('client', sub);

function auth(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

// ─── Payload helpers ──────────────────────────────────────────────────────────

const CLIENT_ID = '00000000-0000-0000-0000-000000000001';
const FREELANCER_ID = '00000000-0000-0000-0000-000000000002';

const validContract = (overrides: Record<string, unknown> = {}) => ({
  title: 'Test Contract',
  description: 'This is a test contract with sufficient length.',
  clientId: CLIENT_ID,
  freelancerId: FREELANCER_ID,
  budget: 5000,
  ...overrides,
});

// ─── App / DB lifecycle ───────────────────────────────────────────────────────

let app: ReturnType<typeof createApp>;

beforeAll(() => {
  const db = getDb();
  app = createApp({ includeTerminalHandlers: true });

  // Seed users for FK constraints
  const now = new Date().toISOString();
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
  getDb().exec('DELETE FROM contracts');
  defaultIdempotencyStore.clear();
});

afterAll(() => {
  closeDb();
});

// =============================================================================
// Security: Fail closed when req.user is missing
// =============================================================================

describe('Security: Fail closed on unauthenticated requests', () => {
  it('returns 401 when no Authorization header is present', async () => {
    const res = await request(app)
      .post(BASE)
      .set('Idempotency-Key', crypto.randomUUID())
      .send(validContract());

    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe('unauthorized');
  });

  it('returns 401 when auth middleware rejects (no Authorization header)', async () => {
    const res = await request(app)
      .post(BASE)
      .set('Idempotency-Key', crypto.randomUUID())
      .send(validContract());

    expect(res.status).toBe(401);
    // The requireAuth middleware responds first, before idempotency middleware runs
    expect(res.body.error?.message).toMatch(/Authorization/i);
  });

  it('returns 401 for expired token even with valid Idempotency-Key', async () => {
    const expired = makeToken('admin', 'admin-1', -1);
    const res = await request(app)
      .post(BASE)
      .set(auth(expired))
      .set('Idempotency-Key', crypto.randomUUID())
      .send(validContract());

    expect(res.status).toBe(401);
  });

  /**
   * Regression test: Two different unauthenticated callers with the same
   * Idempotency-Key must NOT collide in a shared scope. Both should get 401.
   */
  it('regression: two unauthenticated callers with same key both get 401 (no shared scope)', async () => {
    const sharedKey = crypto.randomUUID();
    const payload1 = validContract({ title: 'Caller 1 Contract' });
    const payload2 = validContract({ title: 'Caller 2 Contract' });

    // First unauthenticated request
    const res1 = await request(app)
      .post(BASE)
      .set('Idempotency-Key', sharedKey)
      .send(payload1);

    expect(res1.status).toBe(401);

    // Second unauthenticated request with same key but different payload
    const res2 = await request(app)
      .post(BASE)
      .set('Idempotency-Key', sharedKey)
      .send(payload2);

    expect(res2.status).toBe(401);
    // Neither request should have been stored or created a contract
    expect(defaultIdempotencyStore.size()).toBe(0);
  });
});

// =============================================================================
// Idempotency-Key header validation
// =============================================================================

describe('Idempotency-Key header validation', () => {
  it('returns 400 when Idempotency-Key header is absent', async () => {
    const res = await request(app)
      .post(BASE)
      .set(auth(adminToken()))
      .send(validContract());

    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('bad_request');
    expect(res.body.error?.message).toMatch(/Idempotency-Key/i);
  });

  it('returns 400 when Idempotency-Key is an empty string', async () => {
    const res = await request(app)
      .post(BASE)
      .set(auth(adminToken()))
      .set('Idempotency-Key', '')
      .send(validContract());

    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('bad_request');
  });

  it('returns 400 when Idempotency-Key is all whitespace', async () => {
    const res = await request(app)
      .post(BASE)
      .set(auth(adminToken()))
      .set('Idempotency-Key', '   ')
      .send(validContract());

    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('bad_request');
  });

  it('every 400 error response includes a requestId field', async () => {
    const res = await request(app)
      .post(BASE)
      .set(auth(adminToken()))
      .send(validContract());

    expect(res.status).toBe(400);
    expect(res.body.error).toHaveProperty('requestId');
    expect(typeof res.body.error.requestId).toBe('string');
  });
});

// =============================================================================
// First-request: successful contract creation and storage
// =============================================================================

describe('First request: contract creation', () => {
  it('returns 201 and creates the contract on first request', async () => {
    const key = crypto.randomUUID();
    const res = await request(app)
      .post(BASE)
      .set(auth(adminToken()))
      .set('Idempotency-Key', key)
      .send(validContract());

    expect(res.status).toBe(201);
    expect(res.body.data).toHaveProperty('id');
    expect(res.body.data.title).toBe('Test Contract');
  });

  it('does NOT set Idempotency-Replayed header on first request', async () => {
    const key = crypto.randomUUID();
    const res = await request(app)
      .post(BASE)
      .set(auth(adminToken()))
      .set('Idempotency-Key', key)
      .send(validContract());

    expect(res.status).toBe(201);
    expect(res.headers['idempotency-replayed']).toBeUndefined();
  });

  it('stores exactly one entry in the idempotency store after creation', async () => {
    const key = crypto.randomUUID();
    await request(app)
      .post(BASE)
      .set(auth(adminToken()))
      .set('Idempotency-Key', key)
      .send(validContract());

    expect(defaultIdempotencyStore.size()).toBe(1);
  });
});

// =============================================================================
// Replay: same key + same body returns cached response
// =============================================================================

describe('Replay: same key + same body', () => {
  it('returns the same response body on retry', async () => {
    const key = crypto.randomUUID();
    const payload = validContract();

    const first = await request(app)
      .post(BASE)
      .set(auth(adminToken()))
      .set('Idempotency-Key', key)
      .send(payload);

    const second = await request(app)
      .post(BASE)
      .set(auth(adminToken()))
      .set('Idempotency-Key', key)
      .send(payload);

    expect(second.status).toBe(first.status);
    expect(second.body).toEqual(first.body);
  });

  it('sets Idempotency-Replayed: true header on replay', async () => {
    const key = crypto.randomUUID();
    const payload = validContract();

    await request(app)
      .post(BASE)
      .set(auth(adminToken()))
      .set('Idempotency-Key', key)
      .send(payload);

    const second = await request(app)
      .post(BASE)
      .set(auth(adminToken()))
      .set('Idempotency-Key', key)
      .send(payload);

    expect(second.headers['idempotency-replayed']).toBe('true');
  });

  it('does not create a duplicate contract on replay', async () => {
    const key = crypto.randomUUID();
    const payload = validContract();

    await request(app)
      .post(BASE)
      .set(auth(adminToken()))
      .set('Idempotency-Key', key)
      .send(payload);

    await request(app)
      .post(BASE)
      .set(auth(adminToken()))
      .set('Idempotency-Key', key)
      .send(payload);

    // Only one contract should exist in the DB
    const listRes = await request(app)
      .get(BASE)
      .set(auth(adminToken()));
    const items = Array.isArray(listRes.body.data)
      ? listRes.body.data
      : (listRes.body.data?.data ?? []);
    expect(items).toHaveLength(1);
  });

  it('stores only one entry in the idempotency store after two identical requests', async () => {
    const key = crypto.randomUUID();
    const payload = validContract();

    await request(app)
      .post(BASE)
      .set(auth(adminToken()))
      .set('Idempotency-Key', key)
      .send(payload);

    await request(app)
      .post(BASE)
      .set(auth(adminToken()))
      .set('Idempotency-Key', key)
      .send(payload);

    expect(defaultIdempotencyStore.size()).toBe(1);
  });

  it('replay returns the same contract id (idempotent response)', async () => {
    const key = crypto.randomUUID();
    const payload = validContract();

    const first = await request(app)
      .post(BASE)
      .set(auth(adminToken()))
      .set('Idempotency-Key', key)
      .send(payload);

    const second = await request(app)
      .post(BASE)
      .set(auth(adminToken()))
      .set('Idempotency-Key', key)
      .send(payload);

    expect(second.body.data.id).toBe(first.body.data.id);
  });

  it('body property order does not affect replay (order-independent hash)', async () => {
    const key = crypto.randomUUID();

    // First request with keys in one order
    const first = await request(app)
      .post(BASE)
      .set(auth(adminToken()))
      .set('Idempotency-Key', key)
      .send({
        title: 'Test Contract',
        budget: 5000,
        description: 'This is a test contract with sufficient length.',
        clientId: CLIENT_ID,
        freelancerId: FREELANCER_ID,
      });

    expect(first.status).toBe(201);

    // Replay with keys in different order — should hit the cache
    const second = await request(app)
      .post(BASE)
      .set(auth(adminToken()))
      .set('Idempotency-Key', key)
      .send({
        freelancerId: FREELANCER_ID,
        clientId: CLIENT_ID,
        description: 'This is a test contract with sufficient length.',
        budget: 5000,
        title: 'Test Contract',
      });

    expect(second.headers['idempotency-replayed']).toBe('true');
    expect(second.body.data.id).toBe(first.body.data.id);
  });
});

// =============================================================================
// Conflict: same key + different body → 409
// =============================================================================

describe('Conflict: same key + different body', () => {
  it('returns 409 when same key is reused with different body', async () => {
    const key = crypto.randomUUID();

    await request(app)
      .post(BASE)
      .set(auth(adminToken()))
      .set('Idempotency-Key', key)
      .send(validContract({ title: 'First Title' }));

    const conflict = await request(app)
      .post(BASE)
      .set(auth(adminToken()))
      .set('Idempotency-Key', key)
      .send(validContract({ title: 'Different Title' }));

    expect(conflict.status).toBe(409);
    expect(conflict.body.error?.code).toBe('conflict');
  });

  it('conflict response includes descriptive message', async () => {
    const key = crypto.randomUUID();

    await request(app)
      .post(BASE)
      .set(auth(adminToken()))
      .set('Idempotency-Key', key)
      .send(validContract({ budget: 1000 }));

    const conflict = await request(app)
      .post(BASE)
      .set(auth(adminToken()))
      .set('Idempotency-Key', key)
      .send(validContract({ budget: 2000 }));

    expect(conflict.status).toBe(409);
    expect(conflict.body.error?.message).toMatch(/different request body/i);
  });

  it('does not create a contract when body conflict is detected', async () => {
    const key = crypto.randomUUID();

    await request(app)
      .post(BASE)
      .set(auth(adminToken()))
      .set('Idempotency-Key', key)
      .send(validContract({ title: 'First Title' }));

    await request(app)
      .post(BASE)
      .set(auth(adminToken()))
      .set('Idempotency-Key', key)
      .send(validContract({ title: 'Different Title' }));

    // Only the first contract should exist
    const listRes = await request(app)
      .get(BASE)
      .set(auth(adminToken()));
    const items = Array.isArray(listRes.body.data)
      ? listRes.body.data
      : (listRes.body.data?.data ?? []);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('First Title');
  });

  it('409 response includes requestId', async () => {
    const key = crypto.randomUUID();

    await request(app)
      .post(BASE)
      .set(auth(adminToken()))
      .set('Idempotency-Key', key)
      .send(validContract({ budget: 1000 }));

    const conflict = await request(app)
      .post(BASE)
      .set(auth(adminToken()))
      .set('Idempotency-Key', key)
      .send(validContract({ budget: 2000 }));

    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toHaveProperty('requestId');
  });
});

// =============================================================================
// Scoped keys: different users with same key get independent results
// =============================================================================

describe('Scoped keys: per-user isolation', () => {
  it('two different users with same Idempotency-Key create separate contracts', async () => {
    const sharedKey = crypto.randomUUID();
    const user1Token = adminToken('user-1');
    const user2Token = adminToken('user-2');

    const res1 = await request(app)
      .post(BASE)
      .set(auth(user1Token))
      .set('Idempotency-Key', sharedKey)
      .send(validContract({ title: 'User 1 Contract' }));

    const res2 = await request(app)
      .post(BASE)
      .set(auth(user2Token))
      .set('Idempotency-Key', sharedKey)
      .send(validContract({ title: 'User 2 Contract' }));

    expect(res1.status).toBe(201);
    expect(res2.status).toBe(201);
    expect(res1.body.data.id).not.toBe(res2.body.data.id);
    expect(res1.body.data.title).toBe('User 1 Contract');
    expect(res2.body.data.title).toBe('User 2 Contract');
  });

  it('user 1 replays their own cached response, not user 2\'s', async () => {
    const sharedKey = crypto.randomUUID();
    const user1Token = adminToken('user-1');
    const user2Token = adminToken('user-2');

    // User 1 creates contract
    const user1First = await request(app)
      .post(BASE)
      .set(auth(user1Token))
      .set('Idempotency-Key', sharedKey)
      .send(validContract({ title: 'User 1 Contract' }));

    // User 2 creates a different contract with same key
    await request(app)
      .post(BASE)
      .set(auth(user2Token))
      .set('Idempotency-Key', sharedKey)
      .send(validContract({ title: 'User 2 Contract' }));

    // User 1 replays — should get their own original response
    const user1Replay = await request(app)
      .post(BASE)
      .set(auth(user1Token))
      .set('Idempotency-Key', sharedKey)
      .send(validContract({ title: 'User 1 Contract' }));

    expect(user1Replay.headers['idempotency-replayed']).toBe('true');
    expect(user1Replay.body.data.id).toBe(user1First.body.data.id);
    expect(user1Replay.body.data.title).toBe('User 1 Contract');
  });

  it('stores two separate entries for two different users with same key', async () => {
    const sharedKey = crypto.randomUUID();
    const user1Token = adminToken('user-1');
    const user2Token = adminToken('user-2');

    await request(app)
      .post(BASE)
      .set(auth(user1Token))
      .set('Idempotency-Key', sharedKey)
      .send(validContract());

    await request(app)
      .post(BASE)
      .set(auth(user2Token))
      .set('Idempotency-Key', sharedKey)
      .send(validContract());

    expect(defaultIdempotencyStore.size()).toBe(2);
  });

  it('user-scoped keys are isolated even with identical payloads', async () => {
    const sharedKey = crypto.randomUUID();
    const user1Token = adminToken('user-1');
    const user2Token = adminToken('user-2');
    const identicalPayload = validContract({ title: 'Identical Title' });

    const res1 = await request(app)
      .post(BASE)
      .set(auth(user1Token))
      .set('Idempotency-Key', sharedKey)
      .send(identicalPayload);

    const res2 = await request(app)
      .post(BASE)
      .set(auth(user2Token))
      .set('Idempotency-Key', sharedKey)
      .send(identicalPayload);

    expect(res1.status).toBe(201);
    expect(res2.status).toBe(201);
    expect(res1.body.data.id).not.toBe(res2.body.data.id);
  });
});

// =============================================================================
// Edge cases and additional coverage
// =============================================================================

describe('Edge cases', () => {
  it('whitespace in Idempotency-Key is trimmed and cached correctly', async () => {
    const keyWithSpaces = `  ${crypto.randomUUID()}  `;
    const trimmedKey = keyWithSpaces.trim();

    // First request with spaces
    const first = await request(app)
      .post(BASE)
      .set(auth(adminToken()))
      .set('Idempotency-Key', keyWithSpaces)
      .send(validContract());

    expect(first.status).toBe(201);

    // Second request with trimmed key — should hit the cache
    const second = await request(app)
      .post(BASE)
      .set(auth(adminToken()))
      .set('Idempotency-Key', trimmedKey)
      .send(validContract());

    expect(second.headers['idempotency-replayed']).toBe('true');
    expect(second.body.data.id).toBe(first.body.data.id);
  });

  it('client role can use idempotency (not admin-only)', async () => {
    const key = crypto.randomUUID();
    const res = await request(app)
      .post(BASE)
      .set(auth(clientToken()))
      .set('Idempotency-Key', key)
      .send(validContract());

    expect(res.status).toBe(201);
  });

  it('multiple different idempotency keys from same user create separate contracts', async () => {
    const key1 = crypto.randomUUID();
    const key2 = crypto.randomUUID();
    const token = adminToken();

    const res1 = await request(app)
      .post(BASE)
      .set(auth(token))
      .set('Idempotency-Key', key1)
      .send(validContract({ title: 'Contract 1' }));

    const res2 = await request(app)
      .post(BASE)
      .set(auth(token))
      .set('Idempotency-Key', key2)
      .send(validContract({ title: 'Contract 2' }));

    expect(res1.status).toBe(201);
    expect(res2.status).toBe(201);
    expect(res1.body.data.id).not.toBe(res2.body.data.id);
  });

  it('nested object changes in payload are detected (conflict)', async () => {
    const key = crypto.randomUUID();

    await request(app)
      .post(BASE)
      .set(auth(adminToken()))
      .set('Idempotency-Key', key)
      .send(
        validContract({
          milestones: [{ title: 'Milestone 1', amount: 1000 }],
        }),
      );

    const conflict = await request(app)
      .post(BASE)
      .set(auth(adminToken()))
      .set('Idempotency-Key', key)
      .send(
        validContract({
          milestones: [{ title: 'Milestone 1', amount: 2000 }],
        }),
      );

    expect(conflict.status).toBe(409);
  });
});
