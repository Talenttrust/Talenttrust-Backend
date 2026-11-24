import request from 'supertest';
import { createApp } from '../src/app';
import { EscrowStore } from '../src/store';
import { RateLimiter, createRateLimiterFromEnv } from '../src/rateLimit';

// ---------------------------------------------------------------------------
// Unit tests: RateLimiter class
// ---------------------------------------------------------------------------

describe('RateLimiter unit', () => {
  it('allows requests up to the limit and blocks the next one', () => {
    let t = 0;
    const limiter = new RateLimiter({ limits: { default: 3, auth: 3, tx: 3, chain: 3 }, windowMs: 60_000, now: () => t });

    for (let i = 0; i < 3; i++) {
      expect(limiter.check('default', 'ip1').allowed).toBe(true);
    }
    const blocked = limiter.check('default', 'ip1');
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfter).toBeGreaterThan(0);
  });

  it('resets the window after windowMs', () => {
    let t = 0;
    const limiter = new RateLimiter({ limits: { default: 2, auth: 2, tx: 2, chain: 2 }, windowMs: 1000, now: () => t });

    expect(limiter.check('default', 'ip1').allowed).toBe(true);
    expect(limiter.check('default', 'ip1').allowed).toBe(true);
    expect(limiter.check('default', 'ip1').allowed).toBe(false);

    // Advance past the window
    t = 1001;
    expect(limiter.check('default', 'ip1').allowed).toBe(true);
  });

  it('tracks different clients independently', () => {
    const limiter = new RateLimiter({ limits: { default: 1, auth: 1, tx: 1, chain: 1 }, windowMs: 60_000 });
    expect(limiter.check('default', 'ipA').allowed).toBe(true);
    expect(limiter.check('default', 'ipA').allowed).toBe(false);
    // ipB still has its full budget
    expect(limiter.check('default', 'ipB').allowed).toBe(true);
  });

  it('tracks different policies independently', () => {
    const limiter = new RateLimiter({ limits: { default: 1, auth: 5, tx: 5, chain: 5 }, windowMs: 60_000 });
    expect(limiter.check('default', 'ip1').allowed).toBe(true);
    expect(limiter.check('default', 'ip1').allowed).toBe(false);
    // auth policy still has budget for the same IP
    expect(limiter.check('auth', 'ip1').allowed).toBe(true);
  });

  it('unlimited when limit is 0', () => {
    const limiter = new RateLimiter({ limits: { default: 0, auth: 0, tx: 0, chain: 0 }, windowMs: 60_000 });
    for (let i = 0; i < 200; i++) {
      expect(limiter.check('default', 'ip1').allowed).toBe(true);
    }
  });

  it('disabled: all checks pass regardless of counts', () => {
    const limiter = new RateLimiter({ enabled: false, limits: { default: 1, auth: 1, tx: 1, chain: 1 }, windowMs: 60_000 });
    for (let i = 0; i < 100; i++) {
      expect(limiter.check('default', 'ip1').allowed).toBe(true);
    }
  });

  it('bounds client map size and evicts the oldest key', () => {
    const limiter = new RateLimiter({ limits: { default: 100, auth: 100, tx: 100, chain: 100 }, windowMs: 60_000, maxClients: 3 });
    limiter.check('default', 'a');
    limiter.check('default', 'b');
    limiter.check('default', 'c');
    expect(limiter.clientCount('default')).toBe(3);
    // Adding a 4th evicts 'a'
    limiter.check('default', 'd');
    expect(limiter.clientCount('default')).toBe(3);
  });

  it('evictStale removes expired buckets', () => {
    let t = 0;
    const limiter = new RateLimiter({ limits: { default: 5, auth: 5, tx: 5, chain: 5 }, windowMs: 1000, now: () => t });
    limiter.check('default', 'x');
    limiter.check('default', 'y');
    expect(limiter.clientCount('default')).toBe(2);
    t = 2000;
    limiter.evictStale();
    expect(limiter.clientCount('default')).toBe(0);
  });

  it('returns correct RateLimit-* header values', () => {
    let t = 0;
    const limiter = new RateLimiter({ limits: { default: 5, auth: 5, tx: 5, chain: 5 }, windowMs: 60_000, now: () => t });
    const r1 = limiter.check('default', 'ip1');
    expect(r1.limit).toBe(5);
    expect(r1.remaining).toBe(4);
    const r2 = limiter.check('default', 'ip1');
    expect(r2.remaining).toBe(3);
  });

  it('createRateLimiterFromEnv reads env vars', () => {
    process.env.RATE_LIMIT_AUTH_PER_MIN = '3';
    process.env.RATE_LIMIT_ENABLED = 'true';
    const limiter = createRateLimiterFromEnv();
    for (let i = 0; i < 3; i++) limiter.check('auth', 'ip1');
    expect(limiter.check('auth', 'ip1').allowed).toBe(false);
    delete process.env.RATE_LIMIT_AUTH_PER_MIN;
    delete process.env.RATE_LIMIT_ENABLED;
  });

  it('createRateLimiterFromEnv disabled when RATE_LIMIT_ENABLED=false', () => {
    process.env.RATE_LIMIT_ENABLED = 'false';
    const limiter = createRateLimiterFromEnv();
    for (let i = 0; i < 50; i++) {
      expect(limiter.check('default', 'ip1').allowed).toBe(true);
    }
    delete process.env.RATE_LIMIT_ENABLED;
  });
});

// ---------------------------------------------------------------------------
// Integration tests: rate limit middleware via HTTP
// ---------------------------------------------------------------------------

/** Build an app with tight, test-scoped limits injected via AppDeps. */
function makeApp(limits: { default?: number; auth?: number; tx?: number; chain?: number }) {
  const rateLimiter = new RateLimiter({
    limits: { default: limits.default ?? 1000, auth: limits.auth ?? 1000, tx: limits.tx ?? 1000, chain: limits.chain ?? 1000 },
    windowMs: 60_000,
  });
  return createApp({ store: new EscrowStore(), rateLimiter });
}

describe('Rate limit middleware integration', () => {
  // --- default policy ---
  it('returns 429 rate_limited with Retry-After and RateLimit headers on default policy breach', async () => {
    const app = makeApp({ default: 2 });

    // First two requests succeed
    await request(app).get('/api/v1/stats').expect(200);
    await request(app).get('/api/v1/stats').expect(200);

    const limited = await request(app).get('/api/v1/stats').expect(429);
    expect(limited.body.error).toBe('rate_limited');
    expect(limited.headers['retry-after']).toBeDefined();
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(limited.headers['ratelimit-limit']).toBe('2');
    expect(limited.headers['ratelimit-remaining']).toBe('0');
    expect(limited.headers['ratelimit-reset']).toBeDefined();
    expect(limited.body.requestId).toEqual(expect.any(String));
  });

  it('sets RateLimit-Remaining on allowed requests', async () => {
    const app = makeApp({ default: 5 });
    const r1 = await request(app).get('/api/v1/stats').expect(200);
    expect(r1.headers['ratelimit-limit']).toBe('5');
    expect(Number(r1.headers['ratelimit-remaining'])).toBe(4);
    const r2 = await request(app).get('/api/v1/stats').expect(200);
    expect(Number(r2.headers['ratelimit-remaining'])).toBe(3);
  });

  // --- auth policy ---
  it('applies auth policy to POST /api/v1/auth/token', async () => {
    const app = makeApp({ auth: 2 });

    // Send two (they 400/401 due to bad payload, but middleware runs first)
    await request(app).post('/api/v1/auth/token').send({ address: 'bad', challenge: 'x', signature: 'y' });
    await request(app).post('/api/v1/auth/token').send({ address: 'bad', challenge: 'x', signature: 'y' });

    const limited = await request(app)
      .post('/api/v1/auth/token')
      .send({ address: 'bad', challenge: 'x', signature: 'y' })
      .expect(429);
    expect(limited.body.error).toBe('rate_limited');
    expect(limited.headers['ratelimit-limit']).toBe('2');
  });

  // --- tx policy ---
  it('applies tx policy to POST /api/v1/tx/build', async () => {
    const app = makeApp({ tx: 2 });

    await request(app).post('/api/v1/tx/build').send({});
    await request(app).post('/api/v1/tx/build').send({});

    const limited = await request(app).post('/api/v1/tx/build').send({}).expect(429);
    expect(limited.body.error).toBe('rate_limited');
    expect(limited.headers['ratelimit-limit']).toBe('2');
  });

  it('applies tx policy to POST /api/v1/tx/submit', async () => {
    const app = makeApp({ tx: 2 });

    await request(app).post('/api/v1/tx/submit').send({ xdr: 'bad' });
    await request(app).post('/api/v1/tx/submit').send({ xdr: 'bad' });

    const limited = await request(app).post('/api/v1/tx/submit').send({ xdr: 'bad' }).expect(429);
    expect(limited.body.error).toBe('rate_limited');
    expect(limited.headers['ratelimit-limit']).toBe('2');
  });

  // --- default policy on contract mutations ---
  it('applies default policy to contract mutations', async () => {
    const app = makeApp({ default: 2 });

    await request(app)
      .post('/api/v1/contracts')
      .send({ client: 'GA', freelancer: 'GB', milestones: [{ amount: 100 }] });
    await request(app)
      .post('/api/v1/contracts')
      .send({ client: 'GA', freelancer: 'GB', milestones: [{ amount: 100 }] });

    const limited = await request(app)
      .post('/api/v1/contracts')
      .send({ client: 'GA', freelancer: 'GB', milestones: [{ amount: 100 }] })
      .expect(429);
    expect(limited.body.error).toBe('rate_limited');
  });

  // --- exempt routes ---
  it('exempts /health/live from rate limiting', async () => {
    const app = makeApp({ default: 1 });

    // Exhaust the default budget
    await request(app).get('/api/v1/stats').expect(200);
    await request(app).get('/api/v1/stats').expect(429);

    // Health probes are on the top-level app, not the v1 router — always pass
    await request(app).get('/health/live').expect(200);
    // /health/ready may return 503 when the Soroban RPC is unreachable in tests,
    // but it must NOT return 429 (it is exempt from rate limiting).
    const readyRes = await request(app).get('/health/ready');
    expect(readyRes.status).not.toBe(429);
  });

  it('exempts /metrics from rate limiting', async () => {
    const app = makeApp({ default: 1 });
    await request(app).get('/api/v1/stats').expect(200);
    await request(app).get('/api/v1/stats').expect(429);

    // /metrics is mounted outside /api/v1
    const metricsRes = await request(app).get('/metrics');
    expect(metricsRes.status).not.toBe(429);
  });

  // --- RATE_LIMIT_ENABLED=false master switch ---
  it('RATE_LIMIT_ENABLED=false passes all requests', async () => {
    const rateLimiter = new RateLimiter({
      enabled: false,
      limits: { default: 1, auth: 1, tx: 1, chain: 1 },
      windowMs: 60_000,
    });
    const app = createApp({ store: new EscrowStore(), rateLimiter });

    for (let i = 0; i < 10; i++) {
      await request(app).get('/api/v1/stats').expect(200);
    }
  });
});

// ---------------------------------------------------------------------------
// chain policy (existing behaviour preserved)
// ---------------------------------------------------------------------------

describe('chain rate-limit policy (existing behaviour)', () => {
  it('returns 429 chain_rate_limited (not rate_limited) after exceeding chain budget', async () => {
    const rateLimiter = new RateLimiter({
      limits: { default: 1000, auth: 1000, tx: 1000, chain: 2 },
      windowMs: 60_000,
    });
    const app = createApp({ store: new EscrowStore(), rateLimiter });

    await request(app).get('/api/v1/chain/contracts/1').expect((r) => expect([200, 404, 502, 503]).toContain(r.status));
    await request(app).get('/api/v1/chain/contracts/2').expect((r) => expect([200, 404, 502, 503]).toContain(r.status));

    const limited = await request(app).get('/api/v1/chain/contracts/3').expect(429);
    expect(limited.body.error).toBe('chain_rate_limited');
    expect(limited.headers['retry-after']).toBeDefined();
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(limited.headers['ratelimit-limit']).toBe('2');
    expect(limited.headers['ratelimit-remaining']).toBe('0');
  });

  it('chain_rate_limited response includes requestId', async () => {
    const rateLimiter = new RateLimiter({
      limits: { default: 1000, auth: 1000, tx: 1000, chain: 1 },
      windowMs: 60_000,
    });
    const app = createApp({ store: new EscrowStore(), rateLimiter });

    await request(app).get('/api/v1/chain/contracts/1');
    const limited = await request(app).get('/api/v1/chain/contracts/2').expect(429);
    expect(limited.body.requestId).toEqual(expect.any(String));
  });
});
