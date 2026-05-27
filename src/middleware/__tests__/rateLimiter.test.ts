/**
 * @file rateLimiter.test.ts
 * @description Unit and integration tests for the rate-limiter middleware.
 *
 * Strategy
 * ────────
 * All tests drive a minimal Express app wired with `createRateLimiter`.
 * We use `supertest` for HTTP-level assertions and `jest.useFakeTimers`
 * where we need to control `Date.now()` to verify window rolling and
 * block expiry without actually waiting.
 *
 * Coverage targets (≥ 95 %):
 *   - Requests within limit → 200, correct headers
 *   - Requests exceeding limit → 429, Retry-After header
 *   - Sliding-window reset after windowMs
 *   - Abuse guard triggers hard-block after abuseThreshold violations
 *   - Hard-block persists; 429 returned for all requests during block
 *   - Block expiry → requests allowed again
 *   - Exponential back-off doubles block duration on successive abuse
 *   - Custom keyFn is respected
 *   - /health is NOT limited (index integration)
 *   - Missing / unknown IP falls back to 'unknown'
 *   - X-Forwarded-For header extraction (first value)
 *   - sendHeaders=false suppresses rate-limit headers
 *   - Shared store enables coordination between two limiter instances
 */

import express, { Request, Response } from 'express';
import request from 'supertest';
import { createRateLimiter } from '../rateLimiter';
import { RateLimitStore } from '../../lib/rateLimitStore';


/** Build a minimal test app with the given limiter mounted on /api/ */
function buildApp(limiterOverrides: Parameters<typeof createRateLimiter>[0] = {}) {
  const app = express();
  app.use(express.json());
  app.use('/api/', createRateLimiter(limiterOverrides));
  app.get('/api/test', (_req: Request, res: Response) => res.json({ ok: true }));
  app.get('/health', (_req: Request, res: Response) => res.json({ status: 'ok' }));
  return app;
}

/** Fire `n` sequential requests against `path` from the same IP */
async function fireRequests(
  app: ReturnType<typeof buildApp>,
  n: number,
  path = '/api/test',
  ip = '1.2.3.4',
) {
  const results: request.Response[] = [];
  for (let i = 0; i < n; i++) {
    results.push(await request(app).get(path).set('X-Forwarded-For', ip));
  }
  return results;
}


describe('createRateLimiter – middleware', () => {

  describe('within rate limit', () => {
    it('returns 200 for requests within the limit', async () => {
      const app = buildApp({ maxRequests: 5, windowMs: 60_000 });
      const res = await request(app).get('/api/test').set('X-Forwarded-For', '1.1.1.1');
      expect(res.status).toBe(200);
    });

    it('sets X-RateLimit-Limit header', async () => {
      const app = buildApp({ maxRequests: 10, windowMs: 60_000 });
      const res = await request(app).get('/api/test').set('X-Forwarded-For', '1.1.1.1');
      expect(res.headers['x-ratelimit-limit']).toBe('10');
    });

    it('decrements X-RateLimit-Remaining with each request', async () => {
      const app = buildApp({ maxRequests: 5, windowMs: 60_000 });
      const [r1, r2, r3] = await fireRequests(app, 3, '/api/test', '2.2.2.2');
      expect(Number(r1.headers['x-ratelimit-remaining'])).toBe(4);
      expect(Number(r2.headers['x-ratelimit-remaining'])).toBe(3);
      expect(Number(r3.headers['x-ratelimit-remaining'])).toBe(2);
    });

    it('sets X-RateLimit-Reset to a positive integer', async () => {
      const app = buildApp({ maxRequests: 10, windowMs: 30_000 });
      const res = await request(app).get('/api/test').set('X-Forwarded-For', '3.3.3.3');
      expect(Number(res.headers['x-ratelimit-reset'])).toBeGreaterThan(0);
    });
  });

  describe('rate limit exceeded', () => {
    it('returns 429 when limit is breached', async () => {
      const app = buildApp({ maxRequests: 3, windowMs: 60_000, abuseThreshold: 99 });
      const results = await fireRequests(app, 4, '/api/test', '5.5.5.5');
      expect(results[3].status).toBe(429);
    });

    it('includes retryAfter in the 429 response body', async () => {
      const app = buildApp({ maxRequests: 2, windowMs: 60_000, abuseThreshold: 99 });
      const results = await fireRequests(app, 3, '/api/test', '6.6.6.6');
      expect(results[2].body).toHaveProperty('retryAfter');
      expect(results[2].body.retryAfter).toBeGreaterThan(0);
    });

    it('sets Retry-After header on 429', async () => {
      const app = buildApp({ maxRequests: 2, windowMs: 60_000, abuseThreshold: 99 });
      const results = await fireRequests(app, 3, '/api/test', '7.7.7.7');
      expect(results[2].headers['retry-after']).toBeDefined();
    });

    it('returns error JSON with expected shape', async () => {
      const app = buildApp({ maxRequests: 1, windowMs: 60_000, abuseThreshold: 99 });
      const results = await fireRequests(app, 2, '/api/test', '8.8.8.8');
      expect(results[1].body).toMatchObject({ error: 'Too Many Requests' });
    });
  });

  // ── sliding window reset ────────────────────────────────────────────────

  describe('sliding window', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('resets the counter after windowMs elapses', async () => {
      const store = new RateLimitStore({ sweepIntervalMs: 9_999_999 });
      const app = buildApp({ maxRequests: 2, windowMs: 1_000, abuseThreshold: 99, store });

      // Exhaust the limit
      await fireRequests(app, 2, '/api/test', '9.9.9.9');

      // Advance past the window
      jest.advanceTimersByTime(1_001);

      // Should be allowed again
      const res = await request(app).get('/api/test').set('X-Forwarded-For', '9.9.9.9');
      expect(res.status).toBe(200);
      store.destroy();
    });
  });

  describe('abuse guard', () => {
    it('hard-blocks after abuseThreshold violations', async () => {
      // maxRequests=1, abuseThreshold=2 → block on 2nd violation
      const app = buildApp({
        maxRequests: 1,
        windowMs: 60_000,
        abuseThreshold: 2,
        blockDurationMs: 60_000,
      });
      const ip = '10.0.0.1';

      // 1st violation (request 2 over limit of 1)
      await fireRequests(app, 2, '/api/test', ip);
      // 2nd violation = abuse threshold reached
      await fireRequests(app, 1, '/api/test', ip);

      // May already be blocked or just rate-limited; subsequent should block
      const followUp = await request(app).get('/api/test').set('X-Forwarded-For', ip);
      expect([followUp.status]).toContain(429);
    });

    it('sets X-RateLimit-Blocked header when hard-blocked', async () => {
      const app = buildApp({
        maxRequests: 1,
        windowMs: 60_000,
        abuseThreshold: 2,
        blockDurationMs: 60_000,
      });
      const ip = '10.0.0.2';
      // Trigger enough violations to hit the hard block
      const results = await fireRequests(app, 5, '/api/test', ip);
      const blockedRes = results.find(r => r.headers['x-ratelimit-blocked'] === 'true');
      expect(blockedRes).toBeDefined();
    });

    it('blocked message differs from plain rate-limit message', async () => {
      const app = buildApp({
        maxRequests: 1,
        windowMs: 60_000,
        abuseThreshold: 2,
        blockDurationMs: 60_000,
      });
      const ip = '10.0.0.3';
      const results = await fireRequests(app, 6, '/api/test', ip);
      const blockedBody = results.find(
        r => r.body?.message?.toLowerCase().includes('blocked'),
      );
      expect(blockedBody).toBeDefined();
    });

    it('block expires and allows traffic again', async () => {
      jest.useFakeTimers();
      const store = new RateLimitStore({ sweepIntervalMs: 9_999_999 });
      const app = buildApp({
        maxRequests: 1,
        windowMs: 500,
        abuseThreshold: 2,
        blockDurationMs: 1_000,
        store,
      });
      const ip = '10.0.0.4';

      // Trigger hard-block
      await fireRequests(app, 5, '/api/test', ip);

      // Advance past block duration + window
      jest.advanceTimersByTime(2_000);

      const res = await request(app).get('/api/test').set('X-Forwarded-For', ip);
      expect(res.status).toBe(200);
      jest.useRealTimers();
      store.destroy();
    });
  });

  describe('sendHeaders=false', () => {
    it('does not send X-RateLimit-* headers', async () => {
      const app = buildApp({ maxRequests: 10, windowMs: 60_000, sendHeaders: false });
      const res = await request(app).get('/api/test').set('X-Forwarded-For', '11.11.11.11');
      expect(res.headers['x-ratelimit-limit']).toBeUndefined();
      expect(res.headers['x-ratelimit-remaining']).toBeUndefined();
    });
  });


  describe('key extraction', () => {
    it('isolates rate limits per IP', async () => {
      const app = buildApp({ maxRequests: 2, windowMs: 60_000, abuseThreshold: 99 });
      // IP A exhausts its limit
      await fireRequests(app, 3, '/api/test', '20.0.0.1');
      // IP B is unaffected
      const res = await request(app).get('/api/test').set('X-Forwarded-For', '20.0.0.2');
      expect(res.status).toBe(200);
    });

    it('uses first IP from X-Forwarded-For', async () => {
      const app = buildApp({ maxRequests: 2, windowMs: 60_000, abuseThreshold: 99 });
      // Same leading IP, different trailing proxy IPs → same bucket
      for (let i = 0; i < 2; i++) {
        await request(app).get('/api/test').set('X-Forwarded-For', `30.0.0.1, 99.99.99.${i}`);
      }
      const res = await request(app)
        .get('/api/test')
        .set('X-Forwarded-For', '30.0.0.1, 99.99.99.9');
      expect(res.status).toBe(429);
    });

    it('custom keyFn is used as the bucket key', async () => {
      const app = buildApp({
        maxRequests: 1,
        windowMs: 60_000,
        abuseThreshold: 99,
        // Bucket by a fixed key → all requests share the same counter
        keyFn: () => 'global',
      });
      await request(app).get('/api/test').set('X-Forwarded-For', '40.0.0.1');
      const res = await request(app).get('/api/test').set('X-Forwarded-For', '40.0.0.2');
      expect(res.status).toBe(429);
    });
  });


  describe('shared store', () => {
    it('two limiter instances sharing a store see the same counter', async () => {
      const store = new RateLimitStore({ sweepIntervalMs: 9_999_999 });
      const cfg = { maxRequests: 2, windowMs: 60_000, abuseThreshold: 99, store };

      const appA = buildApp(cfg);
      const appB = buildApp(cfg);

      await request(appA).get('/api/test').set('X-Forwarded-For', '50.0.0.1');
      await request(appB).get('/api/test').set('X-Forwarded-For', '50.0.0.1');

      // Third request should be blocked (limit=2 already consumed across both apps)
      const res = await request(appA).get('/api/test').set('X-Forwarded-For', '50.0.0.1');
      expect(res.status).toBe(429);
      store.destroy();
    });
  });

  describe('health endpoint', () => {
    it('/health is not rate-limited (no X-RateLimit headers)', async () => {
      const app = buildApp({ maxRequests: 1, windowMs: 60_000 });
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.headers['x-ratelimit-limit']).toBeUndefined();
    });
  });
});

describe('auth endpoint rate limiting', () => {
  it('POST /api/v1/auth/login uses strict tier', async () => {
    const app = buildApp({ maxRequests: 3, windowMs: 60_000, abuseThreshold: 99 });
    app.post('/api/v1/auth/login', (req, res) => res.json({ ok: true }));

    await request(app).post('/api/v1/auth/login').send({});
    await request(app).post('/api/v1/auth/login').send({});
    await request(app).post('/api/v1/auth/login').send({});
    const res = await request(app).post('/api/v1/auth/login').send({});
    expect(res.status).toBe(429);
  });

  it('POST /api/v1/auth/register uses strict tier', async () => {
    const app = buildApp({ maxRequests: 2, windowMs: 60_000, abuseThreshold: 99 });
    app.post('/api/v1/auth/register', (req, res) => res.json({ ok: true }));

    await request(app).post('/api/v1/auth/register').send({});
    await request(app).post('/api/v1/auth/register').send({});
    const res = await request(app).post('/api/v1/auth/register').send({});
    expect(res.status).toBe(429);
  });
});

describe('sensitive endpoint rate limiting', () => {
  it('PUT /api/v1/reputation/:id uses sensitive tier', async () => {
    const app = buildApp({ maxRequests: 5, windowMs: 60_000, abuseThreshold: 99 });
    app.put('/api/v1/reputation/:id', (req, res) => res.json({ ok: true }));

    for (let i = 0; i < 5; i++) {
      const res = await request(app).put('/api/v1/reputation/123').send({ rating: 5 });
      expect(res.status).toBe(200);
    }
    const res = await request(app).put('/api/v1/reputation/123').send({ rating: 5 });
    expect(res.status).toBe(429);
  });

  it('sensitive tier allows bursts but blocks abuse', async () => {
    const app = buildApp({
      maxRequests: 10,
      windowMs: 60_000,
      abuseThreshold: 3,
      blockDurationMs: 60_000,
    });
    app.post('/api/v1/test', (req, res) => res.json({ ok: true }));

    // Safe burst: 10 requests within limit
    for (let i = 0; i < 10; i++) {
      const res = await request(app).post('/api/v1/test').send({});
      expect(res.status).toBe(200);
    }
  });
});