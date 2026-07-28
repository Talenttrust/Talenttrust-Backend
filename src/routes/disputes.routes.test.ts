/**
 * @file disputes.routes.test.ts
 * @description Comprehensive tests for rate limiting and correlation ID
 * propagation on disputes endpoints.
 *
 * Strategy
 * ────────
 * Tests import and exercise the actual disputes router (disputes.routes.ts).
 * Auth middleware is mocked so tests can focus on rate-limiting and
 * correlation propagation behaviour without requiring real JWT tokens.
 *
 * Coverage targets (≥ 95 %):
 *   - Requests within limit → 200/201, correct headers
 *   - At-limit boundary: last allowed request succeeds
 *   - Over-limit → 429 with Retry-After header
 *   - Rate-limit headers present (X-RateLimit-Limit, Remaining, Reset)
 *   - Window reset after time elapses
 *   - Abuse guard triggers hard-block after repeated violations
 *   - Per-client isolation (different IPs get independent counters)
 *   - sendHeaders=false suppresses headers
 *   - 429 response body conforms to error contract
 *   - Cross-route aggregation under the same limiter
 *   - Correlation ID accepted, validated, and echoed via headers and body
 *   - Correlation ID threaded through request-scoped logs
 *   - Request ID always generated and echoed
 */

import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { RateLimitStore } from '../lib/rateLimitStore';
import { requestIdMiddleware, REQUEST_ID_HEADER, CORRELATION_ID_HEADER } from '../middleware/requestId';
import { setWriteRecordImpl } from '../logger';

// ── Mock auth middleware — applied BEFORE we import the router ────────────
// The disputes router imports requireAuth/requirePermission from this module,
// so we mock them to no-op passthrough middleware.

jest.mock('../middleware/authorization', () => ({
  requireAuth: (_req: Request, _res: Response, next: NextFunction) => next(),
  requirePermission: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));

// ── Mutable feature flag mock ─────────────────────────────────────────────
let mockDisputesEnabled = true;
jest.mock('../config/features', () => ({
  features: {
    get disputesEnabled() { return mockDisputesEnabled; },
  },
}));

// Import the actual disputes router AFTER the mock is registered
import {
  createDisputesRouter,
  createDisputesObservabilityMiddleware,
} from './disputes.routes';
import { Logger, LogRecord } from '../logger';
import { MetricsService } from '../observability/metrics-service';
import { Registry } from 'prom-client';

// ── Helpers ───────────────────────────────────────────────────────────────

const silentLogger = new Logger();
jest.spyOn(silentLogger as any, 'log').mockImplementation(() => undefined);

/** Shared router for rate-limit tests (matches production singleton wiring). */
const disputesRouter = createDisputesRouter({ log: silentLogger });

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  app.use('/api/v1/disputes', disputesRouter);
  return app;
}

/** Captures log records written during a test. */
function captureLogs(): { records: Record<string, unknown>[]; restore: () => void } {
  const records: Record<string, unknown>[] = [];
  setWriteRecordImpl((record: Record<string, unknown>) => { records.push(record); });
  return {
    records,
    restore: () => {
      setWriteRecordImpl((record: Record<string, unknown>) => {
        const line = JSON.stringify(record);
        if (record.level === 'error') {
          process.stderr.write(line + '\n');
        } else {
          process.stdout.write(line + '\n');
        }
      });
    },
  };
}

/** Fire `n` sequential requests against `path` from the same IP */
async function fireRequests(
  app: ReturnType<typeof buildApp>,
  n: number,
  path: string,
  ip = '1.2.3.4',
  method: 'get' | 'post' | 'patch' | 'delete' = 'get',
) {
  const results: request.Response[] = [];
  for (let i = 0; i < n; i++) {
    const reqBuilder = request(app)[method](path).set('X-Forwarded-For', ip);
    if (method === 'post') {
      reqBuilder.send({ contractId: testUuid, reason: 'test-dispute' });
    } else if (method !== 'get') {
      reqBuilder.send({ status: 'resolved' });
    }
    results.push(await reqBuilder);
  }
  return results;
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('Disputes endpoints — rate limiting', () => {
  beforeEach(() => {
    mockDisputesEnabled = true;
  });

  // ── Within limit ────────────────────────────────────────────────────────

  describe('within rate limit', () => {
    it('GET /api/v1/disputes returns 200 within the limit', async () => {
      const app = buildApp();
      const res = await request(app)
        .get('/api/v1/disputes')
        .set('X-Forwarded-For', '10.0.0.1');
      expect(res.status).toBe(200);
    });

    it('POST /api/v1/disputes returns 201 within the limit', async () => {
      const app = buildApp();
      const res = await request(app)
        .post('/api/v1/disputes')
        .set('X-Forwarded-For', '10.0.0.2')
        .send({ contractId: testUuid, reason: 'test' });
      expect(res.status).toBe(201);
    });

    it('sets X-RateLimit-Limit header on API responses', async () => {
      const app = buildApp();
      const res = await request(app)
        .get('/api/v1/disputes')
        .set('X-Forwarded-For', '10.0.0.3');
      expect(res.headers['x-ratelimit-limit']).toBeDefined();
    });

    it('decrements X-RateLimit-Remaining with each request', async () => {
      const app = buildApp();
      const results = await fireRequests(app, 3, '/api/v1/disputes', '10.0.0.4');
      const r1 = Number(results[0].headers['x-ratelimit-remaining']);
      const r2 = Number(results[1].headers['x-ratelimit-remaining']);
      const r3 = Number(results[2].headers['x-ratelimit-remaining']);
      expect(r2).toBeLessThan(r1);
      expect(r3).toBeLessThan(r2);
    });

    it('sets X-RateLimit-Reset to a positive integer', async () => {
      const app = buildApp();
      const res = await request(app)
        .get('/api/v1/disputes')
        .set('X-Forwarded-For', '10.0.0.5');
      expect(Number(res.headers['x-ratelimit-reset'])).toBeGreaterThan(0);
    });
  });

  // ── At-limit boundary ───────────────────────────────────────────────────

  describe('at-limit boundary', () => {
    it('allows requests up to the limit and returns 429 immediately after', async () => {
      const app = buildApp();
      const ip = '11.0.0.1';
      // Fire many requests until we hit the limit
      const limit = Number(
        (await request(app).get('/api/v1/disputes').set('X-Forwarded-For', ip))
          .headers['x-ratelimit-limit'],
      );

      let blocked = false;
      for (let i = 0; i <= limit + 5; i++) {
        const res = await request(app)
          .get('/api/v1/disputes')
          .set('X-Forwarded-For', ip);
        if (res.status === 429) {
          blocked = true;
          // Remaining should be 0 at the point of blocking
          expect(res.headers['x-ratelimit-remaining']).toBe('0');
          break;
        }
        expect(res.status).toBe(200);
      }
      expect(blocked).toBe(true);
    });

    it('sets X-RateLimit-Remaining to 0 right before the limit', async () => {
      const app = buildApp();
      const ip = '11.0.0.2';
      const limit = Number(
        (await request(app).get('/api/v1/disputes').set('X-Forwarded-For', ip))
          .headers['x-ratelimit-limit'],
      );

      // Send exactly limit-1 requests first
      for (let i = 1; i < limit; i++) {
        await request(app).get('/api/v1/disputes').set('X-Forwarded-For', ip);
      }
      // The next (at-limit) request should show Remaining=1 before the request
      // and Remaining=0 after
      const atLimit = await request(app)
        .get('/api/v1/disputes')
        .set('X-Forwarded-For', ip);
      expect(atLimit.headers['x-ratelimit-remaining']).toBe('0');
    });
  });

  // ── Over-limit 429 ──────────────────────────────────────────────────────

  describe('over-limit → 429', () => {
    it('returns 429 when rate limit is exceeded', async () => {
      const app = buildApp();
      const ip = '12.0.0.1';
      const limit = Number(
        (await request(app).get('/api/v1/disputes').set('X-Forwarded-For', ip))
          .headers['x-ratelimit-limit'],
      );

      // Exhaust the limit
      for (let i = 0; i < limit; i++) {
        await request(app).get('/api/v1/disputes').set('X-Forwarded-For', ip);
      }
      const over = await request(app)
        .get('/api/v1/disputes')
        .set('X-Forwarded-For', ip);
      expect(over.status).toBe(429);
    });

    it('includes Retry-After header on 429 response', async () => {
      const app = buildApp();
      const ip = '12.0.0.2';
      const limit = Number(
        (await request(app).get('/api/v1/disputes').set('X-Forwarded-For', ip))
          .headers['x-ratelimit-limit'],
      );

      for (let i = 0; i < limit; i++) {
        await request(app).get('/api/v1/disputes').set('X-Forwarded-For', ip);
      }
      const over = await request(app)
        .get('/api/v1/disputes')
        .set('X-Forwarded-For', ip);
      expect(over.headers['retry-after']).toBeDefined();
    });

    it('returns a safe error body on 429 (no information leakage)', async () => {
      const app = buildApp();
      const ip = '12.0.0.3';
      const limit = Number(
        (await request(app).get('/api/v1/disputes').set('X-Forwarded-For', ip))
          .headers['x-ratelimit-limit'],
      );

      for (let i = 0; i < limit; i++) {
        await request(app).get('/api/v1/disputes').set('X-Forwarded-For', ip);
      }
      const over = await request(app)
        .get('/api/v1/disputes')
        .set('X-Forwarded-For', ip);
      expect(over.body).toHaveProperty('error');
      expect(over.body.error).toHaveProperty('code');
      expect(over.body.error).toHaveProperty('message');
    });

    it('POST /api/v1/disputes returns 429 when limit exceeded', async () => {
      const app = buildApp();
      const ip = '12.0.0.4';
      const limit = Number(
        (await request(app).get('/api/v1/disputes').set('X-Forwarded-For', ip))
          .headers['x-ratelimit-limit'],
      );

      for (let i = 0; i < limit; i++) {
        await request(app)
          .post('/api/v1/disputes')
          .set('X-Forwarded-For', ip)
          .send({ contractId: testUuid, reason: 'test' });
      }
      const over = await request(app)
        .get('/api/v1/disputes')
        .set('X-Forwarded-For', ip);
      expect(over.status).toBe(429);
    });

    it('PATCH /api/v1/disputes/:id returns 429 when limit exceeded', async () => {
      const app = buildApp();
      const ip = '12.0.0.5';
      const limit = Number(
        (await request(app).get('/api/v1/disputes').set('X-Forwarded-For', ip))
          .headers['x-ratelimit-limit'],
      );

      for (let i = 0; i < limit; i++) {
        await request(app)
          .patch(`/api/v1/disputes/${testUuid}`)
          .set('X-Forwarded-For', ip)
          .send({ status: 'resolved' });
      }
      const over = await request(app)
        .get('/api/v1/disputes')
        .set('X-Forwarded-For', ip);
      expect(over.status).toBe(429);
    });

    it('DELETE /api/v1/disputes/:id returns 429 when limit exceeded', async () => {
      const app = buildApp();
      const ip = '12.0.0.6';
      const limit = Number(
        (await request(app).get('/api/v1/disputes').set('X-Forwarded-For', ip))
          .headers['x-ratelimit-limit'],
      );

      for (let i = 0; i < limit; i++) {
        await request(app)
          .delete(`/api/v1/disputes/${testUuid}`)
          .set('X-Forwarded-For', ip);
      }
      const over = await request(app)
        .get('/api/v1/disputes')
        .set('X-Forwarded-For', ip);
      expect(over.status).toBe(429);
    });
  });

  // ── Sliding window reset ────────────────────────────────────────────────

  describe('window reset', () => {
    it('resets the counter after windowMs elapses', async () => {
      // Use fake timers and a fresh store so the window rolls forward cleanly.
      jest.useFakeTimers();
      const store = new RateLimitStore({ sweepIntervalMs: 9_999_999 });
      // We must override the disputes router's internal store by
      // re-importing the module — but since we can't change the router's
      // built-in limiter, we verify window-reset behaviour using a
      // hand-rolled app configured with a very short window.
      //
      // This test verifies the sliding-window algorithm works correctly
      // when the disputes limiter is exercised.  The actual router
      // uses the shared store from rateLimitConfig which has a 60s window,
      // so we test the algorithm in controlled isolation.

      const { createRateLimiter } = require('../middleware/rateLimiter');
      const limiter = createRateLimiter({
        maxRequests: 2,
        windowMs: 1_000,
        abuseThreshold: 99,
        store,
      });

      const app = express();
      app.use(express.json());
      app.use('/api/v1/disputes', limiter);
      app.get('/api/v1/disputes', (_req: Request, res: Response) =>
        res.json({ disputes: [] }),
      );

      const ip = '13.0.0.1';
      // Exhaust: 2 requests within limit
      await request(app).get('/api/v1/disputes').set('X-Forwarded-For', ip);
      await request(app).get('/api/v1/disputes').set('X-Forwarded-For', ip);

      // Advance beyond the window
      jest.advanceTimersByTime(1_001);

      // Should reset and allow again
      const res = await request(app)
        .get('/api/v1/disputes')
        .set('X-Forwarded-For', ip);
      expect(res.status).toBe(200);

      jest.useRealTimers();
      store.destroy();
    });
  });

  // ── Abuse guard (hard-block) ────────────────────────────────────────────

  describe('abuse guard', () => {
    it('hard-blocks after repeated rate-limit violations', async () => {
      const { createRateLimiter } = require('../middleware/rateLimiter');
      const store = new RateLimitStore({ sweepIntervalMs: 9_999_999 });
      const limiter = createRateLimiter({
        maxRequests: 1,
        windowMs: 60_000,
        abuseThreshold: 2,
        blockDurationMs: 60_000,
        store,
      });

      const app = express();
      app.use(express.json());
      app.use('/api/v1/disputes', limiter);
      app.get('/api/v1/disputes', (_req: Request, res: Response) =>
        res.json({ disputes: [] }),
      );

      const ip = '14.0.0.1';
      // Violation 1: request beyond limit of 1
      await request(app).get('/api/v1/disputes').set('X-Forwarded-For', ip);
      await request(app).get('/api/v1/disputes').set('X-Forwarded-For', ip);

      // Violation 2 triggers hard-block
      let blocked = false;
      for (let i = 0; i < 10; i++) {
        const res = await request(app)
          .get('/api/v1/disputes')
          .set('X-Forwarded-For', ip);
        if (res.headers['x-ratelimit-blocked'] === 'true') {
          expect(res.status).toBe(429);
          expect(res.headers['retry-after']).toBeDefined();
          blocked = true;
          break;
        }
      }
      expect(blocked).toBe(true);

      store.destroy();
    });
  });

  // ── Per-client isolation ────────────────────────────────────────────────

  describe('per-client isolation', () => {
    it('isolates rate limits per IP address', async () => {
      const app = buildApp();
      const ipA = '15.0.0.1';
      const ipB = '15.0.0.2';

      const limit = Number(
        (await request(app).get('/api/v1/disputes').set('X-Forwarded-For', ipA))
          .headers['x-ratelimit-limit'],
      );

      // IP A exhausts its limit
      for (let i = 0; i <= limit; i++) {
        await request(app).get('/api/v1/disputes').set('X-Forwarded-For', ipA);
      }

      // IP B is unaffected
      const res = await request(app)
        .get('/api/v1/disputes')
        .set('X-Forwarded-For', ipB);
      expect(res.status).toBe(200);
    });
  });

  // ── 429 response body contract ──────────────────────────────────────────

  describe('429 response body contract', () => {
    it('returns error.code "rate_limited" in the 429 response body', async () => {
      const app = buildApp();
      const ip = '18.0.0.1';
      const limit = Number(
        (await request(app).get('/api/v1/disputes').set('X-Forwarded-For', ip))
          .headers['x-ratelimit-limit'],
      );

      for (let i = 0; i <= limit; i++) {
        await request(app).get('/api/v1/disputes').set('X-Forwarded-For', ip);
      }
      const over = await request(app)
        .get('/api/v1/disputes')
        .set('X-Forwarded-For', ip);
      expect(over.body.error).toBeDefined();
      expect(over.body.error.code).toBe('rate_limited');
    });

    it('returns a sanitized message (no stack traces)', async () => {
      const app = buildApp();
      const ip = '18.0.0.2';
      const limit = Number(
        (await request(app).get('/api/v1/disputes').set('X-Forwarded-For', ip))
          .headers['x-ratelimit-limit'],
      );

      for (let i = 0; i <= limit; i++) {
        await request(app).get('/api/v1/disputes').set('X-Forwarded-For', ip);
      }
      const over = await request(app)
        .get('/api/v1/disputes')
        .set('X-Forwarded-For', ip);
      expect(over.body.error.message).toBeTruthy();
      expect(over.body.error.message).not.toContain('Error');
      expect(over.body.error.message).not.toContain('at ');
    });
  });

  // ── Feature flag ─────────────────────────────────────────────────────────

  describe('feature flag', () => {
    beforeEach(() => {
      mockDisputesEnabled = true;
    });

    it('returns 200 when feature is enabled', async () => {
      mockDisputesEnabled = true;
      const app = buildApp();
      const res = await request(app)
        .get('/api/v1/disputes')
        .set('X-Forwarded-For', '20.0.0.1');
      expect(res.status).toBe(200);
    });

    it('returns 404 with feature_disabled when feature is disabled', async () => {
      mockDisputesEnabled = false;
      const app = buildApp();
      const res = await request(app)
        .get('/api/v1/disputes')
        .set('X-Forwarded-For', '20.0.0.2');
      expect(res.status).toBe(404);
      expect(res.body).toHaveProperty('error');
      expect(res.body.error.code).toBe('feature_disabled');
      expect(res.body.error.message).toBe('Disputes feature is currently disabled.');
    });

    it('returns 404 for POST when feature is disabled', async () => {
      mockDisputesEnabled = false;
      const app = buildApp();
      const res = await request(app)
        .post('/api/v1/disputes')
        .set('X-Forwarded-For', '20.0.0.3')
        .send({ contractId: testUuid, reason: 'test' });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('feature_disabled');
    });

    it('returns 404 for PATCH when feature is disabled', async () => {
      mockDisputesEnabled = false;
      const app = buildApp();
      const res = await request(app)
        .patch(`/api/v1/disputes/${testUuid}`)
        .set('X-Forwarded-For', '20.0.0.4')
        .send({ status: 'resolved' });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('feature_disabled');
    });

    it('returns 404 for DELETE when feature is disabled', async () => {
      mockDisputesEnabled = false;
      const app = buildApp();
      const res = await request(app)
        .delete(`/api/v1/disputes/${testUuid}`)
        .set('X-Forwarded-For', '20.0.0.5');
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('feature_disabled');
    });

    it('uses "unknown" requestId when res.locals is missing', async () => {
      mockDisputesEnabled = false;
      const app = express();
      app.use(express.json());
      app.use('/api/v1/disputes', disputesRouter);
      const res = await request(app)
        .get('/api/v1/disputes')
        .set('X-Forwarded-For', '20.0.0.6');
      expect(res.status).toBe(404);
      expect(res.body.error.requestId).toBe('unknown');
    });
  });

  // ── Cross-route counting ────────────────────────────────────────────────

  describe('cross-route rate limit aggregation', () => {
    it('aggregates rate limits across all disputes routes under the same limiter', async () => {
      const app = buildApp();
      const ip = '19.0.0.1';
      const limit = Number(
        (await request(app).get('/api/v1/disputes').set('X-Forwarded-For', ip))
          .headers['x-ratelimit-limit'],
      );

      // The initial limit-check above already consumed 1 slot.
      // Consume limit-3 more across different routes so the next request
      // is exactly at the limit (limit-th request = allowed).
      await request(app).get('/api/v1/disputes').set('X-Forwarded-For', ip);
      for (let i = 2; i < limit - 1; i++) {
        await request(app)
          .get(`/api/v1/disputes/${testUuid}`)
          .set('X-Forwarded-For', ip);
      }

      // At-limit request succeeds (the limit-th request)
      const atLimit = await request(app)
        .get('/api/v1/disputes')
        .set('X-Forwarded-For', ip);
      expect(atLimit.status).toBe(200);

      // Over-limit → 429
      const over = await request(app)
        .get('/api/v1/disputes')
        .set('X-Forwarded-For', ip);
      expect(over.status).toBe(429);
    });
  });

  // ── Read caching ────────────────────────────────────────────────────────

  describe('read caching', () => {
    it('GET / returns valid response contract with caching', async () => {
      const app = buildApp();
      const res = await request(app)
        .get('/api/v1/disputes')
        .set('X-Forwarded-For', '90.0.0.1');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('disputes');
      expect(Array.isArray(res.body.disputes)).toBe(true);
    });

    it('GET /:id returns the dispute with the correct id', async () => {
      const app = buildApp();
      const res = await request(app)
        .get('/api/v1/disputes/dispute-42')
        .set('X-Forwarded-For', '90.0.0.2');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('dispute');
      expect(res.body.dispute.id).toBe('dispute-42');
      expect(res.body.dispute).toHaveProperty('status');
      expect(res.body.dispute).toHaveProperty('createdAt');
    });
  });

  // ── Write invalidation ──────────────────────────────────────────────────

  describe('write invalidation', () => {
    it('POST / returns 201 and invalidates list cache for subsequent GET', async () => {
      const app = buildApp();
      const ip = '91.0.0.1';

      // Warm the list cache with a GET
      const getBefore = await request(app)
        .get('/api/v1/disputes')
        .set('X-Forwarded-For', ip);
      expect(getBefore.status).toBe(200);

      // POST creates a new dispute
      const postRes = await request(app)
        .post('/api/v1/disputes')
        .set('X-Forwarded-For', ip)
        .send({ reason: 'test-invalidation' });
      expect(postRes.status).toBe(201);
      expect(postRes.body).toHaveProperty('dispute');
      expect(postRes.body.dispute.status).toBe('open');

      // Subsequent GET still works
      const getAfter = await request(app)
        .get('/api/v1/disputes')
        .set('X-Forwarded-For', ip);
      expect(getAfter.status).toBe(200);
    });

    it('PATCH /:id returns 200 and invalidates caches', async () => {
      const app = buildApp();
      const ip = '91.0.0.2';

      const patchRes = await request(app)
        .patch('/api/v1/disputes/dispute-99')
        .set('X-Forwarded-For', ip)
        .send({ status: 'resolved' });
      expect(patchRes.status).toBe(200);
      expect(patchRes.body).toHaveProperty('dispute');
      expect(patchRes.body.dispute.id).toBe('dispute-99');
      expect(patchRes.body.dispute).toHaveProperty('updatedAt');
    });

    it('DELETE /:id returns 200 and invalidates caches', async () => {
      const app = buildApp();
      const ip = '91.0.0.3';

      const delRes = await request(app)
        .delete('/api/v1/disputes/dispute-77')
        .set('X-Forwarded-For', ip);
      expect(delRes.status).toBe(200);
      expect(delRes.body).toHaveProperty('message');
      expect(delRes.body.message).toContain('dispute-77');
    });
  });
});

// ── Issue #743: Structured metrics and logging ─────────────────────────────

function createSpyLogger(): { logger: Logger; records: LogRecord[] } {
  const records: LogRecord[] = [];
  const logger = new Logger();
  jest.spyOn(logger as any, 'log').mockImplementation(
    (_level: string, message: string, extra: Record<string, unknown> = {}) => {
      records.push({
        timestamp: new Date().toISOString(),
        level: _level as any,
        message,
        service: 'talenttrust-backend',
        ...extra,
      });
    },
  );
  return { logger, records };
}

describe('Disputes endpoints — observability', () => {
  it('records success metrics and structured log on 200', async () => {
    const register = new Registry();
    const metricsService = new MetricsService('test', register);
    const { logger, records } = createSpyLogger();
    const app = express();
    app.use(express.json());
    app.use(
      '/api/v1/disputes',
      createDisputesRouter({ metricsService, log: logger }),
    );

    const res = await request(app)
      .get('/api/v1/disputes')
      .set('X-Forwarded-For', '20.0.0.1');

    expect(res.status).toBe(200);

    const metricsText = await metricsService.getMetrics();
    expect(metricsText).toContain('disputes_requests_total');
    expect(metricsText).toContain('disputes_request_duration_seconds');
    expect(metricsText).toContain('error_cause="success"');

    const log = records.find((r) => r.message === 'disputes_request');
    expect(log).toBeDefined();
    expect(log!.statusCode).toBe(200);
    expect(log!.errorCause).toBe('success');
    expect(typeof log!.durationMs).toBe('number');
    expect(log!.route).toBe('/api/v1/disputes');
    // No PII / body leakage
    expect(log).not.toHaveProperty('body');
    expect(JSON.stringify(log)).not.toMatch(/@/);
  });

  it('labels client errors as 4xx_client_error', async () => {
    const register = new Registry();
    const metricsService = new MetricsService('test', register);
    const { logger, records } = createSpyLogger();
    const app = express();
    app.use(
      '/api/v1/disputes',
      createDisputesObservabilityMiddleware({ metricsService, log: logger }),
    );
    app.get('/api/v1/disputes', (_req, res) => {
      res.status(400).json({ error: { code: 'bad_request', message: 'invalid' } });
    });

    const res = await request(app).get('/api/v1/disputes');
    expect(res.status).toBe(400);

    const metricsText = await metricsService.getMetrics();
    expect(metricsText).toContain('error_cause="4xx_client_error"');
    expect(metricsText).toContain('status_code="400"');

    const log = records.find((r) => r.message === 'disputes_request');
    expect(log).toBeDefined();
    expect(log!.errorCause).toBe('4xx_client_error');
    expect(log!.statusCode).toBe(400);
  });

  it('labels server errors as 5xx_server_error via observability middleware', async () => {
    const register = new Registry();
    const metricsService = new MetricsService('test', register);
    const { logger, records } = createSpyLogger();
    const app = express();
    app.use(
      '/api/v1/disputes',
      createDisputesObservabilityMiddleware({ metricsService, log: logger }),
    );
    app.get('/api/v1/disputes', (_req, res) => {
      res.status(500).json({ error: { code: 'internal_error', message: 'boom' } });
    });

    const res = await request(app).get('/api/v1/disputes');
    expect(res.status).toBe(500);

    const metricsText = await metricsService.getMetrics();
    expect(metricsText).toContain('error_cause="5xx_server_error"');
    expect(metricsText).toContain('status_code="500"');

    const log = records.find((r) => r.message === 'disputes_request');
    expect(log).toBeDefined();
    expect(log!.errorCause).toBe('5xx_server_error');
    expect(log!.statusCode).toBe(500);
    expect(Number.isFinite(log!.durationMs as number)).toBe(true);
  });

  it('does not record metrics when no metricsService is supplied', async () => {
    const { logger, records } = createSpyLogger();
    const app = express();
    app.use(express.json());
    app.use('/api/v1/disputes', createDisputesRouter({ log: logger }));

    const res = await request(app)
      .get('/api/v1/disputes')
      .set('X-Forwarded-For', '20.0.0.3');
    expect(res.status).toBe(200);

    const log = records.find((r) => r.message === 'disputes_request');
    expect(log).toBeDefined();
    expect(log!.errorCause).toBe('success');
  });

  it('uses Express route templates (never concrete dispute IDs) in metrics', async () => {
    const register = new Registry();
    const metricsService = new MetricsService('test', register);
    const app = express();
    app.use(express.json());
    app.use(
      '/api/v1/disputes',
      createDisputesRouter({ metricsService, log: silentLogger }),
    );

    await request(app)
      .get('/api/v1/disputes/user-secret-id-999')
      .set('X-Forwarded-For', '20.0.0.4');

    const metricsText = await metricsService.getMetrics();
    expect(metricsText).toContain('/api/v1/disputes/:id');
    expect(metricsText).not.toContain('user-secret-id-999');
  });

  it('exposes disputes metrics via MetricsService.getMetrics (metrics endpoint)', async () => {
    const register = new Registry();
    const metricsService = new MetricsService('test', register);
    const app = express();
    app.use(express.json());
    app.use(
      '/api/v1/disputes',
      createDisputesRouter({ metricsService, log: silentLogger }),
    );

    await request(app)
      .post('/api/v1/disputes')
      .set('X-Forwarded-For', '20.0.0.5')
      .send({ reason: 'late payment' });

    const text = await metricsService.getMetrics();
    expect(text).toMatch(/# TYPE disputes_requests_total counter/);
    expect(text).toMatch(/# TYPE disputes_request_duration_seconds histogram/);
    expect(text).toContain('method="POST"');
    expect(text).toContain('status_code="201"');
  });

  it('accepts createDisputesRouter() with default options', async () => {
    const { setWriteRecordImpl } = require('../logger');
    setWriteRecordImpl(() => undefined);

    const app = express();
    app.use(express.json());
    app.use('/api/v1/disputes', createDisputesRouter());

    const res = await request(app)
      .get('/api/v1/disputes')
      .set('X-Forwarded-For', '20.0.0.6');
    expect(res.status).toBe(200);

    // Restore default writer
    setWriteRecordImpl((record: { level: string }) => {
      const line = JSON.stringify(record);
      if (record.level === 'error') process.stderr.write(line + '\n');
      else process.stdout.write(line + '\n');
    });
  });

  it('formats RegExp and array Express route paths without leaking IDs', async () => {
    const recordDisputesRequest = jest.fn();
    const { logger } = createSpyLogger();
    const mw = createDisputesObservabilityMiddleware({
      metricsService: { recordDisputesRequest },
      log: logger,
    });

    const finishRegex = new (require('events').EventEmitter)();
    (finishRegex as any).statusCode = 200;
    (finishRegex as any).locals = {};
    mw(
      {
        method: 'GET',
        baseUrl: '/api/v1/disputes',
        route: { path: /^\/custom$/ },
      } as any,
      finishRegex as any,
      () => undefined,
    );
    finishRegex.emit('finish');
    expect(recordDisputesRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        route: expect.stringContaining('/api/v1/disputes'),
        errorCause: 'success',
      }),
    );

    recordDisputesRequest.mockClear();
    const finishArray = new (require('events').EventEmitter)();
    (finishArray as any).statusCode = 200;
    (finishArray as any).locals = {};
    mw(
      {
        method: 'GET',
        baseUrl: 'api/v1/disputes', // missing leading slash → normalized
        route: { path: ['/:id', null] },
      } as any,
      finishArray as any,
      () => undefined,
    );
    finishArray.emit('finish');
    expect(recordDisputesRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        route: '/api/v1/disputes/:id',
      }),
    );

    recordDisputesRequest.mockClear();
    const finishEmptyArray = new (require('events').EventEmitter)();
    (finishEmptyArray as any).statusCode = 503;
    (finishEmptyArray as any).locals = {};
    mw(
      {
        method: 'GET',
        baseUrl: '',
        route: { path: [null, undefined] },
      } as any,
      finishEmptyArray as any,
      () => undefined,
    );
    finishEmptyArray.emit('finish');
    expect(recordDisputesRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        route: '/api/v1/disputes',
        errorCause: '5xx_server_error',
      }),
    );
  });

  it('uses request-scoped logger from res.locals when present', async () => {
    const { logger, records } = createSpyLogger();
    const mw = createDisputesObservabilityMiddleware({});
    const { EventEmitter } = require('events');
    const res = new EventEmitter();
    res.statusCode = 200;
    res.locals = { log: logger };
    mw(
      { method: 'DELETE', baseUrl: '/api/v1/disputes', route: { path: '/' } } as any,
      res as any,
      () => undefined,
    );
    res.emit('finish');
    expect(records.find((r) => r.message === 'disputes_request')).toBeDefined();
  });

  it('falls back to "/" when baseUrl and route path normalize empty', async () => {
    const recordDisputesRequest = jest.fn();
    const { logger } = createSpyLogger();
    const mw = createDisputesObservabilityMiddleware({
      metricsService: { recordDisputesRequest },
      log: logger,
    });
    const { EventEmitter } = require('events');
    const res = new EventEmitter();
    res.statusCode = 204;
    res.locals = {};
    mw(
      { method: 'GET', baseUrl: '/', route: { path: '/' } } as any,
      res as any,
      () => undefined,
    );
    res.emit('finish');
    expect(recordDisputesRequest).toHaveBeenCalledWith(
      expect.objectContaining({ route: '/', errorCause: 'success' }),
    );
  });

  it('covers PATCH and DELETE handlers', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/v1/disputes', createDisputesRouter({ log: silentLogger }));

    const patchRes = await request(app)
      .patch('/api/v1/disputes/d-1')
      .set('X-Forwarded-For', '21.0.0.1')
      .send({ status: 'resolved' });
    expect(patchRes.status).toBe(200);

    const deleteRes = await request(app)
      .delete('/api/v1/disputes/d-1')
      .set('X-Forwarded-For', '21.0.0.2');
    expect(deleteRes.status).toBe(200);
  });

  it('accepts createDisputesObservabilityMiddleware() with default options', async () => {
    const { setWriteRecordImpl } = require('../logger');
    setWriteRecordImpl(() => undefined);

    const app = express();
    app.use(createDisputesObservabilityMiddleware());
    app.get('/x', (_req, res) => res.status(200).end());

    const res = await request(app).get('/x');
    expect(res.status).toBe(200);

    setWriteRecordImpl((record: { level: string }) => {
      const line = JSON.stringify(record);
      if (record.level === 'error') process.stderr.write(line + '\n');
      else process.stdout.write(line + '\n');
    });
  });

  it('uses mount baseUrl when no Express route matched (e.g. early 429)', async () => {
    const recordDisputesRequest = jest.fn();
    const { logger } = createSpyLogger();
    const mw = createDisputesObservabilityMiddleware({
      metricsService: { recordDisputesRequest },
      log: logger,
    });
    const { EventEmitter } = require('events');
    const res = new EventEmitter();
    res.statusCode = 429;
    res.locals = {};
    mw(
      { method: 'GET', baseUrl: '/api/v1/disputes', route: undefined } as any,
      res as any,
      () => undefined,
    );
    res.emit('finish');
    expect(recordDisputesRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        route: '/api/v1/disputes',
        errorCause: '4xx_client_error',
        statusCode: 429,
      }),
    );
  });

  it('handles POST/PATCH with empty body via ?? fallback', async () => {
    const app = express();
    // No json parser → req.body is undefined
    app.use('/api/v1/disputes', createDisputesRouter({ log: silentLogger }));

    const postRes = await request(app)
      .post('/api/v1/disputes')
      .set('X-Forwarded-For', '21.0.0.3')
      .set('Content-Type', 'application/json');
    expect(postRes.status).toBe(201);

    const patchRes = await request(app)
      .patch('/api/v1/disputes/x')
      .set('X-Forwarded-For', '21.0.0.4')
      .set('Content-Type', 'application/json');
    expect(patchRes.status).toBe(200);
  });
});

// ── Correlation ID propagation ────────────────────────────────────────────────

describe('Disputes endpoints — correlation ID propagation', () => {
  beforeEach(() => {
    mockDisputesEnabled = true;
  });

  it('accepts X-Correlation-Id from client and echoes it in response header', async () => {
    const app = buildApp();
    const testCorrelationId = 'dispute-trace-42';
    const res = await request(app)
      .get('/api/v1/disputes')
      .set('X-Forwarded-For', '30.0.0.1')
      .set(CORRELATION_ID_HEADER, testCorrelationId);
    expect(res.status).toBe(200);
    expect(res.headers[CORRELATION_ID_HEADER]).toBe(testCorrelationId);
  });

  it('does not echo X-Correlation-Id when not provided by client', async () => {
    const app = buildApp();
    const res = await request(app)
      .get('/api/v1/disputes')
      .set('X-Forwarded-For', '30.0.0.2');
    expect(res.status).toBe(200);
    expect(res.headers[CORRELATION_ID_HEADER]).toBeUndefined();
  });

  it('includes correlationId in response body meta when provided', async () => {
    const app = buildApp();
    const testCorrelationId = 'meta-trace-99';
    const res = await request(app)
      .get('/api/v1/disputes')
      .set('X-Forwarded-For', '30.0.0.3')
      .set(CORRELATION_ID_HEADER, testCorrelationId);
    expect(res.status).toBe(200);
    expect(res.body.meta).toBeDefined();
    expect(res.body.meta.correlationId).toBe(testCorrelationId);
  });

  it('does not include correlationId in body meta when not provided', async () => {
    const app = buildApp();
    const res = await request(app)
      .get('/api/v1/disputes')
      .set('X-Forwarded-For', '30.0.0.4');
    expect(res.status).toBe(200);
    expect(res.body.meta).toBeUndefined();
  });

  it('always generates and echoes X-Request-Id header', async () => {
    const app = buildApp();
    const res = await request(app)
      .get('/api/v1/disputes')
      .set('X-Forwarded-For', '30.0.0.5');
    expect(res.status).toBe(200);
    const requestId = res.headers[REQUEST_ID_HEADER];
    expect(requestId).toBeTruthy();
    expect(requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it('reuses client-supplied X-Request-Id if valid', async () => {
    const app = buildApp();
    const clientRequestId = '550e8400-e29b-41d4-a716-446655440000';
    const res = await request(app)
      .get('/api/v1/disputes')
      .set('X-Forwarded-For', '30.0.0.6')
      .set(REQUEST_ID_HEADER, clientRequestId);
    expect(res.status).toBe(200);
    expect(res.headers[REQUEST_ID_HEADER]).toBe(clientRequestId);
  });

  it('propagates both X-Correlation-Id and X-Request-Id in response', async () => {
    const app = buildApp();
    const testCorrelationId = 'both-headers-trace';
    const res = await request(app)
      .get('/api/v1/disputes')
      .set('X-Forwarded-For', '30.0.0.7')
      .set(CORRELATION_ID_HEADER, testCorrelationId);
    expect(res.status).toBe(200);
    const requestId = res.headers[REQUEST_ID_HEADER];
    const correlationId = res.headers[CORRELATION_ID_HEADER];
    expect(requestId).toBeTruthy();
    expect(correlationId).toBe(testCorrelationId);
    expect(requestId).not.toBe(correlationId);
  });

  it('rejects invalid correlation IDs with special characters', async () => {
    const app = buildApp();
    const invalidCorrelationId = 'dispute<script>alert(1)</script>';
    const res = await request(app)
      .get('/api/v1/disputes')
      .set('X-Forwarded-For', '30.0.0.8')
      .set(CORRELATION_ID_HEADER, invalidCorrelationId);
    expect(res.status).toBe(200);
    expect(res.headers[CORRELATION_ID_HEADER]).toBeUndefined();
    expect(res.body.meta).toBeUndefined();
  });

  it('rejects correlation IDs exceeding 128 characters', async () => {
    const app = buildApp();
    const longCorrelationId = 'a'.repeat(129);
    const res = await request(app)
      .get('/api/v1/disputes')
      .set('X-Forwarded-For', '30.0.0.9')
      .set(CORRELATION_ID_HEADER, longCorrelationId);
    expect(res.status).toBe(200);
    expect(res.headers[CORRELATION_ID_HEADER]).toBeUndefined();
    expect(res.body.meta).toBeUndefined();
  });

  it('includes requestId in success response body', async () => {
    const app = buildApp();
    const res = await request(app)
      .get('/api/v1/disputes')
      .set('X-Forwarded-For', '30.0.0.10');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.requestId).toBeTruthy();
    expect(res.body.requestId).toMatch(/^[0-9a-f-]+$/);
  });

  it('includes requestId in error response body when feature disabled', async () => {
    mockDisputesEnabled = false;
    const app = buildApp();
    const res = await request(app)
      .get('/api/v1/disputes')
      .set('X-Forwarded-For', '30.0.0.11');
    expect(res.status).toBe(404);
    expect(res.body.status).toBe('error');
    expect(res.body.error.requestId).toBeTruthy();
    expect(res.body.error.requestId).toMatch(/^[0-9a-f-]+$/);
  });

  it('returns correlationId in feature-disabled error response header', async () => {
    mockDisputesEnabled = false;
    const app = buildApp();
    const testCorrelationId = 'disabled-feature-trace';
    const res = await request(app)
      .get('/api/v1/disputes')
      .set('X-Forwarded-For', '30.0.0.12')
      .set(CORRELATION_ID_HEADER, testCorrelationId);
    expect(res.status).toBe(404);
    expect(res.headers[CORRELATION_ID_HEADER]).toBe(testCorrelationId);
  });

  it('threads correlationId through GET /:id response', async () => {
    const app = buildApp();
    const testCorrelationId = 'get-by-id-trace';
    const res = await request(app)
      .get(`/api/v1/disputes/${testUuid}`)
      .set('X-Forwarded-For', '30.0.0.13')
      .set(CORRELATION_ID_HEADER, testCorrelationId);
    expect(res.status).toBe(200);
    expect(res.headers[CORRELATION_ID_HEADER]).toBe(testCorrelationId);
    expect(res.body.meta.correlationId).toBe(testCorrelationId);
  });

  it('threads correlationId through POST response', async () => {
    const app = buildApp();
    const testCorrelationId = 'post-trace';
    const res = await request(app)
      .post('/api/v1/disputes')
      .set('X-Forwarded-For', '30.0.0.14')
      .set(CORRELATION_ID_HEADER, testCorrelationId)
      .send({ contractId: testUuid, reason: 'test' });
    expect(res.status).toBe(201);
    expect(res.headers[CORRELATION_ID_HEADER]).toBe(testCorrelationId);
    expect(res.body.meta.correlationId).toBe(testCorrelationId);
  });

  it('threads correlationId through PATCH response', async () => {
    const app = buildApp();
    const testCorrelationId = 'patch-trace';
    const res = await request(app)
      .patch(`/api/v1/disputes/${testUuid}`)
      .set('X-Forwarded-For', '30.0.0.15')
      .set(CORRELATION_ID_HEADER, testCorrelationId)
      .send({ status: 'resolved' });
    expect(res.status).toBe(200);
    expect(res.headers[CORRELATION_ID_HEADER]).toBe(testCorrelationId);
    expect(res.body.meta.correlationId).toBe(testCorrelationId);
  });

  it('threads correlationId through DELETE response', async () => {
    const app = buildApp();
    const testCorrelationId = 'delete-trace';
    const res = await request(app)
      .delete(`/api/v1/disputes/${testUuid}`)
      .set('X-Forwarded-For', '30.0.0.16')
      .set(CORRELATION_ID_HEADER, testCorrelationId);
    expect(res.status).toBe(200);
    expect(res.headers[CORRELATION_ID_HEADER]).toBe(testCorrelationId);
    expect(res.body.meta.correlationId).toBe(testCorrelationId);
  });

  it('uses standard success envelope format on GET /', async () => {
    const app = buildApp();
    const res = await request(app)
      .get('/api/v1/disputes')
      .set('X-Forwarded-For', '30.0.0.17');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'success',
      data: { disputes: [], total: 0 },
    });
    expect(res.body.requestId).toBeTruthy();
  });

  it('uses standard success envelope format on POST', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/v1/disputes')
      .set('X-Forwarded-For', '30.0.0.18')
      .send({ contractId: testUuid, reason: 'test dispute' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      status: 'success',
      data: {
        dispute: expect.objectContaining({
          status: 'open',
          contractId: testUuid,
          reason: 'test dispute',
        }),
      },
    });
    expect(res.body.requestId).toBeTruthy();
  });

  it('uses standard success envelope format on GET /:id', async () => {
    const app = buildApp();
    const res = await request(app)
      .get(`/api/v1/disputes/${testUuid}`)
      .set('X-Forwarded-For', '30.0.0.19');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'success',
      data: {
        dispute: { id: testUuid, status: 'open' },
      },
    });
    expect(res.body.requestId).toBeTruthy();
  });

  it('uses standard success envelope format on PATCH', async () => {
    const app = buildApp();
    const res = await request(app)
      .patch(`/api/v1/disputes/${testUuid}`)
      .set('X-Forwarded-For', '30.0.0.20')
      .send({ status: 'resolved' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'success',
      data: {
        dispute: { id: testUuid, status: 'resolved' },
      },
    });
    expect(res.body.requestId).toBeTruthy();
  });

  it('uses standard success envelope format on DELETE', async () => {
    const app = buildApp();
    const res = await request(app)
      .delete(`/api/v1/disputes/${testUuid}`)
      .set('X-Forwarded-For', '30.0.0.21');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'success',
      data: { message: `Dispute ${testUuid} deleted successfully` },
    });
    expect(res.body.requestId).toBeTruthy();
  });

  it('uses standard error envelope format when feature disabled', async () => {
    mockDisputesEnabled = false;
    const app = buildApp();
    const res = await request(app)
      .get('/api/v1/disputes')
      .set('X-Forwarded-For', '30.0.0.22');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({
      status: 'error',
      error: {
        code: 'feature_disabled',
        message: 'Disputes feature is currently disabled.',
      },
    });
    expect(res.body.error.requestId).toBeTruthy();
  });
});

// ── Logging with correlation context ──────────────────────────────────────────

describe('Disputes endpoints — logging with correlation context', () => {
  beforeEach(() => {
    mockDisputesEnabled = true;
  });

  afterEach(() => {
    // Ensure the default write implementation is always restored
    setWriteRecordImpl((record: Record<string, unknown>) => {
      const line = JSON.stringify(record);
      if (record.level === 'error') {
        process.stderr.write(line + '\n');
      } else {
        process.stdout.write(line + '\n');
      }
    });
  });

  it('logs with requestId on GET /', async () => {
    const { records, restore } = captureLogs();
    try {
      const app = buildApp();
      await request(app)
        .get('/api/v1/disputes')
        .set('X-Forwarded-For', '40.0.0.1');

      const disputeLogs = records.filter(r => r.message === 'Listing disputes');
      expect(disputeLogs.length).toBeGreaterThanOrEqual(1);
      expect(disputeLogs[0].requestId).toBeTruthy();
      expect(disputeLogs[0].service).toBe('talenttrust-backend');
    } finally {
      restore();
    }
  });

  it('logs with correlationId on GET / when X-Correlation-Id is provided', async () => {
    const { records, restore } = captureLogs();
    try {
      const app = buildApp();
      const testCorrelationId = 'log-correlation-42';
      await request(app)
        .get('/api/v1/disputes')
        .set('X-Forwarded-For', '40.0.0.2')
        .set(CORRELATION_ID_HEADER, testCorrelationId);

      const disputeLogs = records.filter(r => r.message === 'Listing disputes');
      expect(disputeLogs.length).toBeGreaterThanOrEqual(1);
      expect(disputeLogs[0].requestId).toBeTruthy();
      expect(disputeLogs[0].correlationId).toBe(testCorrelationId);
    } finally {
      restore();
    }
  });

  it('logs with correlationId on GET /:id', async () => {
    const { records, restore } = captureLogs();
    try {
      const app = buildApp();
      await request(app)
        .get(`/api/v1/disputes/${testUuid}`)
        .set('X-Forwarded-For', '40.0.0.3');

      const disputeLogs = records.filter(r => r.message === 'Getting dispute');
      expect(disputeLogs.length).toBeGreaterThanOrEqual(1);
      expect(disputeLogs[0].requestId).toBeTruthy();
      expect(disputeLogs[0].disputeId).toBe(testUuid);
    } finally {
      restore();
    }
  });

  it('logs on POST /', async () => {
    const { records, restore } = captureLogs();
    try {
      const app = buildApp();
      await request(app)
        .post('/api/v1/disputes')
        .set('X-Forwarded-For', '40.0.0.4')
        .send({ contractId: testUuid, reason: 'test dispute' });

      const disputeLogs = records.filter(r => r.message === 'Creating dispute');
      expect(disputeLogs.length).toBeGreaterThanOrEqual(1);
      expect(disputeLogs[0].requestId).toBeTruthy();
      expect(disputeLogs[0].disputeId).toBeTruthy();
    } finally {
      restore();
    }
  });

  it('logs on PATCH /:id', async () => {
    const { records, restore } = captureLogs();
    try {
      const app = buildApp();
      await request(app)
        .patch(`/api/v1/disputes/${testUuid}`)
        .set('X-Forwarded-For', '40.0.0.5')
        .send({ status: 'resolved' });

      const disputeLogs = records.filter(r => r.message === 'Updating dispute');
      expect(disputeLogs.length).toBeGreaterThanOrEqual(1);
      expect(disputeLogs[0].requestId).toBeTruthy();
      expect(disputeLogs[0].disputeId).toBe(testUuid);
    } finally {
      restore();
    }
  });

  it('logs on DELETE /:id', async () => {
    const { records, restore } = captureLogs();
    try {
      const app = buildApp();
      await request(app)
        .delete(`/api/v1/disputes/${testUuid}`)
        .set('X-Forwarded-For', '40.0.0.6');

      const disputeLogs = records.filter(r => r.message === 'Deleting dispute');
      expect(disputeLogs.length).toBeGreaterThanOrEqual(1);
      expect(disputeLogs[0].requestId).toBeTruthy();
      expect(disputeLogs[0].disputeId).toBe(testUuid);
    } finally {
      restore();
    }
  });

  it('does not log when feature is disabled (feature flag short-circuits)', async () => {
    const { records, restore } = captureLogs();
    try {
      mockDisputesEnabled = false;
      const app = buildApp();
      await request(app)
        .get('/api/v1/disputes')
        .set('X-Forwarded-For', '40.0.0.7');

      const disputeLogs = records.filter(
        r => r.message && (r.message as string).startsWith('Listing'),
      );
      expect(disputeLogs.length).toBe(0);
    } finally {
      restore();
    }
  });
});
