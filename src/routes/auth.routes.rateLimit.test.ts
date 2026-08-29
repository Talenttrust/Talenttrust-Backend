/**
 * @file auth.routes.rateLimit.test.ts
 * @description
 * Integration and unit coverage for issue #756 — per-client rate limiting
 * on the auth endpoints.
 *
 * Verified end-to-end:
 *   - Inside-limit behaviour includes the documented `X-RateLimit-*`
 *     headers and the right remaining quota.
 *   - At-limit (the nth request right at the cap) still succeeds.
 *   - Over-limit returns 429 with a positive integer `Retry-After`
 *     header and the safe-error `rate_limited` envelope.
 *   - The hard-block branch of the abuse guard fires after the
 *     `abuseThreshold` violations.
 *   - Different clients (different IPs, different `X-API-Key` headers)
 *     are isolated — one going over the cap does not starve the others.
 *   - The fixed window resets so a fresh window restores availability.
 *   - Auth endpoints remain reachable no matter how unusual the
 *     identifier (no headers → per-process random bucket).
 *
 * Test strategy — stub routes + isolated store, no `authRouter` import:
 *   `auth.routes.ts` builds its own `authLimiter` at module-load from
 *   `rateLimitConfig.auth` and runs it on every request. Trying to
 *   wire the real router into the test would either (a) overwrite the
 *   real auth router's limiter via a brittle mock, or (b) leave the
 *   real limiter running in parallel with the test's own limiter,
 *   which clobbers `X-RateLimit-*` headers on successful requests.
 *   We sidestep both by mounting a minimal Express router that mirrors
 *   the auth endpoints' URL shape. This file therefore exercises the
 *   rate-limit middleware end-to-end; the auth router's own wiring is
 *   covered separately by `routes/auth.routes.test.ts` (with the limiter
 *   mocked to a no-op there).
 *
 * Coverage note:
 *   No current test wires the production `auth.routes.ts` `authLimiter`
 *   against real handlers. The integration on this side is verified by
 *   visual inspection of `src/routes/auth.routes.ts`: every route is
 *   declared as `router.post('/path', authLimiter, validator, handler)`.
 *   A future contributor can flip `routes/auth.routes.test.ts`'s mock
 *   to a pass-through for a single-suite smoke test if direct coverage
 *   is desired.
 */

import express, { Request, Response } from 'express';
import request from 'supertest';
import { RateLimitStore } from '../lib/rateLimitStore';
import { createRateLimiter } from '../middleware/rateLimiter';
import {
  authRateLimitKeyFn,
  createAuthKeyFn,
  AUTH_RATE_LIMIT_KEY_PREFIX,
} from '../auth/rateLimitKey';
import { notFoundHandler, errorHandler } from '../middleware/errorHandlers';
import { requestIdMiddleware } from '../middleware/requestId';

// ── Build a fresh app wired to a REAL limiter + a fresh store ───────────────

function buildAuthApp(opts: {
  maxRequests: number;
  windowMs: number;
  abuseThreshold: number;
}) {
  const store = new RateLimitStore({ sweepIntervalMs: 0 });
  const authLimiter = createRateLimiter({
    maxRequests: opts.maxRequests,
    windowMs: opts.windowMs,
    abuseThreshold: opts.abuseThreshold,
    blockDurationMs: 60_000,
    blockWindowMs: 60_000,
    maxBlockDurationMs: 86_400_000,
    keyFn: authRateLimitKeyFn,
    store,
    sendHeaders: true,
  });

  const app = express();
  app.use(requestIdMiddleware);
  app.use(express.json());
  const stubHandler = (_req: Request, res: Response) => {
    res.status(200).json({ ok: true });
  };
  // Mount the limiter on the parent path so it fronts every endpoint
  // that lives under `/api/v1/auth`. Equivalent to the per-route wiring
  // done in `auth.routes.ts`.
  app.use('/api/v1/auth', authLimiter);
  app.post('/api/v1/auth/login', stubHandler);
  app.post('/api/v1/auth/register', stubHandler);
  app.post('/api/v1/auth/refresh', stubHandler);
  app.post('/api/v1/auth/logout', stubHandler);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return { app, store };
}

// ── Suite setup ──────────────────────────────────────────────────────────────
//
// The handlers in this suite are stubs; they do not call into AuthService
// or open a database. No env restoration or DB lifecycle is required.

beforeEach(() => {
  jest.useRealTimers();
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// Within- and at-limit behaviour
// ─────────────────────────────────────────────────────────────────────────────

describe('auth rate limit — within limit', () => {
  it('allows the very first request and emits X-RateLimit-* headers', async () => {
    const { app, store } = buildAuthApp({
      maxRequests: 5,
      windowMs: 60_000,
      abuseThreshold: 99,
    });
    try {
      const res = await request(app)
        .post('/api/v1/auth/register')
        .set('X-Forwarded-For', '203.0.113.1');

      expect(res.status).toBe(200);
      expect(res.headers['x-ratelimit-limit']).toBe('5');
      expect(res.headers['x-ratelimit-remaining']).toBe('4');
      expect(Number(res.headers['x-ratelimit-reset'])).toBeGreaterThan(0);
    } finally {
      store.destroy();
    }
  });

  it('allows every request up to but not exceeding the cap (at-limit)', async () => {
    const max = 3;
    const { app, store } = buildAuthApp({
      maxRequests: max,
      windowMs: 60_000,
      abuseThreshold: 99,
    });
    try {
      for (let i = 0; i < max; i++) {
        const res = await request(app)
          .post('/api/v1/auth/register')
          .set('X-Forwarded-For', '203.0.113.2');
        expect(res.status).toBe(200);
        expect(res.headers['x-ratelimit-remaining']).toBe(String(max - i - 1));
      }
    } finally {
      store.destroy();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Over-limit behaviour — the 429 + Retry-After envelope
// ─────────────────────────────────────────────────────────────────────────────

describe('auth rate limit — over limit', () => {
  it('returns 429 with a Retry-After header when the cap is exceeded', async () => {
    const { app, store } = buildAuthApp({
      maxRequests: 2,
      windowMs: 60_000,
      abuseThreshold: 99,
    });
    try {
      const ip = '203.0.113.3';

      const first = await request(app).post('/api/v1/auth/register').set('X-Forwarded-For', ip);
      const second = await request(app).post('/api/v1/auth/register').set('X-Forwarded-For', ip);
      const third = await request(app).post('/api/v1/auth/register').set('X-Forwarded-For', ip);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(third.status).toBe(429);

      expect(third.headers['retry-after']).toBeDefined();
      const retryAfter = Number(third.headers['retry-after']);
      expect(Number.isInteger(retryAfter)).toBe(true);
      expect(retryAfter).toBeGreaterThan(0);
      expect(retryAfter).toBeLessThanOrEqual(60);

      expect(third.body.error).toBeDefined();
      expect(third.body.error.code).toBe('rate_limited');
      expect(third.body.error.message).toMatch(/too many requests/i);
    } finally {
      store.destroy();
    }
  });

  it('the over-limit response carries Retry-After and a safe error envelope', async () => {
    const { app, store } = buildAuthApp({
      maxRequests: 1,
      windowMs: 60_000,
      abuseThreshold: 99,
    });
    try {
      const ip = '203.0.113.4';

      await request(app).post('/api/v1/auth/register').set('X-Forwarded-For', ip);

      const blocked = await request(app).post('/api/v1/auth/register').set('X-Forwarded-For', ip);

      expect(blocked.status).toBe(429);
      expect(blocked.headers['retry-after']).toBeDefined();
      expect(blocked.body.error.code).toBe('rate_limited');
    } finally {
      store.destroy();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Hard-block (abuse guard) — repeated violations escalate to a longer block.
// With cap=1 and abuseThreshold=2, the abuse counter goes 1 (first
// violation) → 2 (second violation), and the limiter hard-blocks on the
// second violation; subsequent requests stay blocked until expiry.
// ─────────────────────────────────────────────────────────────────────────────

describe('auth rate limit — abuse guard (hard-block)', () => {
  it('escalates to a hard block after the abuseThreshold is hit', async () => {
    const { app, store } = buildAuthApp({
      maxRequests: 1,
      windowMs: 60_000,
      abuseThreshold: 2,
    });
    try {
      const ip = '203.0.113.6';

      // 1st — within limit, allowed.
      await request(app).post('/api/v1/auth/register').set('X-Forwarded-For', ip);

      // 2nd — first violation, abuse counter = 1, soft 429.
      const violationOne = await request(app).post('/api/v1/auth/register').set('X-Forwarded-For', ip);
      expect(violationOne.status).toBe(429);
      expect(violationOne.headers['x-ratelimit-blocked']).toBeUndefined();

      // 3rd — second violation, abuse counter = 2 (≥ threshold), hard-block.
      const violationTwo = await request(app).post('/api/v1/auth/register').set('X-Forwarded-For', ip);
      expect(violationTwo.status).toBe(429);
      expect(violationTwo.headers['x-ratelimit-blocked']).toBe('true');
      expect(Number(violationTwo.headers['retry-after'])).toBeGreaterThanOrEqual(60);

      // 4th — still hard-blocked.
      const postBlock = await request(app).post('/api/v1/auth/register').set('X-Forwarded-For', ip);
      expect(postBlock.status).toBe(429);
      expect(postBlock.headers['x-ratelimit-blocked']).toBe('true');
    } finally {
      store.destroy();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Window reset — the natural success path after `windowMs` elapses
// ─────────────────────────────────────────────────────────────────────────────

describe('auth rate limit — window reset', () => {
  it('restores availability once the window has elapsed', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(1_700_000_000_000);

    const { app, store } = buildAuthApp({
      maxRequests: 1,
      windowMs: 1_000,
      abuseThreshold: 99,
    });
    try {
      const ip = '203.0.113.5';

      const first = await request(app).post('/api/v1/auth/register').set('X-Forwarded-For', ip);
      const inWindowBlocked = await request(app).post('/api/v1/auth/register').set('X-Forwarded-For', ip);

      expect(first.status).toBe(200);
      expect(inWindowBlocked.status).toBe(429);

      jest.setSystemTime(1_700_000_001_001);

      const afterReset = await request(app).post('/api/v1/auth/register').set('X-Forwarded-For', ip);

      expect(afterReset.status).toBe(200);
      expect(afterReset.headers['x-ratelimit-limit']).toBe('1');
      expect(afterReset.headers['x-ratelimit-remaining']).toBe('0');
    } finally {
      store.destroy();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Per-client isolation — Issue #756: "per-client (API key / IP)"
// ─────────────────────────────────────────────────────────────────────────────

describe('auth rate limit — per-client isolation', () => {
  it('isolates different client IPs from each other', async () => {
    const { app, store } = buildAuthApp({
      maxRequests: 1,
      windowMs: 60_000,
      abuseThreshold: 99,
    });
    try {
      const ipA = '203.0.113.10';
      const ipB = '203.0.113.11';

      const aFirst = await request(app).post('/api/v1/auth/register').set('X-Forwarded-For', ipA);
      const aBlocked = await request(app).post('/api/v1/auth/register').set('X-Forwarded-For', ipA);
      const bOk = await request(app).post('/api/v1/auth/register').set('X-Forwarded-For', ipB);

      expect(aFirst.status).toBe(200);
      expect(aBlocked.status).toBe(429);
      expect(bOk.status).toBe(200);
    } finally {
      store.destroy();
    }
  });

  it('takes only the first hop from a multi-hop X-Forwarded-For chain', async () => {
    const { app, store } = buildAuthApp({
      maxRequests: 1,
      windowMs: 60_000,
      abuseThreshold: 99,
    });
    try {
      const clientFirstHop = '198.51.100.40';

      const resOne = await request(app)
        .post('/api/v1/auth/register')
        .set('X-Forwarded-For', `${clientFirstHop}, 10.0.0.1, 10.0.0.2`);
      const resTwo = await request(app)
        .post('/api/v1/auth/register')
        .set('X-Forwarded-For', `${clientFirstHop}, 10.0.0.99`);

      expect(resOne.status).toBe(200);
      expect(resTwo.status).toBe(429); // same first hop → same bucket
    } finally {
      store.destroy();
    }
  });

  it('X-API-Key takes priority over X-Forwarded-For for key derivation', async () => {
    const { app, store } = buildAuthApp({
      maxRequests: 1,
      windowMs: 60_000,
      abuseThreshold: 99,
    });
    try {
      const sharedIp = '203.0.113.20';
      const apiKeyA = 'service-key-a';
      const apiKeyB = 'service-key-b';

      const keyAFirst = await request(app)
        .post('/api/v1/auth/register')
        .set('X-Forwarded-For', sharedIp)
        .set('X-API-Key', apiKeyA);
      const keyABlocked = await request(app)
        .post('/api/v1/auth/register')
        .set('X-Forwarded-For', sharedIp)
        .set('X-API-Key', apiKeyA);
      const keyBOk = await request(app)
        .post('/api/v1/auth/register')
        .set('X-Forwarded-For', sharedIp)
        .set('X-API-Key', apiKeyB);
      const ipAloneOk = await request(app)
        .post('/api/v1/auth/register')
        .set('X-Forwarded-For', sharedIp);

      expect(keyAFirst.status).toBe(200);
      expect(keyABlocked.status).toBe(429);
      expect(keyBOk.status).toBe(200);
      expect(ipAloneOk.status).toBe(200);
    } finally {
      store.destroy();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Every auth endpoint runs through the same limiter (URL-shape parity check)
// ─────────────────────────────────────────────────────────────────────────────

describe('auth rate limit — coverage across endpoints', () => {
  it('counts /login, /register, /refresh, /logout against the same limiter bucket', async () => {
    const { app, store } = buildAuthApp({
      maxRequests: 3,
      windowMs: 60_000,
      abuseThreshold: 99,
    });
    try {
      const ip = '203.0.113.30';

      const login = await request(app).post('/api/v1/auth/login').set('X-Forwarded-For', ip);
      const register = await request(app).post('/api/v1/auth/register').set('X-Forwarded-For', ip);
      const refresh = await request(app).post('/api/v1/auth/refresh').set('X-Forwarded-For', ip);
      const blocked = await request(app).post('/api/v1/auth/logout').set('X-Forwarded-For', ip);

      expect(login.status).toBe(200);
      expect(register.status).toBe(200);
      expect(refresh.status).toBe(200);
      expect(blocked.status).toBe(429);
      expect(blocked.headers['retry-after']).toBeDefined();
      expect(blocked.body.error.code).toBe('rate_limited');
    } finally {
      store.destroy();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pure unit coverage for the key-derivation helper (>= 95% module coverage)
// ─────────────────────────────────────────────────────────────────────────────

describe('createAuthKeyFn — pure unit coverage', () => {
  const keyFn = createAuthKeyFn();

  it('prefers X-API-Key when present', () => {
    const key = keyFn({
      headers: {
        'x-api-key': 'alpha',
        'x-forwarded-for': '198.51.100.10',
      },
      ip: '198.51.100.10',
      socket: { remoteAddress: '198.51.100.10' },
    });
    expect(key).toBe(`${AUTH_RATE_LIMIT_KEY_PREFIX.apiKey}:alpha`);
  });

  it('falls back to the first X-Forwarded-For hop when no API key', () => {
    const key = keyFn({
      headers: { 'x-forwarded-for': '198.51.100.20, 10.0.0.1' },
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' },
    });
    expect(key).toBe(`${AUTH_RATE_LIMIT_KEY_PREFIX.ip}:198.51.100.20`);
  });

  it('falls back to req.ip when no XFF or API key', () => {
    const key = keyFn({
      headers: {},
      ip: '198.51.100.30',
      socket: { remoteAddress: '127.0.0.1' },
    });
    expect(key).toBe(`${AUTH_RATE_LIMIT_KEY_PREFIX.ip}:198.51.100.30`);
  });

  it('falls back to socket.remoteAddress when no headers or ip', () => {
    const key = keyFn({
      headers: {},
      ip: undefined,
      socket: { remoteAddress: '203.0.113.40' },
    });
    expect(key).toBe(`${AUTH_RATE_LIMIT_KEY_PREFIX.ip}:203.0.113.40`);
  });

  it('treats req.ip of null the same as undefined (falls through)', () => {
    const key = keyFn({
      headers: {},
      ip: null,
      socket: { remoteAddress: '203.0.113.41' },
    });
    expect(key).toBe(`${AUTH_RATE_LIMIT_KEY_PREFIX.ip}:203.0.113.41`);
  });

  it('returns the per-process unknown sentinel when nothing is identifiable', () => {
    const keyA = createAuthKeyFn()({ headers: {}, ip: undefined, socket: null });
    const keyB = createAuthKeyFn()({ headers: {}, ip: undefined, socket: null });
    expect(keyA).toMatch(/^unknown:/);
    expect(keyB).toMatch(/^unknown:/);
    expect(keyA).not.toBe(keyB);
  });

  it('returns the same unknown bucket for repeated calls within a process', () => {
    const local = createAuthKeyFn();
    const key1 = local({ headers: {}, ip: undefined, socket: null });
    const key2 = local({ headers: {}, ip: undefined, socket: null });
    expect(key1).toBe(key2);
  });

  it('treats array XFF headers the same as single string', () => {
    const key = keyFn({
      headers: { 'x-forwarded-for': ['198.51.100.50, 10.0.0.1'] },
      ip: undefined,
      socket: null,
    });
    expect(key).toBe(`${AUTH_RATE_LIMIT_KEY_PREFIX.ip}:198.51.100.50`);
  });

  it('treats array X-API-Key headers the same as single string', () => {
    const key = keyFn({
      headers: { 'x-api-key': ['gamma'] },
      ip: undefined,
      socket: null,
    });
    expect(key).toBe(`${AUTH_RATE_LIMIT_KEY_PREFIX.apiKey}:gamma`);
  });

  it('ignores a whitespace-only X-API-Key (falls back to IP)', () => {
    const key = keyFn({
      headers: { 'x-api-key': '   ', 'x-forwarded-for': '198.51.100.60' },
      ip: undefined,
      socket: null,
    });
    expect(key).toBe(`${AUTH_RATE_LIMIT_KEY_PREFIX.ip}:198.51.100.60`);
  });
});
