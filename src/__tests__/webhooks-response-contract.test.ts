import request from 'supertest';
import { randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import { createApp } from '../app';
import { getDb, closeDb } from '../db/database';
import { SqliteWebhookSubscriptionRepository } from '../repositories/webhook-subscription.repository';

// ---------------------------------------------------------------------------
// Setup & Constants
// ---------------------------------------------------------------------------

const TEST_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.JWT_SECRET = TEST_SECRET;
process.env.DB_PATH = ':memory:';

const adminToken = jwt.sign(
  { sub: 'admin-1', email: 'admin@tt.com', role: 'admin' },
  TEST_SECRET,
  { expiresIn: '1h' },
);

// ---------------------------------------------------------------------------
// Contract Keys
// ---------------------------------------------------------------------------

const SUCCESS_ENVELOPE_KEYS = ['status', 'data'] as const;
const PAGINATION_ENVELOPE_KEYS = ['status', 'data', 'meta'] as const;
const META_KEYS = ['nextCursor', 'hasNextPage', 'limit'] as const;

const SUBSCRIPTION_KEYS = [
  'id',
  'url',
  'eventType',
  'active',
  'createdAt',
  'updatedAt',
] as const;

const SUBSCRIPTION_KEYS_WITH_CONSUMER = [
  ...SUBSCRIPTION_KEYS,
  'consumerId',
] as const;

const DELETED_SUBSCRIPTION_KEYS = ['id', 'deleted'] as const;

const ERROR_ENVELOPE_KEYS = ['error'] as const;
const ERROR_BODY_KEYS = ['code', 'message', 'requestId'] as const;
const VALIDATION_ERROR_DETAIL_KEYS = ['path', 'message', 'code'] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function expectExactKeys(obj: Record<string, unknown>, allowed: readonly string[]): void {
  const actual = Object.keys(obj).sort();
  const expected = [...allowed].sort();
  expect(actual).toEqual(expected);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let app: ReturnType<typeof createApp>;
let db: ReturnType<typeof getDb>;
let repo: SqliteWebhookSubscriptionRepository;

beforeAll(() => {
  db = getDb(':memory:');
  repo = new SqliteWebhookSubscriptionRepository(db);
  app = createApp({ includeTerminalHandlers: false });
});

afterAll(() => {
  closeDb();
});

beforeEach(() => {
  db.exec('DELETE FROM webhook_subscriptions');
});

describe('Webhooks Response Contract', () => {
  describe('POST /api/v1/webhook-subscriptions', () => {
    it('success response envelope and data shape (no consumerId)', async () => {
      const payload = {
        url: 'https://example.com/hook',
        eventType: 'contract.created',
      };

      const res = await request(app)
        .post('/api/v1/webhook-subscriptions')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(payload);

      expect(res.status).toBe(201);
      expectExactKeys(res.body, SUCCESS_ENVELOPE_KEYS);
      expect(res.body.status).toBe('success');
      expectExactKeys(res.body.data, SUBSCRIPTION_KEYS);

      const d = res.body.data;
      expect(typeof d.id).toBe('string');
      expect(typeof d.url).toBe('string');
      expect(typeof d.eventType).toBe('string');
      expect(typeof d.active).toBe('boolean');
      expect(typeof d.createdAt).toBe('string');
      expect(typeof d.updatedAt).toBe('string');
    });

    it('success response envelope and data shape (with consumerId)', async () => {
      const consumerId = randomUUID();
      const payload = {
        consumerId,
        url: 'https://example.com/hook2',
        eventType: 'contract.updated',
      };

      const res = await request(app)
        .post('/api/v1/webhook-subscriptions')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(payload);

      expect(res.status).toBe(201);
      expectExactKeys(res.body, SUCCESS_ENVELOPE_KEYS);
      expect(res.body.status).toBe('success');
      expectExactKeys(res.body.data, SUBSCRIPTION_KEYS_WITH_CONSUMER);

      expect(res.body.data.consumerId).toBe(consumerId);
    });

    it('error envelope shape for validation failure', async () => {
      const res = await request(app)
        .post('/api/v1/webhook-subscriptions')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ url: 'not-a-url' });

      expect(res.status).toBe(400);
      expectExactKeys(res.body, ERROR_ENVELOPE_KEYS);
      expectExactKeys(res.body.error, [...ERROR_BODY_KEYS, 'details']);
      expect(res.body.error.code).toBe('validation_error');
      
      const detail = res.body.error.details[0];
      expectExactKeys(detail, VALIDATION_ERROR_DETAIL_KEYS);
    });
  });

  describe('GET /api/v1/webhook-subscriptions', () => {
    it('paginated success envelope and data shape', async () => {
      await repo.create({
        url: 'https://example.com/h',
        eventType: 'contract.created',
      });

      const res = await request(app)
        .get('/api/v1/webhook-subscriptions')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expectExactKeys(res.body, PAGINATION_ENVELOPE_KEYS);
      expect(res.body.status).toBe('success');
      expectExactKeys(res.body.meta, META_KEYS);
      
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBe(1);
      expectExactKeys(res.body.data[0], SUBSCRIPTION_KEYS);
    });
  });

  describe('GET /api/v1/webhook-subscriptions/:id', () => {
    it('success response envelope and data shape', async () => {
      const created = await repo.create({
        url: 'https://example.com/h',
        eventType: 'contract.created',
      });

      const res = await request(app)
        .get(`/api/v1/webhook-subscriptions/${created.id}`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expectExactKeys(res.body, SUCCESS_ENVELOPE_KEYS);
      expect(res.body.status).toBe('success');
      expectExactKeys(res.body.data, SUBSCRIPTION_KEYS);
    });

    it('error envelope shape for not found', async () => {
      const res = await request(app)
        .get(`/api/v1/webhook-subscriptions/${randomUUID()}`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(404);
      expectExactKeys(res.body, ERROR_ENVELOPE_KEYS);
      expectExactKeys(res.body.error, ERROR_BODY_KEYS);
      expect(res.body.error.code).toBe('not_found');
    });
  });

  describe('PATCH /api/v1/webhook-subscriptions/:id', () => {
    it('success response envelope and data shape', async () => {
      const created = await repo.create({
        url: 'https://example.com/h',
        eventType: 'contract.created',
      });

      const res = await request(app)
        .patch(`/api/v1/webhook-subscriptions/${created.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ active: false });

      expect(res.status).toBe(200);
      expectExactKeys(res.body, SUCCESS_ENVELOPE_KEYS);
      expect(res.body.status).toBe('success');
      expectExactKeys(res.body.data, SUBSCRIPTION_KEYS);
      expect(res.body.data.active).toBe(false);
    });
  });

  describe('DELETE /api/v1/webhook-subscriptions/:id', () => {
    it('success response envelope and data shape', async () => {
      const created = await repo.create({
        url: 'https://example.com/h',
        eventType: 'contract.created',
      });

      const res = await request(app)
        .delete(`/api/v1/webhook-subscriptions/${created.id}`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expectExactKeys(res.body, SUCCESS_ENVELOPE_KEYS);
      expect(res.body.status).toBe('success');
      expectExactKeys(res.body.data, DELETED_SUBSCRIPTION_KEYS);
      expect(res.body.data.id).toBe(created.id);
      expect(res.body.data.deleted).toBe(true);
    });
  });
});
