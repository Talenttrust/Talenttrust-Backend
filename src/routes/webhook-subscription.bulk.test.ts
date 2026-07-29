/**
 * Integration tests for POST /api/v1/webhook-subscriptions/bulk
 *
 * Covers:
 *  - Empty batch → 400
 *  - Over-cap batch (> MAX_WEBHOOK_BULK_BATCH_SIZE = 25) → 400
 *  - At-cap batch (exactly 25 items) → 200
 *  - All-success batch (create, update, delete) → 200
 *  - Partial-failure batch (mix of valid/invalid items) → 207
 *  - All-fail batch → 207
 *  - Per-item validation errors (bad url, missing fields, non-UUID id, unknown op)
 *  - Per-item not_found on update/delete of missing subscription
 *  - SSRF-unsafe URL in create item → per-item invalid_url error
 *  - SSRF-unsafe URL in update item → per-item invalid_url error
 *  - Response envelope shape: { status, results, summary }
 *  - Summary counts (total, succeeded, failed) are accurate
 *  - Secret is never present in result data
 *  - Cache invalidation: list cache is flushed on any successful write
 *  - Auth/RBAC: 401 without token, 403 for non-admin
 */

process.env.JWT_SECRET = 'bulk-test-secret';
process.env.DB_PATH = ':memory:';
process.env.RL_WEBHOOKS_MAX = '1000';
process.env.RL_WEBHOOKS_WINDOW_MS = '60000';
process.env.SSRF_ALLOW_PRIVATE_HOSTS = 'false';

import request from 'supertest';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { createApp } from '../app';
import { getDb, closeDb } from '../db/database';
import { clearIdempotencyStore } from '../middleware/idempotency';
import { rateLimitStore } from '../config/rateLimit';
import { MAX_WEBHOOK_BULK_BATCH_SIZE } from '../modules/webhooks/dto/webhook-subscription.dto';

// ── Constants ─────────────────────────────────────────────────────────────────

const SECRET = process.env.JWT_SECRET as string;
const BASE = '/api/v1/webhook-subscriptions';
const BULK = `${BASE}/bulk`;

// ── Token helpers ─────────────────────────────────────────────────────────────

function makeToken(role: string, sub = 'user-1', expiresIn: string | number = '1h'): string {
  return jwt.sign({ sub, email: `${sub}@test.com`, role }, SECRET, {
    expiresIn,
  } as jwt.SignOptions);
}

const adminToken = () => makeToken('admin', 'admin-uuid');
const clientToken = () => makeToken('client', 'client-uuid');

function auth(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

// ── App / DB lifecycle ────────────────────────────────────────────────────────

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

// ── Helpers ───────────────────────────────────────────────────────────────────

async function createSub(overrides: Record<string, unknown> = {}): Promise<string> {
  const res = await request(app)
    .post(BASE)
    .set(auth(adminToken()))
    .send({ url: 'https://example.com/hook', eventType: 'contract.created', ...overrides });
  expect(res.status).toBe(201);
  return (res.body as { data: { id: string } }).data.id;
}

function createItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    operation: 'create',
    url: 'https://example.com/hook',
    eventType: 'contract.created',
    ...overrides,
  };
}

function updateItem(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { operation: 'update', id, ...overrides };
}

function deleteItem(id: string): Record<string, unknown> {
  return { operation: 'delete', id };
}

// ── Auth / RBAC ───────────────────────────────────────────────────────────────

describe('auth and RBAC', () => {
  it('returns 401 when no Authorization header is present', async () => {
    const res = await request(app).post(BULK).send({ items: [createItem()] });
    expect(res.status).toBe(401);
  });

  it('returns 401 for a malformed Authorization header', async () => {
    const res = await request(app)
      .post(BULK)
      .set('Authorization', 'Token not-a-jwt')
      .send({ items: [createItem()] });
    expect(res.status).toBe(401);
  });

  it('returns 401 for an expired token', async () => {
    const expired = makeToken('admin', 'admin-uuid', -1);
    const res = await request(app)
      .post(BULK)
      .set(auth(expired))
      .send({ items: [createItem()] });
    expect(res.status).toBe(401);
  });

  it('returns 403 for a client role', async () => {
    const res = await request(app)
      .post(BULK)
      .set(auth(clientToken()))
      .send({ items: [createItem()] });
    expect(res.status).toBe(403);
  });
});

// ── Batch-level validation ────────────────────────────────────────────────────

describe('batch-level validation', () => {
  it('returns 400 for an empty items array', async () => {
    const res = await request(app)
      .post(BULK)
      .set(auth(adminToken()))
      .send({ items: [] });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('validation_error');
  });

  it('returns 400 when items field is missing entirely', async () => {
    const res = await request(app)
      .post(BULK)
      .set(auth(adminToken()))
      .send({});
    expect(res.status).toBe(400);
  });

  it(`returns 400 for a batch exceeding MAX_WEBHOOK_BULK_BATCH_SIZE (${MAX_WEBHOOK_BULK_BATCH_SIZE})`, async () => {
    const items = Array.from({ length: MAX_WEBHOOK_BULK_BATCH_SIZE + 1 }, (_, i) =>
      createItem({ url: `https://example.com/hook-${i}`, eventType: 'contract.created' }),
    );
    const res = await request(app)
      .post(BULK)
      .set(auth(adminToken()))
      .send({ items });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('validation_error');
  });

  it(`returns 200 for a batch at exactly MAX_WEBHOOK_BULK_BATCH_SIZE (${MAX_WEBHOOK_BULK_BATCH_SIZE}) items`, async () => {
    const items = Array.from({ length: MAX_WEBHOOK_BULK_BATCH_SIZE }, (_, i) =>
      createItem({
        url: `https://example.com/hook-${i}`,
        eventType: `contract.event.${i}`,
      }),
    );
    const res = await request(app)
      .post(BULK)
      .set(auth(adminToken()))
      .send({ items });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.results).toHaveLength(MAX_WEBHOOK_BULK_BATCH_SIZE);
    expect(res.body.summary.total).toBe(MAX_WEBHOOK_BULK_BATCH_SIZE);
    expect(res.body.summary.succeeded).toBe(MAX_WEBHOOK_BULK_BATCH_SIZE);
    expect(res.body.summary.failed).toBe(0);
  });
});

// ── All-success batch ─────────────────────────────────────────────────────────

describe('all-success batch', () => {
  it('creates a subscription — returns 200 with correct result shape', async () => {
    const res = await request(app)
      .post(BULK)
      .set(auth(adminToken()))
      .send({ items: [createItem({ secret: 'shh' })] });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.results).toHaveLength(1);

    const r = res.body.results[0];
    expect(r.index).toBe(0);
    expect(r.success).toBe(true);
    expect(r.data).toHaveProperty('id');
    expect(r.data.url).toBe('https://example.com/hook');
    expect(r.data.eventType).toBe('contract.created');
    expect(r.data.active).toBe(true);
    expect(r.data.secret).toBeUndefined(); // secret must never be exposed
  });

  it('updates a subscription — returns 200', async () => {
    const id = await createSub();

    const res = await request(app)
      .post(BULK)
      .set(auth(adminToken()))
      .send({ items: [updateItem(id, { active: false, url: 'https://updated.com/hook' })] });

    expect(res.status).toBe(200);
    expect(res.body.results[0].success).toBe(true);
    expect(res.body.results[0].data.active).toBe(false);
    expect(res.body.results[0].data.url).toBe('https://updated.com/hook');
  });

  it('deletes a subscription — returns 200 with { id, deleted: true }', async () => {
    const id = await createSub();

    const res = await request(app)
      .post(BULK)
      .set(auth(adminToken()))
      .send({ items: [deleteItem(id)] });

    expect(res.status).toBe(200);
    expect(res.body.results[0].success).toBe(true);
    expect(res.body.results[0].data.deleted).toBe(true);
    expect(res.body.results[0].data.id).toBe(id);
  });

  it('handles mixed create + update + delete in one batch — all succeed', async () => {
    const idToUpdate = await createSub({ eventType: 'payment.initiated', url: 'https://to-update.com/hook' });
    const idToDelete = await createSub({ eventType: 'payment.completed', url: 'https://to-delete.com/hook' });

    const res = await request(app)
      .post(BULK)
      .set(auth(adminToken()))
      .send({
        items: [
          createItem({ url: 'https://new.com/hook', eventType: 'user.created' }),
          updateItem(idToUpdate, { active: false }),
          deleteItem(idToDelete),
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.summary.total).toBe(3);
    expect(res.body.summary.succeeded).toBe(3);
    expect(res.body.summary.failed).toBe(0);

    const [r0, r1, r2] = res.body.results;
    expect(r0.index).toBe(0);
    expect(r0.success).toBe(true);
    expect(r0.data.eventType).toBe('user.created');

    expect(r1.index).toBe(1);
    expect(r1.success).toBe(true);
    expect(r1.data.active).toBe(false);

    expect(r2.index).toBe(2);
    expect(r2.success).toBe(true);
    expect(r2.data.deleted).toBe(true);
  });

  it('summary counts are accurate', async () => {
    const res = await request(app)
      .post(BULK)
      .set(auth(adminToken()))
      .send({
        items: [
          createItem({ url: 'https://a.com/hook', eventType: 'ev.a' }),
          createItem({ url: 'https://b.com/hook', eventType: 'ev.b' }),
        ],
      });

    expect(res.body.summary.total).toBe(2);
    expect(res.body.summary.succeeded).toBe(2);
    expect(res.body.summary.failed).toBe(0);
  });
});

// ── Partial-failure batch ─────────────────────────────────────────────────────

describe('partial-failure batch', () => {
  it('returns 207 when at least one item fails', async () => {
    const id = await createSub();
    const badId = crypto.randomUUID(); // does not exist

    const res = await request(app)
      .post(BULK)
      .set(auth(adminToken()))
      .send({
        items: [
          deleteItem(id),        // valid
          deleteItem(badId),     // not_found
        ],
      });

    expect(res.status).toBe(207);
    expect(res.body.status).toBe('partial_failure');
    expect(res.body.results[0].success).toBe(true);
    expect(res.body.results[1].success).toBe(false);
    expect(res.body.results[1].error.code).toBe('not_found');
  });

  it('returns 207 when all items fail', async () => {
    const res = await request(app)
      .post(BULK)
      .set(auth(adminToken()))
      .send({
        items: [
          deleteItem(crypto.randomUUID()),
          deleteItem(crypto.randomUUID()),
        ],
      });

    expect(res.status).toBe(207);
    expect(res.body.status).toBe('partial_failure');
    expect(res.body.summary.succeeded).toBe(0);
    expect(res.body.summary.failed).toBe(2);
  });

  it('preserves original batch order in results', async () => {
    const id = await createSub({ url: 'https://order.com/a', eventType: 'order.a' });

    const res = await request(app)
      .post(BULK)
      .set(auth(adminToken()))
      .send({
        items: [
          { operation: 'create', url: 'not-a-url', eventType: 'bad' },  // [0] fail
          deleteItem(id),                                                  // [1] success
          deleteItem(crypto.randomUUID()),                                 // [2] not_found
        ],
      });

    expect(res.status).toBe(207);
    expect(res.body.results[0].index).toBe(0);
    expect(res.body.results[0].success).toBe(false);
    expect(res.body.results[1].index).toBe(1);
    expect(res.body.results[1].success).toBe(true);
    expect(res.body.results[2].index).toBe(2);
    expect(res.body.results[2].success).toBe(false);
  });

  it('one invalid item does not prevent other items from succeeding', async () => {
    const res = await request(app)
      .post(BULK)
      .set(auth(adminToken()))
      .send({
        items: [
          createItem({ url: 'https://valid.com/hook', eventType: 'valid.event' }),
          { operation: 'create', url: 'not-valid', eventType: 'x' }, // fails
          createItem({ url: 'https://also-valid.com/hook', eventType: 'also.valid' }),
        ],
      });

    expect(res.status).toBe(207);
    expect(res.body.results[0].success).toBe(true);
    expect(res.body.results[1].success).toBe(false);
    expect(res.body.results[2].success).toBe(true);
    expect(res.body.summary.succeeded).toBe(2);
    expect(res.body.summary.failed).toBe(1);
  });
});

// ── Per-item validation errors ────────────────────────────────────────────────

describe('per-item validation errors', () => {
  it('create: rejects invalid URL with code=validation_error', async () => {
    const res = await request(app)
      .post(BULK)
      .set(auth(adminToken()))
      .send({ items: [createItem({ url: 'not-a-url' })] });

    expect(res.status).toBe(207);
    expect(res.body.results[0].error.code).toBe('validation_error');
  });

  it('create: rejects missing eventType', async () => {
    const res = await request(app)
      .post(BULK)
      .set(auth(adminToken()))
      .send({ items: [{ operation: 'create', url: 'https://example.com/hook' }] });

    expect(res.status).toBe(207);
    expect(res.body.results[0].error.code).toBe('validation_error');
  });

  it('create: rejects missing url', async () => {
    const res = await request(app)
      .post(BULK)
      .set(auth(adminToken()))
      .send({ items: [{ operation: 'create', eventType: 'contract.created' }] });

    expect(res.status).toBe(207);
    expect(res.body.results[0].error.code).toBe('validation_error');
  });

  it('update: rejects missing id', async () => {
    const res = await request(app)
      .post(BULK)
      .set(auth(adminToken()))
      .send({ items: [{ operation: 'update', active: false }] });

    expect(res.status).toBe(207);
    expect(res.body.results[0].error.code).toBe('validation_error');
  });

  it('update: rejects non-UUID id', async () => {
    const res = await request(app)
      .post(BULK)
      .set(auth(adminToken()))
      .send({ items: [{ operation: 'update', id: 'not-a-uuid', active: false }] });

    expect(res.status).toBe(207);
    expect(res.body.results[0].error.code).toBe('validation_error');
  });

  it('delete: rejects non-UUID id', async () => {
    const res = await request(app)
      .post(BULK)
      .set(auth(adminToken()))
      .send({ items: [{ operation: 'delete', id: 'not-a-uuid' }] });

    expect(res.status).toBe(207);
    expect(res.body.results[0].error.code).toBe('validation_error');
  });

  it('rejects unknown operation value', async () => {
    const res = await request(app)
      .post(BULK)
      .set(auth(adminToken()))
      .send({ items: [{ operation: 'upsert', url: 'https://example.com/hook', eventType: 'x' }] });

    expect(res.status).toBe(207);
    expect(res.body.results[0].error.code).toBe('validation_error');
  });

  it('rejects missing operation field', async () => {
    const res = await request(app)
      .post(BULK)
      .set(auth(adminToken()))
      .send({ items: [{ url: 'https://example.com/hook', eventType: 'x' }] });

    expect(res.status).toBe(207);
    expect(res.body.results[0].error.code).toBe('validation_error');
  });
});

// ── Not-found errors ──────────────────────────────────────────────────────────

describe('not_found per-item errors', () => {
  it('update of non-existent id returns per-item not_found', async () => {
    const res = await request(app)
      .post(BULK)
      .set(auth(adminToken()))
      .send({ items: [updateItem(crypto.randomUUID(), { active: false })] });

    expect(res.status).toBe(207);
    expect(res.body.results[0].error.code).toBe('not_found');
  });

  it('delete of non-existent id returns per-item not_found', async () => {
    const res = await request(app)
      .post(BULK)
      .set(auth(adminToken()))
      .send({ items: [deleteItem(crypto.randomUUID())] });

    expect(res.status).toBe(207);
    expect(res.body.results[0].error.code).toBe('not_found');
  });
});

// ── SSRF guard ────────────────────────────────────────────────────────────────

describe('SSRF guard (per-item)', () => {
  it('create: SSRF-unsafe URL returns per-item invalid_url error', async () => {
    const res = await request(app)
      .post(BULK)
      .set(auth(adminToken()))
      .send({
        items: [
          createItem({ url: 'http://127.0.0.1/hook' }),
        ],
      });

    expect(res.status).toBe(207);
    expect(res.body.results[0].error.code).toBe('invalid_url');
  });

  it('update: SSRF-unsafe URL returns per-item invalid_url error', async () => {
    const id = await createSub();

    const res = await request(app)
      .post(BULK)
      .set(auth(adminToken()))
      .send({
        items: [
          updateItem(id, { url: 'http://10.0.0.1/hook' }),
        ],
      });

    expect(res.status).toBe(207);
    expect(res.body.results[0].error.code).toBe('invalid_url');
  });

  it('SSRF failure on one item does not prevent other items from succeeding', async () => {
    const res = await request(app)
      .post(BULK)
      .set(auth(adminToken()))
      .send({
        items: [
          createItem({ url: 'http://127.0.0.1/hook' }),          // fail
          createItem({ url: 'https://safe.example.com/hook', eventType: 'safe.event' }), // succeed
        ],
      });

    expect(res.status).toBe(207);
    expect(res.body.results[0].success).toBe(false);
    expect(res.body.results[0].error.code).toBe('invalid_url');
    expect(res.body.results[1].success).toBe(true);
  });
});

// ── Response shape ────────────────────────────────────────────────────────────

describe('response envelope shape', () => {
  it('200 response has status, results, and summary fields', async () => {
    const res = await request(app)
      .post(BULK)
      .set(auth(adminToken()))
      .send({ items: [createItem()] });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('status', 'success');
    expect(res.body).toHaveProperty('results');
    expect(res.body).toHaveProperty('summary');
    expect(res.body.summary).toHaveProperty('total');
    expect(res.body.summary).toHaveProperty('succeeded');
    expect(res.body.summary).toHaveProperty('failed');
  });

  it('207 response has status=partial_failure', async () => {
    const res = await request(app)
      .post(BULK)
      .set(auth(adminToken()))
      .send({ items: [deleteItem(crypto.randomUUID())] });

    expect(res.status).toBe(207);
    expect(res.body.status).toBe('partial_failure');
  });

  it('each result item has index, success, and either data or error', async () => {
    const id = await createSub();
    const res = await request(app)
      .post(BULK)
      .set(auth(adminToken()))
      .send({
        items: [
          deleteItem(id),
          deleteItem(crypto.randomUUID()),
        ],
      });

    const [success, fail] = res.body.results;
    expect(success).toHaveProperty('index', 0);
    expect(success).toHaveProperty('success', true);
    expect(success).toHaveProperty('data');
    expect(success.error).toBeUndefined();

    expect(fail).toHaveProperty('index', 1);
    expect(fail).toHaveProperty('success', false);
    expect(fail).toHaveProperty('error');
    expect(fail.error).toHaveProperty('code');
    expect(fail.error).toHaveProperty('message');
  });

  it('secret is never present in create result data', async () => {
    const res = await request(app)
      .post(BULK)
      .set(auth(adminToken()))
      .send({ items: [createItem({ secret: 'super-secret' })] });

    expect(res.status).toBe(200);
    expect(res.body.results[0].data.secret).toBeUndefined();
  });

  it('secret is never present in update result data', async () => {
    const id = await createSub({ secret: 'original-secret' });
    const res = await request(app)
      .post(BULK)
      .set(auth(adminToken()))
      .send({ items: [updateItem(id, { secret: 'new-secret' })] });

    expect(res.status).toBe(200);
    expect(res.body.results[0].data.secret).toBeUndefined();
  });
});

// ── Cache invalidation ────────────────────────────────────────────────────────

describe('cache invalidation', () => {
  it('list is re-fetched from DB after a successful bulk create', async () => {
    // Warm the list cache via GET
    await request(app).get(BASE).set(auth(adminToken()));

    // Bulk create — should flush list cache
    const bulkRes = await request(app)
      .post(BULK)
      .set(auth(adminToken()))
      .send({ items: [createItem({ url: 'https://new-sub.com/hook', eventType: 'new.event' })] });
    expect(bulkRes.status).toBe(200);

    // Subsequent GET should return the new subscription (cache was invalidated)
    const listRes = await request(app).get(BASE).set(auth(adminToken()));
    expect(listRes.status).toBe(200);
    expect(listRes.body.data.some((s: any) => s.eventType === 'new.event')).toBe(true);
  });

  it('deleted subscription is not served from cache after bulk delete', async () => {
    const id = await createSub({ eventType: 'to-be-deleted' });

    // Warm per-id cache
    await request(app).get(`${BASE}/${id}`).set(auth(adminToken()));

    // Bulk delete
    const delRes = await request(app)
      .post(BULK)
      .set(auth(adminToken()))
      .send({ items: [deleteItem(id)] });
    expect(delRes.status).toBe(200);

    // GET /:id should now 404 (cache was invalidated)
    const getRes = await request(app).get(`${BASE}/${id}`).set(auth(adminToken()));
    expect(getRes.status).toBe(404);
  });

  it('cache is NOT flushed when all items fail (no successful writes)', async () => {
    // Create a sub so the list is non-empty
    await createSub({ eventType: 'existing.event' });

    // Warm list cache
    const before = await request(app).get(BASE).set(auth(adminToken()));
    expect(before.body.data).toHaveLength(1);

    // Bulk with all failures — cache should be untouched
    await request(app)
      .post(BULK)
      .set(auth(adminToken()))
      .send({ items: [deleteItem(crypto.randomUUID())] }); // not_found

    // List should still return the existing subscription (cache still warm)
    const after = await request(app).get(BASE).set(auth(adminToken()));
    expect(after.status).toBe(200);
    expect(after.body.data).toHaveLength(1);
  });
});
