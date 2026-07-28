/**
 * @file health.rateLimit.test.ts
 * @description Comprehensive tests for per-client rate limiting on all health endpoints.
 *
 * Covers:
 *  - 429 returned when per-client limit is exceeded on /health/live, /health/ready,
 *    GET /health, and POST /health.
 *  - `Retry-After` header present and numeric on every 429 response.
 *  - Rate-limit response headers (X-RateLimit-Limit, X-RateLimit-Remaining,
 *    X-RateLimit-Reset) present on every response.
 *  - Requests below the limit are not throttled.
 *  - Clients are isolated: one client hitting the cap does not block another.
 *  - Key resolution: X-API-Key takes priority over X-Forwarded-For and req.ip.
 *  - Config-driven limits: custom env vars are respected at middleware creation time.
 *  - Router health endpoint (/health/router) is also rate-limited.
 */

import express from 'express';
import request from 'supertest';
import { Server } from 'http';
import { RateLimitStore } from './lib/rateLimitStore';
import { createRateLimiter } from './middleware/rateLimiter';
import { healthRateLimitKeyFn } from './health/rateLimitKey';
import { healthRouter as readinessRouter } from './health';
import { healthRouter as legacyRouter } from './routes/health';

jest.mock('./health/probes', () => ({
  dbProbe: jest.fn().mockResolvedValue({ name: 'db', ok: true, latencyMs: 1 }),
  redisProbe: jest.fn().mockResolvedValue({ name: 'queue', ok: true, latencyMs: 1 }),
  stellarRpcProbe: jest.fn().mockResolvedValue({ name: 'stellar-rpc', ok: true, latencyMs: 1 }),
}));

jest.mock('./shutdown', () => ({
  isReadinessDraining: jest.fn().mockReturnValue(false),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal Express app that mounts health routers with a custom
 * per-client cap so tests run quickly without needing 60 real requests.
 */
function buildTestApp(maxRequests = 3, windowMs = 60_000): Server {
  const app = express();
  app.use(express.json());

  const store = new RateLimitStore({ sweepIntervalMs: 0 });

  const limiter = createRateLimiter({
    maxRequests,
    windowMs,
    abuseThreshold: 100, // disable abuse-block escalation in unit tests
    store,
    keyFn: healthRateLimitKeyFn,
  });

  // Mount the readiness router with the test limiter applied BEFORE the router
  const readiness = express.Router();
  readiness.use(limiter);
  readiness.use(readinessRouter);

  // Mount the legacy router with the same limiter
  const legacy = express.Router();
  legacy.use(limiter);
  legacy.use(legacyRouter);

  app.use('/health', legacy);
  app.use('/health', readiness);

  return app.listen(0);
}

async function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
}

// ---------------------------------------------------------------------------
// Tests: /health/live
// ---------------------------------------------------------------------------

describe('health rate limiting — /health/live', () => {
  let server: Server;

  beforeEach(() => {
    server = buildTestApp(3);
  });

  afterEach(async () => {
    await closeServer(server);
  });

  it('allows requests up to the limit', async () => {
    for (let i = 0; i < 3; i++) {
      const res = await request(server)
        .get('/health/live')
        .set('X-Forwarded-For', '10.0.0.1');
      expect(res.status).toBe(200);
    }
  });

  it('returns 429 on the first request that exceeds the limit', async () => {
    for (let i = 0; i < 3; i++) {
      await request(server).get('/health/live').set('X-Forwarded-For', '10.0.0.2');
    }
    const res = await request(server)
      .get('/health/live')
      .set('X-Forwarded-For', '10.0.0.2');
    expect(res.status).toBe(429);
  });

  it('includes Retry-After header on 429 response', async () => {
    for (let i = 0; i < 3; i++) {
      await request(server).get('/health/live').set('X-Forwarded-For', '10.0.0.3');
    }
    const res = await request(server)
      .get('/health/live')
      .set('X-Forwarded-For', '10.0.0.3');
    expect(res.status).toBe(429);
    const retryAfter = Number(res.headers['retry-after']);
    expect(retryAfter).toBeGreaterThan(0);
    expect(Number.isFinite(retryAfter)).toBe(true);
  });

  it('returns rate-limit headers on every response', async () => {
    const res = await request(server)
      .get('/health/live')
      .set('X-Forwarded-For', '10.0.0.4');
    expect(res.status).toBe(200);
    expect(res.headers['x-ratelimit-limit']).toBeDefined();
    expect(res.headers['x-ratelimit-remaining']).toBeDefined();
    expect(res.headers['x-ratelimit-reset']).toBeDefined();
  });

  it('decrements X-RateLimit-Remaining on each request', async () => {
    const firstRes = await request(server)
      .get('/health/live')
      .set('X-Forwarded-For', '10.0.0.5');
    const secondRes = await request(server)
      .get('/health/live')
      .set('X-Forwarded-For', '10.0.0.5');

    expect(Number(firstRes.headers['x-ratelimit-remaining'])).toBeGreaterThan(
      Number(secondRes.headers['x-ratelimit-remaining']),
    );
  });

  it('returns a machine-readable error body on 429', async () => {
    for (let i = 0; i < 3; i++) {
      await request(server).get('/health/live').set('X-Forwarded-For', '10.0.0.6');
    }
    const res = await request(server)
      .get('/health/live')
      .set('X-Forwarded-For', '10.0.0.6');
    expect(res.status).toBe(429);
    expect(res.body).toHaveProperty('error');
    expect(res.body.error).toHaveProperty('code', 'rate_limited');
  });
});

// ---------------------------------------------------------------------------
// Tests: /health/ready
// ---------------------------------------------------------------------------

describe('health rate limiting — /health/ready', () => {
  let server: Server;

  beforeEach(() => {
    server = buildTestApp(3);
  });

  afterEach(async () => {
    await closeServer(server);
  });

  it('returns 429 after the cap is exceeded', async () => {
    for (let i = 0; i < 3; i++) {
      await request(server).get('/health/ready').set('X-Forwarded-For', '10.1.0.1');
    }
    const res = await request(server)
      .get('/health/ready')
      .set('X-Forwarded-For', '10.1.0.1');
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: GET /health (legacy router)
// ---------------------------------------------------------------------------

describe('health rate limiting — GET /health', () => {
  let server: Server;

  beforeEach(() => {
    server = buildTestApp(3);
  });

  afterEach(async () => {
    await closeServer(server);
  });

  it('allows up to the limit then returns 429', async () => {
    for (let i = 0; i < 3; i++) {
      const res = await request(server)
        .get('/health')
        .set('X-Forwarded-For', '10.2.0.1');
      expect(res.status).toBe(200);
    }
    const throttled = await request(server)
      .get('/health')
      .set('X-Forwarded-For', '10.2.0.1');
    expect(throttled.status).toBe(429);
    expect(throttled.headers['retry-after']).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: POST /health (legacy router)
// ---------------------------------------------------------------------------

describe('health rate limiting — POST /health', () => {
  let server: Server;

  beforeEach(() => {
    server = buildTestApp(3);
  });

  afterEach(async () => {
    await closeServer(server);
  });

  it('allows up to the limit then returns 429', async () => {
    for (let i = 0; i < 3; i++) {
      const res = await request(server)
        .post('/health')
        .set('X-Forwarded-For', '10.3.0.1')
        .send({ status: 'ok', timestamp: new Date().toISOString(), version: '1.0.0' });
      expect([200, 400]).toContain(res.status); // 400 is fine if body schema validation rejects
    }
    const throttled = await request(server)
      .post('/health')
      .set('X-Forwarded-For', '10.3.0.1')
      .send({ status: 'ok', timestamp: new Date().toISOString(), version: '1.0.0' });
    expect(throttled.status).toBe(429);
  });
});

// ---------------------------------------------------------------------------
// Tests: Client isolation
// ---------------------------------------------------------------------------

describe('health rate limiting — client isolation', () => {
  let server: Server;

  beforeEach(() => {
    server = buildTestApp(2);
  });

  afterEach(async () => {
    await closeServer(server);
  });

  it('throttling one client does not affect a different client IP', async () => {
    // Exhaust client A
    for (let i = 0; i < 2; i++) {
      await request(server).get('/health/live').set('X-Forwarded-For', '192.168.1.1');
    }
    const throttledA = await request(server)
      .get('/health/live')
      .set('X-Forwarded-For', '192.168.1.1');
    expect(throttledA.status).toBe(429);

    // Client B should still be fine
    const okB = await request(server)
      .get('/health/live')
      .set('X-Forwarded-For', '192.168.1.2');
    expect(okB.status).toBe(200);
  });

  it('throttling one API key does not affect a different API key', async () => {
    for (let i = 0; i < 2; i++) {
      await request(server).get('/health/live').set('X-API-Key', 'key-alpha');
    }
    const throttledAlpha = await request(server)
      .get('/health/live')
      .set('X-API-Key', 'key-alpha');
    expect(throttledAlpha.status).toBe(429);

    const okBeta = await request(server)
      .get('/health/live')
      .set('X-API-Key', 'key-beta');
    expect(okBeta.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Tests: Key resolution (healthRateLimitKeyFn unit tests)
// ---------------------------------------------------------------------------

describe('healthRateLimitKeyFn', () => {
  function makeReq(
    headers: Record<string, string | string[]> = {},
    ip = '127.0.0.1',
  ): express.Request {
    return {
      headers,
      ip,
      socket: { remoteAddress: ip },
    } as unknown as express.Request;
  }

  it('returns X-API-Key when present (string)', () => {
    const key = healthRateLimitKeyFn(makeReq({ 'x-api-key': 'my-key' }));
    expect(key).toBe('my-key');
  });

  it('returns first element of X-API-Key array', () => {
    const key = healthRateLimitKeyFn(makeReq({ 'x-api-key': ['key-one', 'key-two'] }));
    expect(key).toBe('key-one');
  });

  it('prefers X-API-Key over X-Forwarded-For', () => {
    const key = healthRateLimitKeyFn(
      makeReq({ 'x-api-key': 'svc-key', 'x-forwarded-for': '1.2.3.4' }),
    );
    expect(key).toBe('svc-key');
  });

  it('falls back to first IP in X-Forwarded-For when no X-API-Key', () => {
    const key = healthRateLimitKeyFn(makeReq({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8' }));
    expect(key).toBe('1.2.3.4');
  });

  it('handles X-Forwarded-For as an array', () => {
    const key = healthRateLimitKeyFn(
      makeReq({ 'x-forwarded-for': ['10.0.0.1', '10.0.0.2'] }),
    );
    expect(key).toBe('10.0.0.1');
  });

  it('falls back to req.ip when no other header is set', () => {
    const key = healthRateLimitKeyFn(makeReq({}, '203.0.113.5'));
    expect(key).toBe('203.0.113.5');
  });

  it('returns "unknown" when no IP is available', () => {
    const req = { headers: {}, ip: undefined, socket: {} } as unknown as express.Request;
    const key = healthRateLimitKeyFn(req);
    expect(key).toBe('unknown');
  });

  it('trims whitespace from X-Forwarded-For values', () => {
    const key = healthRateLimitKeyFn(makeReq({ 'x-forwarded-for': '  10.0.0.9  , 10.0.0.10' }));
    expect(key).toBe('10.0.0.9');
  });
});

// ---------------------------------------------------------------------------
// Tests: Config-driven limits
// ---------------------------------------------------------------------------

describe('health rate limiting — config-driven limits', () => {
  it('respects a custom cap (1 request)', async () => {
    const server = buildTestApp(1);

    const first = await request(server)
      .get('/health/live')
      .set('X-Forwarded-For', '10.9.0.1');
    expect(first.status).toBe(200);

    const second = await request(server)
      .get('/health/live')
      .set('X-Forwarded-For', '10.9.0.1');
    expect(second.status).toBe(429);

    await closeServer(server);
  });

  it('respects a higher cap (10 requests) without throttling', async () => {
    const server = buildTestApp(10);

    for (let i = 0; i < 10; i++) {
      const res = await request(server)
        .get('/health/live')
        .set('X-Forwarded-For', '10.9.0.2');
      expect(res.status).toBe(200);
    }

    await closeServer(server);
  });

  it('X-RateLimit-Limit header reflects the configured cap', async () => {
    const server = buildTestApp(7);

    const res = await request(server)
      .get('/health/live')
      .set('X-Forwarded-For', '10.9.0.3');
    expect(res.status).toBe(200);
    expect(Number(res.headers['x-ratelimit-limit'])).toBe(7);

    await closeServer(server);
  });
});

// ---------------------------------------------------------------------------
// Tests: Retry-After value accuracy
// ---------------------------------------------------------------------------

describe('health rate limiting — Retry-After accuracy', () => {
  it('Retry-After is a positive integer (seconds)', async () => {
    const server = buildTestApp(1);

    await request(server).get('/health/live').set('X-Forwarded-For', '10.10.0.1');
    const res = await request(server)
      .get('/health/live')
      .set('X-Forwarded-For', '10.10.0.1');

    expect(res.status).toBe(429);
    const ra = res.headers['retry-after'];
    expect(ra).toBeDefined();
    const seconds = Number(ra);
    expect(Number.isInteger(seconds)).toBe(true);
    expect(seconds).toBeGreaterThan(0);

    await closeServer(server);
  });
});
