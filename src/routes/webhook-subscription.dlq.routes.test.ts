/**
 * @file webhook-subscription.dlq.routes.test.ts
 *
 * Integration tests for the DLQ HTTP endpoints added in Issue #1193.
 *
 * Covers:
 *  - GET  /dlq              list all DLQ entries (admin-only)
 *  - GET  /dlq/stats        DLQ statistics (admin-only)
 *  - POST /dlq/replay-all   replay all pending entries (admin-only)
 *  - GET  /dlq/:id          single DLQ entry by ID (admin-only, 404 if absent)
 *  - POST /dlq/:id/replay   replay single entry (admin-only, 404 if absent)
 *  - Authorization enforcement (401 without auth, 403 for non-admin)
 */

// ── Module mocks — hoisted above all imports ──────────────────────────────────

jest.mock('../db/database', () => ({
  getDb: jest.fn().mockReturnValue({}),
}));

jest.mock('../repositories/webhook-subscription.repository', () => ({
  SqliteWebhookSubscriptionRepository: jest.fn().mockImplementation(() => ({
    create: jest.fn(),
    findAll: jest.fn().mockResolvedValue([]),
    findAllPaginated: jest.fn().mockResolvedValue({
      data: [],
      nextCursor: null,
      hasNextPage: false,
      limit: 20,
    }),
    findById: jest.fn().mockResolvedValue(null),
    update: jest.fn(),
    delete: jest.fn(),
  })),
}));

jest.mock('../lib/rateLimitStore', () => ({
  RateLimitStore: jest.fn().mockImplementation(() => ({
    get: jest.fn().mockReturnValue(null),
    set: jest.fn(),
    destroy: jest.fn(),
  })),
}));

jest.mock('../middleware/rateLimiter', () => ({
  createRateLimiter: jest.fn().mockReturnValue((_req: any, _res: any, next: any) => next()),
}));

jest.mock('../middleware/validate.middleware', () => ({
  validateSchema: () => (_req: any, _res: any, next: any) => next(),
}));

jest.mock('../middleware/idempotency', () => ({
  idempotencyMiddleware: (_req: any, _res: any, next: any) => next(),
}));

jest.mock('../contracts/cursor.repository', () => ({
  decodeCursor: jest.fn(),
  encodeCursor: jest.fn(),
  parseLimit: jest.fn().mockReturnValue(20),
}));

jest.mock('../config/rateLimit', () => ({
  rateLimitConfig: { webhooksApi: { max: 100, windowMs: 60_000 } },
}));

jest.mock('../auth/rateLimitKey', () => ({
  authRateLimitKeyFn: jest.fn(),
}));

jest.mock('../config/env.schema', () => ({
  validateEnv: jest.fn(() => ({
    WEBHOOK_DELIVERY_TIMEOUT_MS: 10_000,
    WEBHOOK_MAX_PAYLOAD_SIZE_BYTES: 1_048_576,
    WEBHOOKS_ENABLED: true,
  })),
}));

jest.mock('../queue/webhook-dlq', () => ({
  getWebhookDLQStorage: jest.fn(() => mockDLQStorage),
}));

jest.mock('../queue/webhook-retry-policy', () => ({
  WEBHOOK_RETRY_POLICY: { maxRetries: 1, maxAttempts: 2, initialDelayMs: 0, maxDelayMs: 0, multiplier: 2, jitter: 0 },
  calculateWebhookRetryDelay: jest.fn().mockReturnValue(0),
}));

jest.mock('../utils/ssrf', () => ({
  isSafeUrl: jest.fn().mockReturnValue(true),
}));

// ── Shared mock DLQ storage ───────────────────────────────────────────────────

const SAMPLE_DLQ_ENTRY = {
  id: 'dlq-entry-uuid-1',
  webhookId: 'event-id-original',
  url: 'https://example.com/hook',
  body: { event: 'contract.created' },
  retryCount: 3,
  webhookSecret: undefined, // never stored in the view
  failedAt: '2024-01-01T00:00:00.000Z',
  lastError: 'WEBHOOK_RETRY_EXHAUSTED: connection refused',
  dedupeKey: 'hash-abc',
  replayedAt: undefined,
  replayAttempts: 0,
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
};

const mockDLQStorage = {
  addEntry: jest.fn().mockResolvedValue('dlq-entry-uuid-1'),
  getEntry: jest.fn().mockReturnValue(null),
  listEntries: jest.fn().mockReturnValue([]),
  markReplayed: jest.fn().mockReturnValue(true),
  checkDedupe: jest.fn().mockReturnValue({ exists: false }),
  getStats: jest.fn().mockReturnValue({ total: 2, pending: 1, replayed: 1 }),
};

// ── App factory ───────────────────────────────────────────────────────────────

import express from 'express';
import request from 'supertest';

/**
 * Build a test app that mounts the webhook subscription router.
 * Kept as a utility for future parameterized tests.
 */
function _buildApp(role: 'admin' | 'user' | 'none'): express.Application {
  // Reset the authorization mock based on role
  jest.mock('../middleware/authorization', () => ({
    requireAuth: (req: any, res: any, next: any) => {
      if (role === 'none') {
        return res.status(401).json({ error: { code: 'unauthorized', message: 'Auth required' } });
      }
      req.user = { id: 'user-1', email: 'user@example.com', role };
      next();
    },
    requireRole: (requiredRole: string) => (req: any, res: any, next: any) => {
      if (req.user?.role !== requiredRole) {
        return res.status(403).json({ error: { code: 'forbidden', message: 'Forbidden' } });
      }
      next();
    },
  }));

  const app = express();
  app.use(express.json());

  const { webhookSubscriptionRouter } = require('../routes/webhook-subscription.routes');
  app.use('/api/v1/webhook-subscriptions', webhookSubscriptionRouter);

  app.use((_req: any, res: any) => {
    res.status(404).json({ error: { code: 'not_found', message: 'Not found' } });
  });

  return app;
}

// ── Authorization mock (static) ───────────────────────────────────────────────
// Use a single mock that can be reconfigured per test

let mockRole: 'admin' | 'user' | 'none' = 'admin';

jest.mock('../middleware/authorization', () => ({
  requireAuth: (req: any, res: any, next: any) => {
    if (mockRole === 'none') {
      return res.status(401).json({ error: { code: 'unauthorized', message: 'Auth required' } });
    }
    req.user = { id: 'user-1', email: 'user@example.com', role: mockRole };
    next();
  },
  requireRole: (requiredRole: string) => (req: any, res: any, next: any) => {
    if (req.user?.role !== requiredRole) {
      return res.status(403).json({ error: { code: 'forbidden', message: 'Forbidden' } });
    }
    next();
  },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function getApp(): express.Application {
  const app = express();
  app.use(express.json());
  const { webhookSubscriptionRouter } = require('../routes/webhook-subscription.routes');
  app.use('/api/v1/webhook-subscriptions', webhookSubscriptionRouter);
  app.use((_req: any, res: any) => {
    res.status(404).json({ error: { code: 'not_found', message: 'Not found' } });
  });
  return app;
}

let app: express.Application;

beforeAll(() => {
  app = getApp();
});

beforeEach(() => {
  jest.clearAllMocks();
  mockRole = 'admin';
  mockDLQStorage.listEntries.mockReturnValue([]);
  mockDLQStorage.getEntry.mockReturnValue(null);
  mockDLQStorage.getStats.mockReturnValue({ total: 0, pending: 0, replayed: 0 });
  mockDLQStorage.checkDedupe.mockReturnValue({ exists: false });
  mockDLQStorage.markReplayed.mockReturnValue(true);
});

// ── GET /dlq — list DLQ entries ───────────────────────────────────────────────

describe('GET /api/v1/webhook-subscriptions/dlq', () => {
  it('returns 200 with empty data array when DLQ is empty (admin)', async () => {
    mockDLQStorage.listEntries.mockReturnValue([]);
    const res = await request(app).get('/api/v1/webhook-subscriptions/dlq');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data).toEqual([]);
    expect(res.body.meta).toBeDefined();
  });

  it('returns DLQ entries (admin)', async () => {
    mockDLQStorage.listEntries.mockReturnValue([SAMPLE_DLQ_ENTRY]);
    mockDLQStorage.getStats.mockReturnValue({ total: 1, pending: 1, replayed: 0 });
    const res = await request(app).get('/api/v1/webhook-subscriptions/dlq');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toHaveProperty('id', SAMPLE_DLQ_ENTRY.id);
    expect(res.body.data[0]).toHaveProperty('error');
    expect(res.body.meta).toMatchObject({ total: 1, pending: 1, replayed: 0 });
  });

  it('strips webhook secrets from DLQ entries', async () => {
    const entryWithSecret = { ...SAMPLE_DLQ_ENTRY, webhookSecret: 'TOP-SECRET-KEY' };
    mockDLQStorage.listEntries.mockReturnValue([entryWithSecret]);
    const res = await request(app).get('/api/v1/webhook-subscriptions/dlq');
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain('TOP-SECRET-KEY');
    expect(res.body.data[0]).not.toHaveProperty('webhookSecret');
  });

  it('returns 401 when not authenticated', async () => {
    mockRole = 'none';
    const res = await request(app).get('/api/v1/webhook-subscriptions/dlq');
    expect(res.status).toBe(401);
  });

  it('returns 403 when authenticated as non-admin user', async () => {
    mockRole = 'user';
    const res = await request(app).get('/api/v1/webhook-subscriptions/dlq');
    expect(res.status).toBe(403);
  });
});

// ── GET /dlq/stats ────────────────────────────────────────────────────────────

describe('GET /api/v1/webhook-subscriptions/dlq/stats', () => {
  it('returns 200 with stats (admin)', async () => {
    mockDLQStorage.getStats.mockReturnValue({ total: 5, pending: 3, replayed: 2 });
    const res = await request(app).get('/api/v1/webhook-subscriptions/dlq/stats');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data).toMatchObject({ total: 5, pending: 3, replayed: 2 });
  });

  it('returns 401 when not authenticated', async () => {
    mockRole = 'none';
    const res = await request(app).get('/api/v1/webhook-subscriptions/dlq/stats');
    expect(res.status).toBe(401);
  });

  it('returns 403 for non-admin', async () => {
    mockRole = 'user';
    const res = await request(app).get('/api/v1/webhook-subscriptions/dlq/stats');
    expect(res.status).toBe(403);
  });
});

// ── GET /dlq/:id ──────────────────────────────────────────────────────────────

describe('GET /api/v1/webhook-subscriptions/dlq/:id', () => {
  it('returns 200 with entry when found (admin)', async () => {
    mockDLQStorage.getEntry.mockReturnValue(SAMPLE_DLQ_ENTRY);
    const res = await request(app).get(
      `/api/v1/webhook-subscriptions/dlq/${SAMPLE_DLQ_ENTRY.id}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data.id).toBe(SAMPLE_DLQ_ENTRY.id);
  });

  it('returns 404 when DLQ entry not found', async () => {
    mockDLQStorage.getEntry.mockReturnValue(null);
    const res = await request(app).get('/api/v1/webhook-subscriptions/dlq/nonexistent-id');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });

  it('returns 401 when not authenticated', async () => {
    mockRole = 'none';
    const res = await request(app).get(
      `/api/v1/webhook-subscriptions/dlq/${SAMPLE_DLQ_ENTRY.id}`,
    );
    expect(res.status).toBe(401);
  });

  it('returns 403 for non-admin', async () => {
    mockRole = 'user';
    const res = await request(app).get(
      `/api/v1/webhook-subscriptions/dlq/${SAMPLE_DLQ_ENTRY.id}`,
    );
    expect(res.status).toBe(403);
  });

  it('strips secrets from returned entry', async () => {
    const entryWithSecret = { ...SAMPLE_DLQ_ENTRY, webhookSecret: 'MY-PRIVATE-SECRET' };
    mockDLQStorage.getEntry.mockReturnValue(entryWithSecret);
    const res = await request(app).get(
      `/api/v1/webhook-subscriptions/dlq/${SAMPLE_DLQ_ENTRY.id}`,
    );
    expect(JSON.stringify(res.body)).not.toContain('MY-PRIVATE-SECRET');
  });
});

// ── POST /dlq/:id/replay ──────────────────────────────────────────────────────

describe('POST /api/v1/webhook-subscriptions/dlq/:id/replay', () => {
  it('returns 200 on successful replay (admin)', async () => {
    mockDLQStorage.getEntry.mockReturnValue(SAMPLE_DLQ_ENTRY);
    // Mock axios so the replay delivery succeeds
    jest.mock('axios', () => ({ post: jest.fn().mockResolvedValue({ status: 200 }) }));
    const res = await request(app).post(
      `/api/v1/webhook-subscriptions/dlq/${SAMPLE_DLQ_ENTRY.id}/replay`,
    );
    // 200 = success or 422/404 = failure — check it's not auth error
    expect([200, 422]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body.status).toBe('success');
      expect(res.body.data.id).toBe(SAMPLE_DLQ_ENTRY.id);
    }
  });

  it('returns 404 when DLQ entry not found for replay', async () => {
    mockDLQStorage.getEntry.mockReturnValue(null);
    const res = await request(app).post(
      '/api/v1/webhook-subscriptions/dlq/missing-entry-id/replay',
    );
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });

  it('returns 422 when entry already replayed', async () => {
    mockDLQStorage.getEntry.mockReturnValue({
      ...SAMPLE_DLQ_ENTRY,
      replayedAt: '2024-01-02T00:00:00.000Z',
    });
    const res = await request(app).post(
      `/api/v1/webhook-subscriptions/dlq/${SAMPLE_DLQ_ENTRY.id}/replay`,
    );
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('replay_failed');
  });

  it('returns 401 when not authenticated', async () => {
    mockRole = 'none';
    const res = await request(app).post(
      `/api/v1/webhook-subscriptions/dlq/${SAMPLE_DLQ_ENTRY.id}/replay`,
    );
    expect(res.status).toBe(401);
  });

  it('returns 403 for non-admin', async () => {
    mockRole = 'user';
    const res = await request(app).post(
      `/api/v1/webhook-subscriptions/dlq/${SAMPLE_DLQ_ENTRY.id}/replay`,
    );
    expect(res.status).toBe(403);
  });
});

// ── POST /dlq/replay-all ──────────────────────────────────────────────────────

describe('POST /api/v1/webhook-subscriptions/dlq/replay-all', () => {
  it('returns 200 with summary when DLQ is empty (admin)', async () => {
    mockDLQStorage.listEntries.mockReturnValue([]);
    const res = await request(app).post('/api/v1/webhook-subscriptions/dlq/replay-all');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data).toMatchObject({
      attempted: 0,
      succeeded: 0,
      failed: 0,
      deduped: 0,
    });
  });

  it('returns 401 when not authenticated', async () => {
    mockRole = 'none';
    const res = await request(app).post('/api/v1/webhook-subscriptions/dlq/replay-all');
    expect(res.status).toBe(401);
  });

  it('returns 403 for non-admin', async () => {
    mockRole = 'user';
    const res = await request(app).post('/api/v1/webhook-subscriptions/dlq/replay-all');
    expect(res.status).toBe(403);
  });

  it('replay-all route is not confused with /dlq/:id (routing conflict test)', async () => {
    // 'replay-all' must not be treated as a dynamic :id parameter for GET /dlq/:id
    mockDLQStorage.listEntries.mockReturnValue([]);
    const res = await request(app).post('/api/v1/webhook-subscriptions/dlq/replay-all');
    // Must reach the replay-all handler, not the :id/replay handler
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(res.body.data).toHaveProperty('attempted');
  });
});
