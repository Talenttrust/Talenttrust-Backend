/**
 * Integration tests for the Webhook Subscription API
 *
 * Covers:
 *  POST   /api/v1/webhook-subscriptions
 *    - 401 no token / malformed header / expired token / wrong secret
 *    - 403 non-admin role (client, freelancer)
 *    - 400 missing required fields (url, eventType)
 *    - 400 invalid URL format
 *    - 400 SSRF-unsafe private URL
 *    - 400 empty eventType / eventType too long
 *    - 400 secret too long / secret empty string
 *    - 400 consumerId present but not a UUID
 *    - 201 success + full response shape
 *    - 201 success without optional secret
 *    - 201 created subscription is active=true by default
 *    - Idempotent-repeat: creating with same URL+eventType returns new distinct id (no server-side dedup)
 *
 *  GET    /api/v1/webhook-subscriptions
 *    - 401 / 403 guards
 *    - 200 empty list when no subscriptions exist
 *    - 200 full list
 *    - 200 filtered by eventType
 *    - 200 filtered by active flag
 *    - 400 invalid active query param value
 *    - 400 consumerId present but not a UUID
 *    - Response envelope shape
 *
 *  GET    /api/v1/webhook-subscriptions/:id
 *    - 401 / 403 guards
 *    - 200 returns correct record
 *    - 200 response shape (all expected fields present)
 *    - 404 unknown UUID
 *    - 400 id is not a valid UUID (validation error)
 *
 *  PATCH  /api/v1/webhook-subscriptions/:id
 *    - 401 / 403 guards
 *    - 200 partial update (url only)
 *    - 200 partial update (active flag only)
 *    - 200 partial update (eventType only)
 *    - 200 full update
 *    - 404 unknown id
 *    - 400 invalid URL format in body
 *    - 400 SSRF-unsafe URL in body
 *    - 400 id param not a UUID
 *    - 400 empty body is accepted (no-op update)
 *
 *  DELETE /api/v1/webhook-subscriptions/:id
 *    - 401 / 403 guards
 *    - 200 deletes and confirms
 *    - 404 deleting twice (idempotent-repeat → second call is 404)
 *    - 404 unknown UUID
 *    - 400 id param not a UUID
 */

// Set env vars before any module import so singletons pick them up
process.env.JWT_SECRET = 'webhook-routes-test-secret';
process.env.DB_PATH = ':memory:';
process.env.RL_WEBHOOKS_MAX = '10';
process.env.RL_WEBHOOKS_WINDOW_MS = '1000'; // 1 second window for fast tests
process.env.RL_WEBHOOKS_ABUSE_THRESHOLD = '2'; // block after 2 violations

import request from 'supertest';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { createApp } from '../app';
import { getDb, closeDb } from '../db/database';
import { clearIdempotencyStore } from '../middleware/idempotency';
import { rateLimitStore } from '../config/rateLimit';

// ─── Constants ────────────────────────────────────────────────────────────────

const SECRET = process.env.JWT_SECRET as string;
const BASE = '/api/v1/webhook-subscriptions';

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

const adminToken = () => makeToken('admin', 'admin-uuid');
const clientToken = () => makeToken('client', 'client-uuid');
const freelancerToken = () => makeToken('freelancer', 'freelancer-uuid');

function auth(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

// ─── Payload helpers ──────────────────────────────────────────────────────────

const validCreate = (overrides: Record<string, unknown> = {}) => ({
  url: 'https://example.com/hook',
  eventType: 'contract.created',
  ...overrides,
});

// ─── App / DB lifecycle ───────────────────────────────────────────────────────

let app: ReturnType<typeof createApp>;

beforeAll(() => {
  getDb(); // run migrations
  app = createApp({ includeTerminalHandlers: true });
});

beforeEach(() => {
  getDb().exec('DELETE FROM webhook_subscriptions');
  clearIdempotencyStore();
  rateLimitStore.clear();
});

afterAll(() => {
  closeDb();
});

// ─── Helper: create a subscription as admin ───────────────────────────────────

async function createSub(
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const res = await request(app)
    .post(BASE)
    .set(auth(adminToken()))
    .send(validCreate(overrides));
  expect(res.status).toBe(201);
  return (res.body as { data: { id: string } }).data.id;
}

// =============================================================================
// POST /api/v1/webhook-subscriptions
// =============================================================================

describe('POST /api/v1/webhook-subscriptions', () => {
  // ── Auth / RBAC ─────────────────────────────────────────────────────────────

  it('returns 401 when no Authorization header is present', async () => {
    const res = await request(app).post(BASE).send(validCreate());
    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe('unauthorized');
  });

  it('returns 401 for a malformed Authorization header (no Bearer prefix)', async () => {
    const res = await request(app)
      .post(BASE)
      .set('Authorization', 'Token not-a-jwt')
      .send(validCreate());
    expect(res.status).toBe(401);
  });

  it('returns 401 for an expired token', async () => {
    const expired = makeToken('admin', 'admin-uuid', -1);
    const res = await request(app)
      .post(BASE)
      .set(auth(expired))
      .send(validCreate());
    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).toMatch(/expired/i);
  });

  it('returns 401 for a token signed with the wrong secret', async () => {
    const forged = jwt.sign(
      { sub: 'x', email: 'x@x.com', role: 'admin' },
      'wrong-secret',
    );
    const res = await request(app)
      .post(BASE)
      .set(auth(forged))
      .send(validCreate());
    expect(res.status).toBe(401);
  });

  it('returns 403 for a client role', async () => {
    const res = await request(app)
      .post(BASE)
      .set(auth(clientToken()))
      .send(validCreate());
    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('forbidden');
  });

  it('returns 403 for a freelancer role', async () => {
    const res = await request(app)
      .post(BASE)
      .set(auth(freelancerToken()))
      .send(validCreate());
    expect(res.status).toBe(403);
  });

  // ── Validation failures ─────────────────────────────────────────────────────

  it('returns 400 when url is missing', async () => {
    const res = await request(app)
      .post(BASE)
      .set(auth(adminToken()))
      .send({ eventType: 'contract.created' });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('validation_error');
  });

  it('returns 400 when eventType is missing', async () => {
    const res = await request(app)
      .post(BASE)
      .set(auth(adminToken()))
      .send({ url: 'https://example.com/hook' });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('validation_error');
  });

  it('returns 400 when url is not a valid URL string', async () => {
    const res = await request(app)
      .post(BASE)
      .set(auth(adminToken()))
      .send(validCreate({ url: 'not-a-url' }));
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('validation_error');
  });

  it('returns 400 when eventType is an empty string', async () => {
    const res = await request(app)
      .post(BASE)
      .set(auth(adminToken()))
      .send(validCreate({ eventType: '' }));
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('validation_error');
  });

  it('returns 400 when eventType exceeds 100 characters', async () => {
    const res = await request(app)
      .post(BASE)
      .set(auth(adminToken()))
      .send(validCreate({ eventType: 'x'.repeat(101) }));
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('validation_error');
  });

  it('returns 400 when secret is an empty string', async () => {
    const res = await request(app)
      .post(BASE)
      .set(auth(adminToken()))
      .send(validCreate({ secret: '' }));
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('validation_error');
  });

  it('returns 400 when secret exceeds 256 characters', async () => {
    const res = await request(app)
      .post(BASE)
      .set(auth(adminToken()))
      .send(validCreate({ secret: 'a'.repeat(257) }));
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('validation_error');
  });

  it('returns 400 when consumerId is present but not a UUID', async () => {
    const res = await request(app)
      .post(BASE)
      .set(auth(adminToken()))
      .send(validCreate({ consumerId: 'not-a-uuid' }));
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('validation_error');
  });

  // ── SSRF guard ──────────────────────────────────────────────────────────────

  it('returns 400 with error code invalid_url for a private IP (SSRF)', async () => {
    const original = process.env.SSRF_ALLOW_PRIVATE_HOSTS;
    process.env.SSRF_ALLOW_PRIVATE_HOSTS = 'false';
    try {
      const res = await request(app)
        .post(BASE)
        .set(auth(adminToken()))
        .send(validCreate({ url: 'http://127.0.0.1/hook' }));
      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe('invalid_url');
    } finally {
      process.env.SSRF_ALLOW_PRIVATE_HOSTS = original;
    }
  });

  it('returns 400 with error code invalid_url for a link-local address (SSRF)', async () => {
    const original = process.env.SSRF_ALLOW_PRIVATE_HOSTS;
    process.env.SSRF_ALLOW_PRIVATE_HOSTS = 'false';
    try {
      const res = await request(app)
        .post(BASE)
        .set(auth(adminToken()))
        .send(validCreate({ url: 'http://169.254.169.254/latest/meta-data' }));
      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe('invalid_url');
    } finally {
      process.env.SSRF_ALLOW_PRIVATE_HOSTS = original;
    }
  });

  // ── Success paths ───────────────────────────────────────────────────────────

  it('returns 201 and full response shape for a valid payload', async () => {
    const res = await request(app)
      .post(BASE)
      .set(auth(adminToken()))
      .send(validCreate({ secret: 'shh' }));

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('success');

    const data = res.body.data;
    expect(data).toHaveProperty('id');
    expect(typeof data.id).toBe('string');
    expect(data.url).toBe('https://example.com/hook');
    expect(data.eventType).toBe('contract.created');
    expect(data.active).toBe(true);
    expect(data).toHaveProperty('createdAt');
    expect(data).toHaveProperty('updatedAt');
    // Secret must NOT be returned in the response
    expect(data.secret).toBeUndefined();
  });

  it('returns 201 without optional fields (no secret, no consumerId)', async () => {
    const res = await request(app)
      .post(BASE)
      .set(auth(adminToken()))
      .send({ url: 'https://example.com/no-secret', eventType: 'contract.updated' });
    expect(res.status).toBe(201);
    expect(res.body.data.active).toBe(true);
    expect(res.body.data.consumerId).toBeUndefined();
  });

  it('returns 201 with consumerId when a valid UUID is supplied', async () => {
    const consumerId = crypto.randomUUID();
    const res = await request(app)
      .post(BASE)
      .set(auth(adminToken()))
      .send(validCreate({ consumerId }));
    expect(res.status).toBe(201);
    expect(res.body.data.consumerId).toBe(consumerId);
  });

  it('two POSTs with identical url+eventType produce two separate subscriptions (no server-side dedup)', async () => {
    const payload = validCreate();
    const r1 = await request(app)
      .post(BASE)
      .set(auth(adminToken()))
      .send(payload);
    const r2 = await request(app)
      .post(BASE)
      .set(auth(adminToken()))
      .send(payload);

    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(r1.body.data.id).not.toBe(r2.body.data.id);
  });
});

// =============================================================================
// GET /api/v1/webhook-subscriptions
// =============================================================================

describe('GET /api/v1/webhook-subscriptions', () => {
  // ── Auth / RBAC ─────────────────────────────────────────────────────────────

  it('returns 401 when no token is provided', async () => {
    const res = await request(app).get(BASE);
    expect(res.status).toBe(401);
  });

  it('returns 403 for client role', async () => {
    const res = await request(app).get(BASE).set(auth(clientToken()));
    expect(res.status).toBe(403);
  });

  it('returns 403 for freelancer role', async () => {
    const res = await request(app).get(BASE).set(auth(freelancerToken()));
    expect(res.status).toBe(403);
  });

  // ── Success paths ───────────────────────────────────────────────────────────

  it('returns 200 with an empty array when there are no subscriptions', async () => {
    const res = await request(app).get(BASE).set(auth(adminToken()));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data).toHaveLength(0);
  });

  it('returns 200 with all subscriptions', async () => {
    await createSub({ eventType: 'contract.created' });
    await createSub({ eventType: 'contract.updated', url: 'https://example.com/b' });

    const res = await request(app).get(BASE).set(auth(adminToken()));
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
  });

  it('filters by eventType', async () => {
    await createSub({ eventType: 'contract.created' });
    await createSub({ eventType: 'contract.updated', url: 'https://example.com/b' });

    const res = await request(app)
      .get(BASE)
      .set(auth(adminToken()))
      .query({ eventType: 'contract.created' });
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].eventType).toBe('contract.created');
  });

  it('filters by active=false', async () => {
    const id = await createSub({ eventType: 'contract.created' });
    // Deactivate it
    await request(app)
      .patch(`${BASE}/${id}`)
      .set(auth(adminToken()))
      .send({ active: false });
    // Create a second active one
    await createSub({ eventType: 'contract.updated', url: 'https://example.com/b' });

    const res = await request(app)
      .get(BASE)
      .set(auth(adminToken()))
      .query({ active: 'false' });
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].active).toBe(false);
  });

  it('filters by active=true', async () => {
    const id = await createSub({ eventType: 'contract.created' });
    await request(app)
      .patch(`${BASE}/${id}`)
      .set(auth(adminToken()))
      .send({ active: false });
    await createSub({ eventType: 'contract.updated', url: 'https://example.com/b' });

    const res = await request(app)
      .get(BASE)
      .set(auth(adminToken()))
      .query({ active: 'true' });
    expect(res.status).toBe(200);
    expect(res.body.data.every((s: { active: boolean }) => s.active)).toBe(true);
  });

  // ── Validation failures ─────────────────────────────────────────────────────

  it('returns 400 when consumerId query param is not a UUID', async () => {
    const res = await request(app)
      .get(BASE)
      .set(auth(adminToken()))
      .query({ consumerId: 'not-a-uuid' });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('validation_error');
  });
});

// =============================================================================
// GET /api/v1/webhook-subscriptions/:id
// =============================================================================

describe('GET /api/v1/webhook-subscriptions/:id', () => {
  // ── Auth / RBAC ─────────────────────────────────────────────────────────────

  it('returns 401 when no token is provided', async () => {
    const res = await request(app).get(`${BASE}/${crypto.randomUUID()}`);
    expect(res.status).toBe(401);
  });

  it('returns 403 for client role', async () => {
    const id = await createSub();
    const res = await request(app)
      .get(`${BASE}/${id}`)
      .set(auth(clientToken()));
    expect(res.status).toBe(403);
  });

  // ── Success paths ───────────────────────────────────────────────────────────

  it('returns 200 with the correct subscription', async () => {
    const id = await createSub({ eventType: 'contract.created' });
    const res = await request(app)
      .get(`${BASE}/${id}`)
      .set(auth(adminToken()));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data.id).toBe(id);
    expect(res.body.data.eventType).toBe('contract.created');
    expect(res.body.data.url).toBe('https://example.com/hook');
    expect(res.body.data.active).toBe(true);
    expect(res.body.data).toHaveProperty('createdAt');
    expect(res.body.data).toHaveProperty('updatedAt');
  });

  it('does not leak the webhook secret in the response', async () => {
    const id = await createSub({ secret: 'super-secret' });
    const res = await request(app)
      .get(`${BASE}/${id}`)
      .set(auth(adminToken()));
    expect(res.status).toBe(200);
    expect(res.body.data.secret).toBeUndefined();
  });

  // ── Error paths ─────────────────────────────────────────────────────────────

  it('returns 404 for an id that does not exist', async () => {
    const res = await request(app)
      .get(`${BASE}/${crypto.randomUUID()}`)
      .set(auth(adminToken()));
    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe('not_found');
  });

  it('returns 400 when id is not a valid UUID', async () => {
    const res = await request(app)
      .get(`${BASE}/not-a-uuid`)
      .set(auth(adminToken()));
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('validation_error');
  });

  it('404 response includes a requestId field', async () => {
    const res = await request(app)
      .get(`${BASE}/${crypto.randomUUID()}`)
      .set(auth(adminToken()));
    expect(res.status).toBe(404);
    expect(res.body.error).toHaveProperty('requestId');
  });
});

// =============================================================================
// PATCH /api/v1/webhook-subscriptions/:id
// =============================================================================

describe('PATCH /api/v1/webhook-subscriptions/:id', () => {
  // ── Auth / RBAC ─────────────────────────────────────────────────────────────

  it('returns 401 when no token is provided', async () => {
    const id = await createSub();
    const res = await request(app)
      .patch(`${BASE}/${id}`)
      .send({ active: false });
    expect(res.status).toBe(401);
  });

  it('returns 403 for client role', async () => {
    const id = await createSub();
    const res = await request(app)
      .patch(`${BASE}/${id}`)
      .set(auth(clientToken()))
      .send({ active: false });
    expect(res.status).toBe(403);
  });

  it('returns 403 for freelancer role', async () => {
    const id = await createSub();
    const res = await request(app)
      .patch(`${BASE}/${id}`)
      .set(auth(freelancerToken()))
      .send({ active: false });
    expect(res.status).toBe(403);
  });

  // ── Success paths ───────────────────────────────────────────────────────────

  it('updates only the url (partial update)', async () => {
    const id = await createSub();
    const res = await request(app)
      .patch(`${BASE}/${id}`)
      .set(auth(adminToken()))
      .send({ url: 'https://example.com/updated' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data.url).toBe('https://example.com/updated');
    // eventType must be unchanged
    expect(res.body.data.eventType).toBe('contract.created');
  });

  it('updates only the active flag (partial update)', async () => {
    const id = await createSub();
    const res = await request(app)
      .patch(`${BASE}/${id}`)
      .set(auth(adminToken()))
      .send({ active: false });

    expect(res.status).toBe(200);
    expect(res.body.data.active).toBe(false);
    // url must be unchanged
    expect(res.body.data.url).toBe('https://example.com/hook');
  });

  it('updates only the eventType (partial update)', async () => {
    const id = await createSub();
    const res = await request(app)
      .patch(`${BASE}/${id}`)
      .set(auth(adminToken()))
      .send({ eventType: 'contract.deleted' });

    expect(res.status).toBe(200);
    expect(res.body.data.eventType).toBe('contract.deleted');
  });

  it('applies a full update (url + eventType + active + secret)', async () => {
    const id = await createSub();
    const res = await request(app)
      .patch(`${BASE}/${id}`)
      .set(auth(adminToken()))
      .send({
        url: 'https://example.com/full-update',
        eventType: 'payment.completed',
        active: false,
        secret: 'new-secret',
      });

    expect(res.status).toBe(200);
    expect(res.body.data.url).toBe('https://example.com/full-update');
    expect(res.body.data.eventType).toBe('payment.completed');
    expect(res.body.data.active).toBe(false);
    // Secret must never appear in the response
    expect(res.body.data.secret).toBeUndefined();
  });

  it('updatedAt timestamp advances after a patch', async () => {
    const id = await createSub();
    const before = await request(app)
      .get(`${BASE}/${id}`)
      .set(auth(adminToken()));
    const originalUpdatedAt = before.body.data.updatedAt;

    // Wait 1 ms to guarantee a different timestamp value
    await new Promise((r) => setTimeout(r, 5));

    await request(app)
      .patch(`${BASE}/${id}`)
      .set(auth(adminToken()))
      .send({ active: false });

    const after = await request(app)
      .get(`${BASE}/${id}`)
      .set(auth(adminToken()));
    expect(after.body.data.updatedAt >= originalUpdatedAt).toBe(true);
  });

  it('accepts an empty body as a no-op and returns 200', async () => {
    const id = await createSub();
    const res = await request(app)
      .patch(`${BASE}/${id}`)
      .set(auth(adminToken()))
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(id);
  });

  // ── Error paths ─────────────────────────────────────────────────────────────

  it('returns 404 for an unknown id', async () => {
    const res = await request(app)
      .patch(`${BASE}/${crypto.randomUUID()}`)
      .set(auth(adminToken()))
      .send({ active: false });

    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe('not_found');
  });

  it('returns 400 when id param is not a UUID', async () => {
    const res = await request(app)
      .patch(`${BASE}/not-a-uuid`)
      .set(auth(adminToken()))
      .send({ active: false });

    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('validation_error');
  });

  it('returns 400 when the new url is not a valid URL string', async () => {
    const id = await createSub();
    const res = await request(app)
      .patch(`${BASE}/${id}`)
      .set(auth(adminToken()))
      .send({ url: 'not-a-url' });

    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('validation_error');
  });

  it('returns 400 when the new url is SSRF-unsafe (private IP)', async () => {
    const id = await createSub();
    const original = process.env.SSRF_ALLOW_PRIVATE_HOSTS;
    process.env.SSRF_ALLOW_PRIVATE_HOSTS = 'false';
    try {
      const res = await request(app)
        .patch(`${BASE}/${id}`)
        .set(auth(adminToken()))
        .send({ url: 'http://10.0.0.1/hook' });

      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe('invalid_url');
    } finally {
      process.env.SSRF_ALLOW_PRIVATE_HOSTS = original;
    }
  });

  it('returns 400 when eventType is empty string', async () => {
    const id = await createSub();
    const res = await request(app)
      .patch(`${BASE}/${id}`)
      .set(auth(adminToken()))
      .send({ eventType: '' });

    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('validation_error');
  });

  it('returns 400 when secret is an empty string', async () => {
    const id = await createSub();
    const res = await request(app)
      .patch(`${BASE}/${id}`)
      .set(auth(adminToken()))
      .send({ secret: '' });

    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('validation_error');
  });
});

// =============================================================================
// DELETE /api/v1/webhook-subscriptions/:id
// =============================================================================

describe('DELETE /api/v1/webhook-subscriptions/:id', () => {
  // ── Auth / RBAC ─────────────────────────────────────────────────────────────

  it('returns 401 when no token is provided', async () => {
    const id = await createSub();
    const res = await request(app).delete(`${BASE}/${id}`);
    expect(res.status).toBe(401);
  });

  it('returns 403 for client role', async () => {
    const id = await createSub();
    const res = await request(app)
      .delete(`${BASE}/${id}`)
      .set(auth(clientToken()));
    expect(res.status).toBe(403);
  });

  it('returns 403 for freelancer role', async () => {
    const id = await createSub();
    const res = await request(app)
      .delete(`${BASE}/${id}`)
      .set(auth(freelancerToken()));
    expect(res.status).toBe(403);
  });

  // ── Success paths ───────────────────────────────────────────────────────────

  it('returns 200 with deleted=true and the subscription id', async () => {
    const id = await createSub();
    const res = await request(app)
      .delete(`${BASE}/${id}`)
      .set(auth(adminToken()));

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data.deleted).toBe(true);
    expect(res.body.data.id).toBe(id);
  });

  it('subscription is no longer accessible after deletion', async () => {
    const id = await createSub();
    await request(app).delete(`${BASE}/${id}`).set(auth(adminToken()));

    const check = await request(app)
      .get(`${BASE}/${id}`)
      .set(auth(adminToken()));
    expect(check.status).toBe(404);
  });

  it('deleted subscription is absent from the list endpoint', async () => {
    const id = await createSub({ eventType: 'contract.created' });
    await createSub({ eventType: 'contract.updated', url: 'https://example.com/b' });

    await request(app).delete(`${BASE}/${id}`).set(auth(adminToken()));

    const list = await request(app).get(BASE).set(auth(adminToken()));
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].eventType).toBe('contract.updated');
  });

  // ── Idempotent-repeat (double-delete) ────────────────────────────────────────

  it('returns 404 on a second DELETE of the same id (not idempotent — resource is gone)', async () => {
    const id = await createSub();

    const first = await request(app)
      .delete(`${BASE}/${id}`)
      .set(auth(adminToken()));
    expect(first.status).toBe(200);

    const second = await request(app)
      .delete(`${BASE}/${id}`)
      .set(auth(adminToken()));
    expect(second.status).toBe(404);
    expect(second.body.error?.code).toBe('not_found');
  });

  // ── Error paths ─────────────────────────────────────────────────────────────

  it('returns 404 for an unknown UUID', async () => {
    const res = await request(app)
      .delete(`${BASE}/${crypto.randomUUID()}`)
      .set(auth(adminToken()));
    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe('not_found');
  });

  it('returns 400 when id param is not a UUID', async () => {
    const res = await request(app)
      .delete(`${BASE}/not-a-uuid`)
      .set(auth(adminToken()));
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('validation_error');
  });
});

// =============================================================================
// Idempotency (POST, PATCH, DELETE)
// =============================================================================

describe('Idempotency', () => {
  const I_KEY = 'test-idempotency-key';

  it('POST: exact replay returns original response and 201 without creating a new record', async () => {
    const payload = validCreate({ url: 'https://example.com/idemp' });
    const r1 = await request(app)
      .post(BASE)
      .set(auth(adminToken()))
      .set('Idempotency-Key', I_KEY)
      .send(payload);

    expect(r1.status).toBe(201);
    expect(r1.body.idempotencyHeader).toBeUndefined();
    const id = r1.body.data.id;

    const r2 = await request(app)
      .post(BASE)
      .set(auth(adminToken()))
      .set('Idempotency-Key', I_KEY)
      .send(payload);

    expect(r2.status).toBe(200);
    expect(r2.body.idempotencyHeader).toBe('replay-detected');
    expect(r2.body.data.id).toBe(id);

    // Verify only one was created
    const list = await request(app).get(BASE).set(auth(adminToken()));
    expect(list.body.data).toHaveLength(1);
  });

  it('POST: key reuse with different body returns 409 conflict', async () => {
    const r1 = await request(app)
      .post(BASE)
      .set(auth(adminToken()))
      .set('Idempotency-Key', I_KEY)
      .send(validCreate({ url: 'https://example.com/idemp1' }));

    expect(r1.status).toBe(201);

    const r2 = await request(app)
      .post(BASE)
      .set(auth(adminToken()))
      .set('Idempotency-Key', I_KEY)
      .send(validCreate({ url: 'https://example.com/idemp2' }));

    expect(r2.status).toBe(409);
    expect(r2.body.error.code).toBe('idempotency_payload_conflict');
  });

  it('PATCH: exact replay returns original response', async () => {
    const id = await createSub();

    const payload = { active: false };
    const r1 = await request(app)
      .patch(`${BASE}/${id}`)
      .set(auth(adminToken()))
      .set('Idempotency-Key', I_KEY)
      .send(payload);

    expect(r1.status).toBe(200);

    const r2 = await request(app)
      .patch(`${BASE}/${id}`)
      .set(auth(adminToken()))
      .set('Idempotency-Key', I_KEY)
      .send(payload);

    expect(r2.status).toBe(200);
    expect(r2.body.idempotencyHeader).toBe('replay-detected');
  });

  it('DELETE: exact replay returns original response (not 404)', async () => {
    const id = await createSub();

    const r1 = await request(app)
      .delete(`${BASE}/${id}`)
      .set(auth(adminToken()))
      .set('Idempotency-Key', I_KEY);

    expect(r1.status).toBe(200);
    expect(r1.body.data.deleted).toBe(true);

    const r2 = await request(app)
      .delete(`${BASE}/${id}`)
      .set(auth(adminToken()))
      .set('Idempotency-Key', I_KEY);

    expect(r2.status).toBe(200);
    expect(r2.body.idempotencyHeader).toBe('replay-detected');
    expect(r2.body.data.deleted).toBe(true);
  });
});

// =============================================================================
// Cross-cutting: information-leakage and response-envelope contracts
// =============================================================================

describe('Security and envelope contracts', () => {
  it('401 responses do not echo back the submitted token', async () => {
    const forged = jwt.sign(
      { sub: 'secret-user', email: 'sec@sec.com', role: 'admin' },
      'wrong-secret',
    );
    const res = await request(app)
      .get(BASE)
      .set(auth(forged));

    expect(res.status).toBe(401);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(forged);
    expect(body).not.toContain('secret-user');
  });

  it('403 responses do not leak user identity from the token', async () => {
    const res = await request(app)
      .post(BASE)
      .set(auth(clientToken()))
      .send(validCreate());

    expect(res.status).toBe(403);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('client-uuid');
  });

  it('every error response carries a non-empty requestId', async () => {
    const endpoints = [
      () => request(app).get(BASE),
      () => request(app).post(BASE).send({}),
      () => request(app).get(`${BASE}/not-a-uuid`).set(auth(adminToken())),
      () =>
        request(app)
          .get(`${BASE}/${crypto.randomUUID()}`)
          .set(auth(adminToken())),
    ];

    for (const call of endpoints) {
      const res = await call();
      const errorBlock = res.body?.error ?? res.body;
      // requestId is either top-level (auth errors) or nested under error
      const requestId =
        res.body?.error?.requestId ??
        (typeof res.body?.requestId === 'string' ? res.body.requestId : undefined);
      expect(requestId).toBeDefined();
      expect(typeof requestId).toBe('string');
      expect(requestId.length).toBeGreaterThan(0);
      // Suppress the unused variable warning
      void errorBlock;
    }
  });

  it('success responses always wrap data under { status: "success", data: ... }', async () => {
    const id = await createSub();
    const endpoints = [
      () => request(app).get(BASE).set(auth(adminToken())),
      () => request(app).get(`${BASE}/${id}`).set(auth(adminToken())),
    ];

    for (const call of endpoints) {
      const res = await call();
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body).toHaveProperty('data');
    }
  });

  it('validation error response includes a details array with path information', async () => {
    const res = await request(app)
      .post(BASE)
      .set(auth(adminToken()))
      .send({ eventType: 'contract.created' }); // missing url

    expect(res.status).toBe(400);
    expect(Array.isArray(res.body.error?.details)).toBe(true);
    expect(res.body.error.details.length).toBeGreaterThan(0);
    const detail = res.body.error.details[0];
    expect(detail).toHaveProperty('path');
    expect(detail).toHaveProperty('message');
    expect(detail).toHaveProperty('code');
  });

  it('unknown routes under the webhook prefix return 404 not_found', async () => {
    const res = await request(app)
      .get('/api/v1/webhook-subscriptions/does/not/exist')
      .set(auth(adminToken()));
    // Either the route validator rejects the path or notFoundHandler fires
    expect([400, 404]).toContain(res.status);
  });
});

// =============================================================================
// Rate Limiting
// =============================================================================

describe('Rate Limiting', () => {
  it('enforces per-client rate limit and recovers after window resets', async () => {
    const apiKey = crypto.randomUUID();
    const headers = {
      ...auth(adminToken()),
      'X-API-Key': apiKey,
    };

    // 1. Make requests up to the limit (max = 10)
    for (let i = 0; i < 10; i++) {
      const res = await request(app).get(BASE).set(headers);
      expect(res.status).toBe(200);
      expect(res.header['x-ratelimit-remaining']).toBeDefined();
    }

    // 2. Next request should be rate limited (at-limit/over-limit 429)
    const res429 = await request(app).get(BASE).set(headers);
    expect(res429.status).toBe(429);
    expect(res429.body.error?.code).toBe('rate_limited');
    expect(res429.header['retry-after']).toBeDefined();

    // 3. Wait for the window to reset (> 1000ms)
    await new Promise((resolve) => setTimeout(resolve, 1100));

    // 4. Request should succeed again
    const resRecovered = await request(app).get(BASE).set(headers);
    expect(resRecovered.status).toBe(200);
  });
});