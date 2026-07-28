/**
 * @file metrics.routes.test.ts
 * @description Integration-style tests for the metrics write endpoints (Issue #692).
 *
 * Coverage targets:
 *  - Happy paths: all 5 write endpoints accept valid bodies → 204.
 *  - Missing required field → 400 validation_error.
 *  - Wrong type → 400 validation_error.
 *  - Invalid enum value → 400 validation_error.
 *  - Unknown/extra field (strict schema) → 400 validation_error.
 *  - Out-of-range numeric values (NaN, Infinity, negative, over-max).
 *  - Non-JSON / empty body → 400.
 *  - Service-level error propagation → 500.
 */

import express from 'express';
import request from 'supertest';
import { createMetricsRouter } from './metrics.routes';
import { MetricsServiceLike } from '../observability/metrics-service';
import { WebhookOutcome } from '../observability/metrics-validation';
import { ServiceStatus } from '../observability/types';

// ---------------------------------------------------------------------------
// Mock MetricsService
// ---------------------------------------------------------------------------
function buildMockService(overrides?: Partial<MetricsServiceLike>): jest.Mocked<MetricsServiceLike> {
  return {
    contentType: 'text/plain',
    trackHttpRequest: jest.fn(),
    trackApiKeysRequest: jest.fn(),
    getMetrics: jest.fn().mockResolvedValue(''),
    recordHealthStatus: jest.fn(),
    recordWebhookDelivery: jest.fn(),
    setWebhookDlqDepth: jest.fn(),
    recordDisputesRequest: jest.fn(),
    ...overrides,
  } as jest.Mocked<MetricsServiceLike>;
}

function buildApp(service: MetricsServiceLike) {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/metrics', createMetricsRouter(service));
  return app;
}

// ---------------------------------------------------------------------------
// POST /api/v1/metrics/webhook/delivery
// ---------------------------------------------------------------------------
describe('POST /api/v1/metrics/webhook/delivery', () => {
  it('records a successful delivery and returns 204', async () => {
    const svc = buildMockService();
    const res = await request(buildApp(svc))
      .post('/api/v1/metrics/webhook/delivery')
      .send({ outcome: 'success' });

    expect(res.status).toBe(204);
    expect(svc.recordWebhookDelivery).toHaveBeenCalledWith('success');
  });

  it.each(['success', 'failure', 'dlq'] as WebhookOutcome[])(
    'accepts all valid outcome values: %s',
    async (outcome) => {
      const svc = buildMockService();
      const res = await request(buildApp(svc))
        .post('/api/v1/metrics/webhook/delivery')
        .send({ outcome });

      expect(res.status).toBe(204);
    },
  );

  it('returns 400 for an unknown outcome value', async () => {
    const svc = buildMockService();
    const res = await request(buildApp(svc))
      .post('/api/v1/metrics/webhook/delivery')
      .send({ outcome: 'partial_failure' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
  });

  it('returns 400 when outcome is missing', async () => {
    const svc = buildMockService();
    const res = await request(buildApp(svc))
      .post('/api/v1/metrics/webhook/delivery')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
  });

  it('returns 400 for an extra unknown field', async () => {
    const svc = buildMockService();
    const res = await request(buildApp(svc))
      .post('/api/v1/metrics/webhook/delivery')
      .send({ outcome: 'success', extra: 'field' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
  });

  it('returns 400 when outcome is a number', async () => {
    const svc = buildMockService();
    const res = await request(buildApp(svc))
      .post('/api/v1/metrics/webhook/delivery')
      .send({ outcome: 1 });

    expect(res.status).toBe(400);
  });

  it('returns 400 for a null body', async () => {
    const svc = buildMockService();
    const res = await request(buildApp(svc))
      .post('/api/v1/metrics/webhook/delivery')
      .set('Content-Type', 'application/json')
      .send('null');

    expect(res.status).toBe(400);
  });

  it('returns 400 for an array body', async () => {
    const svc = buildMockService();
    const res = await request(buildApp(svc))
      .post('/api/v1/metrics/webhook/delivery')
      .send(['success']);

    expect(res.status).toBe(400);
  });

  it('does not call recordWebhookDelivery on validation failure', async () => {
    const svc = buildMockService();
    await request(buildApp(svc))
      .post('/api/v1/metrics/webhook/delivery')
      .send({ outcome: 'bad' });

    expect(svc.recordWebhookDelivery).not.toHaveBeenCalled();
  });

  it('returns error details in the body on validation failure', async () => {
    const svc = buildMockService();
    const res = await request(buildApp(svc))
      .post('/api/v1/metrics/webhook/delivery')
      .send({ outcome: 'bad' });

    expect(res.body.error).toHaveProperty('details');
    expect(Array.isArray(res.body.error.details)).toBe(true);
  });

  it('returns 500 when service throws', async () => {
    const svc = buildMockService({
      recordWebhookDelivery: jest.fn().mockImplementation(() => {
        throw new Error('store error');
      }),
    });
    const res = await request(buildApp(svc))
      .post('/api/v1/metrics/webhook/delivery')
      .send({ outcome: 'success' });

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('internal_error');
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/metrics/webhook/dlq-depth
// ---------------------------------------------------------------------------
describe('POST /api/v1/metrics/webhook/dlq-depth', () => {
  it('sets DLQ depth 0 and returns 204', async () => {
    const svc = buildMockService();
    const res = await request(buildApp(svc))
      .post('/api/v1/metrics/webhook/dlq-depth')
      .send({ depth: 0 });

    expect(res.status).toBe(204);
    expect(svc.setWebhookDlqDepth).toHaveBeenCalledWith(0);
  });

  it('sets a mid-range depth and returns 204', async () => {
    const svc = buildMockService();
    const res = await request(buildApp(svc))
      .post('/api/v1/metrics/webhook/dlq-depth')
      .send({ depth: 42 });

    expect(res.status).toBe(204);
    expect(svc.setWebhookDlqDepth).toHaveBeenCalledWith(42);
  });

  it('accepts MAX_DLQ_DEPTH (boundary)', async () => {
    const svc = buildMockService();
    const res = await request(buildApp(svc))
      .post('/api/v1/metrics/webhook/dlq-depth')
      .send({ depth: 10_000_000 });

    expect(res.status).toBe(204);
  });

  it('returns 400 for depth exceeding MAX_DLQ_DEPTH', async () => {
    const svc = buildMockService();
    const res = await request(buildApp(svc))
      .post('/api/v1/metrics/webhook/dlq-depth')
      .send({ depth: 10_000_001 });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
  });

  it('returns 400 for a negative depth', async () => {
    const svc = buildMockService();
    const res = await request(buildApp(svc))
      .post('/api/v1/metrics/webhook/dlq-depth')
      .send({ depth: -1 });

    expect(res.status).toBe(400);
  });

  it('returns 400 for a float depth', async () => {
    const svc = buildMockService();
    const res = await request(buildApp(svc))
      .post('/api/v1/metrics/webhook/dlq-depth')
      .send({ depth: 1.5 });

    expect(res.status).toBe(400);
  });

  it('returns 400 when depth is a string', async () => {
    const svc = buildMockService();
    const res = await request(buildApp(svc))
      .post('/api/v1/metrics/webhook/dlq-depth')
      .send({ depth: '10' });

    expect(res.status).toBe(400);
  });

  it('returns 400 for missing depth field', async () => {
    const svc = buildMockService();
    const res = await request(buildApp(svc))
      .post('/api/v1/metrics/webhook/dlq-depth')
      .send({});

    expect(res.status).toBe(400);
  });

  it('returns 400 for an extra unknown field', async () => {
    const svc = buildMockService();
    const res = await request(buildApp(svc))
      .post('/api/v1/metrics/webhook/dlq-depth')
      .send({ depth: 5, extra: 1 });

    expect(res.status).toBe(400);
  });

  it('returns 400 when depth is NaN (sent as numeric value in JSON)', async () => {
    // NaN cannot be JSON-serialized; a string "NaN" maps to wrong type
    const svc = buildMockService();
    const res = await request(buildApp(svc))
      .post('/api/v1/metrics/webhook/dlq-depth')
      .send({ depth: 'NaN' });

    expect(res.status).toBe(400);
  });

  it('returns 500 when service throws', async () => {
    const svc = buildMockService({
      setWebhookDlqDepth: jest.fn().mockImplementation(() => {
        throw new Error('gauge error');
      }),
    });
    const res = await request(buildApp(svc))
      .post('/api/v1/metrics/webhook/dlq-depth')
      .send({ depth: 1 });

    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/metrics/health-status
// ---------------------------------------------------------------------------
describe('POST /api/v1/metrics/health-status', () => {
  it.each(['up', 'degraded', 'down'] as ServiceStatus[])(
    'records status "%s" and returns 204',
    async (status) => {
      const svc = buildMockService();
      const res = await request(buildApp(svc))
        .post('/api/v1/metrics/health-status')
        .send({ status });

      expect(res.status).toBe(204);
      expect(svc.recordHealthStatus).toHaveBeenCalledWith(status);
    },
  );

  it('returns 400 for an unknown status', async () => {
    const svc = buildMockService();
    const res = await request(buildApp(svc))
      .post('/api/v1/metrics/health-status')
      .send({ status: 'healthy' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
  });

  it('returns 400 for a missing status field', async () => {
    const svc = buildMockService();
    const res = await request(buildApp(svc))
      .post('/api/v1/metrics/health-status')
      .send({});

    expect(res.status).toBe(400);
  });

  it('returns 400 for an extra unknown field', async () => {
    const svc = buildMockService();
    const res = await request(buildApp(svc))
      .post('/api/v1/metrics/health-status')
      .send({ status: 'up', bogus: true });

    expect(res.status).toBe(400);
  });

  it('returns 400 when status is a number', async () => {
    const svc = buildMockService();
    const res = await request(buildApp(svc))
      .post('/api/v1/metrics/health-status')
      .send({ status: 1 });

    expect(res.status).toBe(400);
  });

  it('does not call recordHealthStatus on invalid input', async () => {
    const svc = buildMockService();
    await request(buildApp(svc))
      .post('/api/v1/metrics/health-status')
      .send({ status: 'ok' });

    expect(svc.recordHealthStatus).not.toHaveBeenCalled();
  });

  it('returns 500 when service throws', async () => {
    const svc = buildMockService({
      recordHealthStatus: jest.fn().mockImplementation(() => {
        throw new Error('service error');
      }),
    });
    const res = await request(buildApp(svc))
      .post('/api/v1/metrics/health-status')
      .send({ status: 'up' });

    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/metrics/dlq/operation
// ---------------------------------------------------------------------------
describe('POST /api/v1/metrics/dlq/operation', () => {
  it.each(['enqueue', 'drop_overflow', 'drop_poison'])(
    'accepts operation "%s" and returns 204',
    async (operation) => {
      const svc = buildMockService();
      const res = await request(buildApp(svc))
        .post('/api/v1/metrics/dlq/operation')
        .send({ operation });

      expect(res.status).toBe(204);
    },
  );

  it('returns 400 for an unknown operation', async () => {
    const svc = buildMockService();
    const res = await request(buildApp(svc))
      .post('/api/v1/metrics/dlq/operation')
      .send({ operation: 'purge' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
  });

  it('returns 400 for a missing operation field', async () => {
    const svc = buildMockService();
    const res = await request(buildApp(svc))
      .post('/api/v1/metrics/dlq/operation')
      .send({});

    expect(res.status).toBe(400);
  });

  it('returns 400 for extra unknown fields', async () => {
    const svc = buildMockService();
    const res = await request(buildApp(svc))
      .post('/api/v1/metrics/dlq/operation')
      .send({ operation: 'enqueue', extra: 'x' });

    expect(res.status).toBe(400);
  });

  it('returns 400 when operation is a number', async () => {
    const svc = buildMockService();
    const res = await request(buildApp(svc))
      .post('/api/v1/metrics/dlq/operation')
      .send({ operation: 0 });

    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/metrics/dlq/replay
// ---------------------------------------------------------------------------
describe('POST /api/v1/metrics/dlq/replay', () => {
  it.each(['success', 'failed', 'idempotent_noop', 'error'])(
    'accepts replay outcome "%s" and returns 204',
    async (outcome) => {
      const svc = buildMockService();
      const res = await request(buildApp(svc))
        .post('/api/v1/metrics/dlq/replay')
        .send({ outcome });

      expect(res.status).toBe(204);
    },
  );

  it('returns 400 for an unknown replay outcome', async () => {
    const svc = buildMockService();
    const res = await request(buildApp(svc))
      .post('/api/v1/metrics/dlq/replay')
      .send({ outcome: 'retried' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
  });

  it('returns 400 for a missing outcome field', async () => {
    const svc = buildMockService();
    const res = await request(buildApp(svc))
      .post('/api/v1/metrics/dlq/replay')
      .send({});

    expect(res.status).toBe(400);
  });

  it('returns 400 for extra unknown fields', async () => {
    const svc = buildMockService();
    const res = await request(buildApp(svc))
      .post('/api/v1/metrics/dlq/replay')
      .send({ outcome: 'success', extra: 'field' });

    expect(res.status).toBe(400);
  });

  it('returns 400 when outcome is an array', async () => {
    const svc = buildMockService();
    const res = await request(buildApp(svc))
      .post('/api/v1/metrics/dlq/replay')
      .send({ outcome: ['success'] });

    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Error envelope shape
// ---------------------------------------------------------------------------
describe('Error response envelope', () => {
  it('all 400 responses include error.code = "validation_error"', async () => {
    const svc = buildMockService();
    const responses = await Promise.all([
      request(buildApp(svc))
        .post('/api/v1/metrics/webhook/delivery')
        .send({ outcome: 'bad' }),
      request(buildApp(svc))
        .post('/api/v1/metrics/webhook/dlq-depth')
        .send({ depth: -1 }),
      request(buildApp(svc))
        .post('/api/v1/metrics/health-status')
        .send({ status: 'unknown' }),
      request(buildApp(svc))
        .post('/api/v1/metrics/dlq/operation')
        .send({ operation: 'unknown' }),
      request(buildApp(svc))
        .post('/api/v1/metrics/dlq/replay')
        .send({ outcome: 'unknown' }),
    ]);

    for (const res of responses) {
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('validation_error');
      expect(Array.isArray(res.body.error.details)).toBe(true);
    }
  });

  it('validation error details include field and message', async () => {
    const svc = buildMockService();
    const res = await request(buildApp(svc))
      .post('/api/v1/metrics/webhook/delivery')
      .send({ outcome: 'bad' });

    const detail = res.body.error.details[0];
    expect(detail).toHaveProperty('field');
    expect(detail).toHaveProperty('message');
  });
});

// ---------------------------------------------------------------------------
// Rate Limiting
// ---------------------------------------------------------------------------
describe('Rate Limiting on Metrics Routes', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    process.env.METRICS_RATE_LIMIT_MAX_REQUESTS = '3';
    process.env.METRICS_RATE_LIMIT_WINDOW_MS = '1000';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.useRealTimers();
  });

  it('allows requests up to the limit', async () => {
    const svc = buildMockService();
    // Build app directly to recreate rate limiter with updated env
    const app = buildApp(svc);

    for (let i = 0; i < 3; i++) {
      const res = await request(app)
        .post('/api/v1/metrics/health-status')
        .send({ status: 'up' });
      expect(res.status).toBe(204);
    }
  });

  it('returns 429 over the limit', async () => {
    const svc = buildMockService();
    const app = buildApp(svc);

    for (let i = 0; i < 3; i++) {
      await request(app)
        .post('/api/v1/metrics/health-status')
        .send({ status: 'up' });
    }

    const res = await request(app)
      .post('/api/v1/metrics/health-status')
      .send({ status: 'up' });

    expect(res.status).toBe(429);
    expect(res.headers).toHaveProperty('retry-after');
  });

  it('resets after the window expires', async () => {
    jest.useFakeTimers();
    // Advance Date.now to start window at a known time to avoid issues with fake timers
    jest.setSystemTime(new Date('2023-01-01T00:00:00Z'));
    
    const svc = buildMockService();
    const app = buildApp(svc);

    for (let i = 0; i < 3; i++) {
      await request(app)
        .post('/api/v1/metrics/health-status')
        .send({ status: 'up' });
    }

    let res = await request(app)
      .post('/api/v1/metrics/health-status')
      .send({ status: 'up' });
    expect(res.status).toBe(429);

    jest.advanceTimersByTime(1500);

    res = await request(app)
      .post('/api/v1/metrics/health-status')
      .send({ status: 'up' });
    expect(res.status).toBe(204);
  });
});
