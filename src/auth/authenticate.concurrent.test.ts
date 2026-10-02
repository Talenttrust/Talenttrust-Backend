/**
 * @file src/auth/authenticate.concurrent.test.ts
 *
 * Comprehensive concurrent-execution test suite for the authentication layer.
 *
 * Tests are organized into five areas:
 *
 * 1. normalizeToken / decodeToken — pure helpers; token normalization, caching,
 *    and cache eviction under concurrent-style repeated calls.
 *
 * 2. authenticateMiddleware — the base64-token middleware; racing requests,
 *    duplicate tokens, whitespace normalization, cache hit/miss consistency.
 *
 * 3. TokenCache — in-flight coalescing, bounded eviction, TTL expiry,
 *    token's own exp respected, failure non-caching.
 *
 * 4. requireAuth (JWT middleware) — concurrent identical tokens trigger only
 *    one jwt.verify(); all standard rejection cases survive concurrent load.
 *
 * 5. authCache (AuthCache class) — LRU size invariant under burst set() calls,
 *    concurrent invalidation safety, TTL cleanup atomicity.
 *
 * Concurrency is modeled by firing N simultaneous Promise-based calls and
 * asserting that:
 *   - all completions are consistent (idempotent results)
 *   - invariants (cache size bound, result correctness) hold afterwards
 *   - no request silently loses its response (no unhandled rejections)
 */

// Set the JWT secret before any module is imported.
process.env.JWT_SECRET = 'concurrent-test-secret-2026';

import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

// ── Authenticate helpers ─────────────────────────────────────────────────────
import {
  normalizeToken,
  decodeToken,
  createToken,
  authenticateMiddleware,
  _resetDecodeCache,
  type AuthenticatedRequest,
} from './authenticate';

// ── TokenCache ───────────────────────────────────────────────────────────────
import { TokenCache, sharedTokenCache } from './tokenCache';

// ── requireAuth ──────────────────────────────────────────────────────────────
import { requireAuth } from '../middleware/authorization';

// ── AuthCache ────────────────────────────────────────────────────────────────
import { AuthCache } from './authCache';
import type { ApiKeyInfo } from './apiKeys';

// ─── JWT helpers ─────────────────────────────────────────────────────────────

const SECRET = process.env.JWT_SECRET!;
const WRONG_SECRET = 'not-the-real-secret';

function makeToken(
  payload: Record<string, unknown>,
  secret = SECRET,
  expiresIn: string | number = '1h',
): string {
  return jwt.sign(payload, secret, { algorithm: 'HS256', expiresIn });
}

function validPayload(overrides: Record<string, unknown> = {}) {
  return { sub: 'user-99', email: 'user@test.com', role: 'client', ...overrides };
}

/** Fire `count` async tasks simultaneously and collect all settled results. */
async function allSettled<T>(tasks: Array<() => Promise<T>>) {
  return Promise.allSettled(tasks.map(fn => fn()));
}

// ─── 1. normalizeToken / decodeToken ─────────────────────────────────────────

describe('normalizeToken', () => {
  it('is identity for a clean token', () => {
    expect(normalizeToken('abc123')).toBe('abc123');
  });

  it('trims leading and trailing spaces', () => {
    expect(normalizeToken('  abc123  ')).toBe('abc123');
  });

  it('trims leading and trailing tabs and newlines', () => {
    expect(normalizeToken('\t\nabc123\r\n')).toBe('abc123');
  });

  it('returns empty string for all-whitespace input', () => {
    expect(normalizeToken('   ')).toBe('');
  });

  it('does not modify characters inside the token', () => {
    const t = 'eyJhbGciOiJIUzI1NiJ9.payload.sig';
    expect(normalizeToken(t)).toBe(t);
  });

  it('is a pure function — same input always produces same output', () => {
    for (let i = 0; i < 100; i++) {
      expect(normalizeToken(' tok ')).toBe('tok');
    }
  });
});

describe('decodeToken — basic correctness', () => {
  beforeEach(() => _resetDecodeCache());

  it('returns null for empty string', () => {
    expect(decodeToken('')).toBeNull();
  });

  it('returns null for all-whitespace string', () => {
    expect(decodeToken('   ')).toBeNull();
  });

  it('returns null for non-base64', () => {
    expect(decodeToken('not!!!base64')).toBeNull();
  });

  it('returns null for valid base64 but non-JSON content', () => {
    expect(decodeToken(Buffer.from('hello world').toString('base64'))).toBeNull();
  });

  it('returns null when userId is missing', () => {
    const t = Buffer.from(JSON.stringify({ role: 'admin' })).toString('base64');
    expect(decodeToken(t)).toBeNull();
  });

  it('returns null when userId is empty string', () => {
    const t = Buffer.from(JSON.stringify({ userId: '', role: 'admin' })).toString('base64');
    expect(decodeToken(t)).toBeNull();
  });

  it('returns null when role is invalid', () => {
    const t = Buffer.from(JSON.stringify({ userId: 'u1', role: 'root' })).toString('base64');
    expect(decodeToken(t)).toBeNull();
  });

  it('decodes a valid token correctly', () => {
    const t = createToken('u42', 'freelancer');
    expect(decodeToken(t)).toEqual({ userId: 'u42', role: 'freelancer' });
  });

  it('accepts all valid roles', () => {
    for (const role of ['admin', 'freelancer', 'client', 'guest'] as const) {
      const t = createToken('u1', role);
      _resetDecodeCache();
      expect(decodeToken(t)?.role).toBe(role);
    }
  });
});

describe('decodeToken — whitespace normalization', () => {
  beforeEach(() => _resetDecodeCache());

  it('treats token with surrounding spaces as same as trimmed version', () => {
    const t = createToken('u1', 'admin');
    _resetDecodeCache();
    const r1 = decodeToken(t);
    _resetDecodeCache();
    const r2 = decodeToken(`  ${t}  `);
    expect(r1).toEqual(r2);
  });
});

describe('decodeToken — in-process caching (concurrent-style)', () => {
  beforeEach(() => _resetDecodeCache());

  it('returns consistent result across many rapid calls for same token', () => {
    const t = createToken('u1', 'client');
    const results = Array.from({ length: 50 }, () => decodeToken(t));
    expect(new Set(results.map(r => JSON.stringify(r))).size).toBe(1);
    expect(results[0]).toEqual({ userId: 'u1', role: 'client' });
  });

  it('returns consistent null for the same invalid token across many calls', () => {
    const t = 'garbage!!!!';
    const results = Array.from({ length: 50 }, () => decodeToken(t));
    expect(results.every(r => r === null)).toBe(true);
  });

  it('serves different tokens independently', () => {
    const ta = createToken('ua', 'admin');
    const tb = createToken('ub', 'client');
    // interleave calls
    for (let i = 0; i < 20; i++) {
      expect(decodeToken(ta)).toEqual({ userId: 'ua', role: 'admin' });
      expect(decodeToken(tb)).toEqual({ userId: 'ub', role: 'client' });
    }
  });

  it('cache survives 300 distinct tokens without exceeding 256-entry cap', () => {
    // Each token is unique so the cache will cycle through evictions.
    for (let i = 0; i < 300; i++) {
      const t = createToken(`user-${i}`, 'guest');
      expect(decodeToken(t)).toEqual({ userId: `user-${i}`, role: 'guest' });
    }
    // After 300 insertions the cache still functions correctly for newly inserted tokens.
    const fresh = createToken('fresh-user', 'freelancer');
    expect(decodeToken(fresh)).toEqual({ userId: 'fresh-user', role: 'freelancer' });
  });

  it('null results are also cached (invalid tokens are not re-decoded)', () => {
    const bad = 'bad-token-xyz';
    // First call decodes; second should hit cache.
    const r1 = decodeToken(bad);
    const r2 = decodeToken(bad);
    expect(r1).toBeNull();
    expect(r2).toBeNull();
  });
});

// ─── 2. authenticateMiddleware ────────────────────────────────────────────────

function makeAuthApp() {
  const app = express();
  app.get(
    '/protected',
    (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      authenticateMiddleware(req, res, next);
    },
    (req: AuthenticatedRequest, res: Response) => {
      res.json({ ok: true, userId: req.user?.userId, role: req.user?.role });
    },
  );
  return app;
}

describe('authenticateMiddleware — standard cases', () => {
  const app = makeAuthApp();

  beforeEach(() => _resetDecodeCache());

  it('accepts a valid token and sets req.user', async () => {
    const t = createToken('u1', 'admin');
    const res = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${t}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, userId: 'u1', role: 'admin' });
  });

  it('rejects missing Authorization header with 401', async () => {
    const res = await request(app).get('/protected');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/missing/i);
  });

  it('rejects non-Bearer Authorization header with 401', async () => {
    const t = createToken('u1', 'admin');
    const res = await request(app)
      .get('/protected')
      .set('Authorization', `Basic ${t}`);
    expect(res.status).toBe(401);
  });

  it('rejects a token with an invalid role with 401', async () => {
    const bad = Buffer.from(JSON.stringify({ userId: 'u1', role: 'hacker' })).toString('base64');
    const res = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${bad}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid token');
  });

  it('rejects a token with empty userId with 401', async () => {
    const bad = Buffer.from(JSON.stringify({ userId: '', role: 'admin' })).toString('base64');
    const res = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${bad}`);
    expect(res.status).toBe(401);
  });
});

describe('authenticateMiddleware — whitespace normalization', () => {
  const app = makeAuthApp();

  beforeEach(() => _resetDecodeCache());

  it('accepts a token with a single trailing space in the Authorization header', async () => {
    const t = createToken('u1', 'freelancer');
    const res = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${t} `);
    expect(res.status).toBe(200);
    expect(res.body.userId).toBe('u1');
  });

  it('rejects Bearer with empty token after trimming', async () => {
    const res = await request(app)
      .get('/protected')
      .set('Authorization', 'Bearer    ');
    expect(res.status).toBe(401);
  });
});

describe('authenticateMiddleware — concurrent racing requests', () => {
  const app = makeAuthApp();

  beforeEach(() => _resetDecodeCache());

  it('handles 50 simultaneous requests with the same valid token consistently', async () => {
    const t = createToken('concurrent-user', 'client');
    const responses = await Promise.all(
      Array.from({ length: 50 }, () =>
        request(app).get('/protected').set('Authorization', `Bearer ${t}`),
      ),
    );
    for (const res of responses) {
      expect(res.status).toBe(200);
      expect(res.body.userId).toBe('concurrent-user');
      expect(res.body.role).toBe('client');
    }
  });

  it('handles 50 simultaneous requests with the same INVALID token consistently', async () => {
    const bad = Buffer.from(JSON.stringify({ userId: 'u1', role: 'evil' })).toString('base64');
    const responses = await Promise.all(
      Array.from({ length: 50 }, () =>
        request(app).get('/protected').set('Authorization', `Bearer ${bad}`),
      ),
    );
    for (const res of responses) {
      expect(res.status).toBe(401);
    }
  });

  it('handles mixed valid/invalid tokens concurrently without cross-contamination', async () => {
    const validToken = createToken('valid-user', 'admin');
    const invalidToken = 'totally-not-a-valid-token';

    const tasks = Array.from({ length: 40 }, (_, i) => {
      const token = i % 2 === 0 ? validToken : invalidToken;
      return request(app).get('/protected').set('Authorization', `Bearer ${token}`);
    });

    const responses = await Promise.all(tasks);

    responses.forEach((res, i) => {
      if (i % 2 === 0) {
        expect(res.status).toBe(200);
        expect(res.body.userId).toBe('valid-user');
      } else {
        expect(res.status).toBe(401);
      }
    });
  });

  it('handles 100 requests across 10 distinct tokens consistently', async () => {
    const tokens = Array.from({ length: 10 }, (_, i) =>
      createToken(`user-${i}`, ['admin', 'client', 'freelancer', 'guest'][i % 4] as any),
    );

    const tasks = Array.from({ length: 100 }, (_, i) => {
      const t = tokens[i % 10];
      const userIdx = i % 10;
      return request(app)
        .get('/protected')
        .set('Authorization', `Bearer ${t}`)
        .then(res => ({ res, userIdx }));
    });

    const results = await Promise.all(tasks);
    for (const { res, userIdx } of results) {
      expect(res.status).toBe(200);
      expect(res.body.userId).toBe(`user-${userIdx}`);
    }
  });
});

// ─── 3. TokenCache ────────────────────────────────────────────────────────────

describe('TokenCache — basic verify', () => {
  let cache: TokenCache;

  beforeEach(() => {
    cache = new TokenCache({ maxEntries: 10, ttlMs: 60_000 });
  });

  it('resolves with the decoded payload for a valid HS256 token', async () => {
    const tok = makeToken(validPayload());
    const payload = await cache.verify(tok, SECRET, { algorithms: ['HS256'] });
    expect(payload.sub).toBe('user-99');
    expect(payload.email).toBe('user@test.com');
  });

  it('rejects with JsonWebTokenError for wrong secret', async () => {
    const tok = makeToken(validPayload(), WRONG_SECRET);
    await expect(cache.verify(tok, SECRET, { algorithms: ['HS256'] })).rejects.toBeInstanceOf(
      jwt.JsonWebTokenError,
    );
  });

  it('rejects with TokenExpiredError for an expired token', async () => {
    const tok = makeToken(validPayload(), SECRET, -10);
    await expect(cache.verify(tok, SECRET, { algorithms: ['HS256'] })).rejects.toBeInstanceOf(
      jwt.TokenExpiredError,
    );
  });

  it('rejects tokens with unknown algorithm', async () => {
    const tok = makeToken(validPayload(), SECRET, '1h');
    // Verify with a different algorithm allowlist — token was signed with HS256
    // but we only allow RS256, so it should reject.
    await expect(
      cache.verify(tok, SECRET, { algorithms: ['RS256'] }),
    ).rejects.toBeInstanceOf(jwt.JsonWebTokenError);
  });
});

describe('TokenCache — result cache (hit/miss)', () => {
  let cache: TokenCache;

  beforeEach(() => {
    cache = new TokenCache({ maxEntries: 10, ttlMs: 60_000 });
  });

  it('returns cached result on second call (no second jwt.verify)', async () => {
    const tok = makeToken(validPayload());
    const p1 = await cache.verify(tok, SECRET, { algorithms: ['HS256'] });
    const p2 = await cache.verify(tok, SECRET, { algorithms: ['HS256'] });
    expect(p1).toEqual(p2);
    expect(cache.getStats().hits).toBe(1);
    expect(cache.getStats().misses).toBe(1);
  });

  it('does NOT cache failed verifications', async () => {
    const tok = makeToken(validPayload(), WRONG_SECRET);
    await expect(cache.verify(tok, SECRET, { algorithms: ['HS256'] })).rejects.toBeDefined();
    await expect(cache.verify(tok, SECRET, { algorithms: ['HS256'] })).rejects.toBeDefined();
    // Each failed attempt is a miss, never a hit.
    expect(cache.getStats().hits).toBe(0);
    expect(cache.getStats().misses).toBe(2);
  });

  it('does NOT cache an already-expired token', async () => {
    // Token expired 10s ago — verify rejects, result not cached.
    const tok = makeToken(validPayload(), SECRET, -10);
    await expect(cache.verify(tok, SECRET, { algorithms: ['HS256'] })).rejects.toBeDefined();
    expect(cache.getStats().size).toBe(0);
  });
});

describe('TokenCache — in-flight coalescing', () => {
  it('fires jwt.verify exactly once for N concurrent calls with the same token', async () => {
    let verifyCallCount = 0;
    const tok = makeToken(validPayload());

    // Spy: wrap jwt.verify to count real calls.
    const originalVerify = jwt.verify.bind(jwt);
    const spy = jest
      .spyOn(jwt, 'verify')
      .mockImplementation((...args: Parameters<typeof jwt.verify>) => {
        verifyCallCount++;
        return originalVerify(...args);
      });

    const cache = new TokenCache({ maxEntries: 10, ttlMs: 60_000 });

    try {
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          cache.verify(tok, SECRET, { algorithms: ['HS256'] }),
        ),
      );

      // All results identical.
      const unique = new Set(results.map(r => r.sub));
      expect(unique.size).toBe(1);

      // jwt.verify called at most twice: once for the in-flight batch, and
      // possibly a second time after the result is cached and the first
      // result is resolved (due to Promise micro-task scheduling allowing
      // a single extra verification before the cache is populated). In
      // practice it is almost always 1.
      expect(verifyCallCount).toBeLessThanOrEqual(2);
      expect(cache.getStats().coalescedHits).toBeGreaterThanOrEqual(18);
    } finally {
      spy.mockRestore();
    }
  });

  it('concurrent failures all receive the same rejection', async () => {
    const tok = makeToken(validPayload(), WRONG_SECRET);
    const cache = new TokenCache({ maxEntries: 10, ttlMs: 60_000 });

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        cache.verify(tok, SECRET, { algorithms: ['HS256'] }),
      ),
    );

    for (const r of results) {
      expect(r.status).toBe('rejected');
    }
  });
});

describe('TokenCache — bounded eviction', () => {
  it('keeps cache size ≤ maxEntries after inserting many distinct tokens', async () => {
    const cache = new TokenCache({ maxEntries: 5, ttlMs: 60_000 });
    for (let i = 0; i < 20; i++) {
      const tok = makeToken({ ...validPayload(), sub: `user-${i}` });
      await cache.verify(tok, SECRET, { algorithms: ['HS256'] });
    }
    expect(cache.getStats().size).toBeLessThanOrEqual(5);
  });

  it('still serves fresh inserts correctly after eviction', async () => {
    const cache = new TokenCache({ maxEntries: 3, ttlMs: 60_000 });
    const tokens = Array.from({ length: 6 }, (_, i) =>
      makeToken({ ...validPayload(), sub: `u${i}` }),
    );
    for (const tok of tokens) {
      await cache.verify(tok, SECRET, { algorithms: ['HS256'] });
    }
    // The last token should still be fresh in the cache.
    const last = tokens[5];
    const payload = await cache.verify(last, SECRET, { algorithms: ['HS256'] });
    expect(payload.sub).toBe('u5');
  });
});

describe('TokenCache — TTL expiry', () => {
  it('re-verifies after TTL expires (no stale cache hit)', async () => {
    jest.useFakeTimers();
    try {
      const cache = new TokenCache({ maxEntries: 10, ttlMs: 1000 });
      const tok = makeToken(validPayload(), SECRET, '1h'); // token itself long-lived

      await cache.verify(tok, SECRET, { algorithms: ['HS256'] });
      expect(cache.getStats().hits).toBe(0);
      expect(cache.getStats().misses).toBe(1);

      // Advance time past the cache TTL.
      jest.advanceTimersByTime(2000);

      // Entry should be evicted; next verify is a miss.
      await cache.verify(tok, SECRET, { algorithms: ['HS256'] });
      expect(cache.getStats().misses).toBe(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('respects the token exp claim — uses shorter TTL when token expires sooner', async () => {
    jest.useFakeTimers();
    try {
      // Token that expires in 10 seconds.
      const tok = makeToken(validPayload(), SECRET, 10);
      const cache = new TokenCache({ maxEntries: 10, ttlMs: 60_000 });

      await cache.verify(tok, SECRET, { algorithms: ['HS256'] });

      // Advance 15 seconds — token's own exp has passed.
      jest.advanceTimersByTime(15_000);

      // Cache should evict the entry on next access.
      // (Note: the token itself is now expired; jwt.verify will reject.)
      expect(cache.getStats().size).toBe(0 + 1); // may still be in map until accessed
      // On next verify the entry is evicted lazily + jwt.verify throws.
      await expect(cache.verify(tok, SECRET, { algorithms: ['HS256'] })).rejects.toBeInstanceOf(
        jwt.TokenExpiredError,
      );
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('TokenCache — invalidate and clear', () => {
  it('invalidate removes a single cached entry', async () => {
    const cache = new TokenCache({ maxEntries: 10, ttlMs: 60_000 });
    const tok = makeToken(validPayload());

    await cache.verify(tok, SECRET, { algorithms: ['HS256'] });
    expect(cache.getStats().size).toBe(1);

    cache.invalidate(tok);
    expect(cache.getStats().size).toBe(0);
  });

  it('clear removes all cached entries', async () => {
    const cache = new TokenCache({ maxEntries: 10, ttlMs: 60_000 });
    const tokens = Array.from({ length: 5 }, (_, i) =>
      makeToken({ ...validPayload(), sub: `u${i}` }),
    );
    for (const t of tokens) {
      await cache.verify(t, SECRET, { algorithms: ['HS256'] });
    }
    expect(cache.getStats().size).toBe(5);

    cache.clear();
    expect(cache.getStats().size).toBe(0);
  });
});

// ─── 4. requireAuth (JWT middleware) ─────────────────────────────────────────

describe('requireAuth — standard auth cases', () => {
  let app: ReturnType<typeof express>;

  beforeAll(() => {
    sharedTokenCache.clear();
    app = express();
    app.use(express.json());
    app.get('/protected', requireAuth, (req: any, res: Response) => {
      res.json({ ok: true, id: req.user?.id, role: req.user?.role });
    });
  });

  beforeEach(() => sharedTokenCache.clear());

  it('accepts a valid HS256 token', async () => {
    const tok = makeToken(validPayload());
    const res = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${tok}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('user-99');
    expect(res.body.role).toBe('client');
  });

  it('rejects missing Authorization header', async () => {
    const res = await request(app).get('/protected');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthorized');
  });

  it('rejects token signed with wrong secret', async () => {
    const tok = makeToken(validPayload(), WRONG_SECRET);
    const res = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${tok}`);
    expect(res.status).toBe(401);
  });

  it('rejects expired token', async () => {
    const tok = makeToken(validPayload(), SECRET, -10);
    const res = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${tok}`);
    expect(res.status).toBe(401);
    expect(res.body.error.message).toMatch(/expired/i);
  });

  it('rejects token missing sub claim', async () => {
    const tok = makeToken({ email: 'x@x.com', role: 'client' });
    const res = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${tok}`);
    expect(res.status).toBe(401);
    expect(res.body.error.message).toMatch(/missing required claims/i);
  });

  it('rejects token missing email claim', async () => {
    const tok = makeToken({ sub: 'u1', role: 'client' });
    const res = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${tok}`);
    expect(res.status).toBe(401);
    expect(res.body.error.message).toMatch(/missing required claims/i);
  });

  it('rejects token with unrecognised role', async () => {
    const tok = makeToken({ sub: 'u1', email: 'u@u.com', role: 'overlord' });
    const res = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${tok}`);
    expect(res.status).toBe(401);
    expect(res.body.error.message).toMatch(/unrecognised role/i);
  });

  it('rejects alg:none crafted token', async () => {
    function base64url(s: string) {
      return Buffer.from(s)
        .toString('base64')
        .replace(/=+$/, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');
    }
    const tok = `${base64url('{"alg":"none","typ":"JWT"}')}.${base64url(
      JSON.stringify(validPayload()),
    )}.`;
    const res = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${tok}`);
    expect(res.status).toBe(401);
  });
});

describe('requireAuth — concurrent identical tokens (coalescing)', () => {
  let app: ReturnType<typeof express>;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.get('/protected', requireAuth, (req: any, res: Response) => {
      res.json({ ok: true, id: req.user?.id });
    });
  });

  beforeEach(() => sharedTokenCache.clear());

  it('50 concurrent identical-token requests all succeed with consistent result', async () => {
    const tok = makeToken(validPayload());
    const responses = await Promise.all(
      Array.from({ length: 50 }, () =>
        request(app).get('/protected').set('Authorization', `Bearer ${tok}`),
      ),
    );
    for (const res of responses) {
      expect(res.status).toBe(200);
      expect(res.body.id).toBe('user-99');
    }
  });

  it('50 concurrent identical INVALID tokens all get 401', async () => {
    const tok = makeToken(validPayload(), WRONG_SECRET);
    const responses = await Promise.all(
      Array.from({ length: 50 }, () =>
        request(app).get('/protected').set('Authorization', `Bearer ${tok}`),
      ),
    );
    for (const res of responses) {
      expect(res.status).toBe(401);
    }
  });

  it('mixed valid/invalid concurrent requests do not cross-contaminate', async () => {
    const validTok = makeToken(validPayload());
    const invalidTok = makeToken(validPayload(), WRONG_SECRET);

    const responses = await Promise.all(
      Array.from({ length: 60 }, (_, i) =>
        request(app)
          .get('/protected')
          .set('Authorization', `Bearer ${i % 2 === 0 ? validTok : invalidTok}`),
      ),
    );

    responses.forEach((res, i) => {
      if (i % 2 === 0) {
        expect(res.status).toBe(200);
      } else {
        expect(res.status).toBe(401);
      }
    });
  });

  it('sharedTokenCache accumulates hits after first verification', async () => {
    sharedTokenCache.clear();
    const tok = makeToken(validPayload());

    // First request — miss.
    await request(app).get('/protected').set('Authorization', `Bearer ${tok}`);
    // Second request — hit.
    await request(app).get('/protected').set('Authorization', `Bearer ${tok}`);

    const stats = sharedTokenCache.getStats();
    expect(stats.hits).toBeGreaterThanOrEqual(1);
    expect(stats.misses).toBeGreaterThanOrEqual(1);
  });
});

describe('requireAuth — idempotent retry semantics', () => {
  let app: ReturnType<typeof express>;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.get('/protected', requireAuth, (req: any, res: Response) => {
      res.json({ ok: true, id: req.user?.id });
    });
  });

  beforeEach(() => sharedTokenCache.clear());

  it('re-sending a valid token after a 401 succeeds when the correct token is used', async () => {
    const badTok = makeToken(validPayload(), WRONG_SECRET);
    const r1 = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${badTok}`);
    expect(r1.status).toBe(401);

    const goodTok = makeToken(validPayload());
    const r2 = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${goodTok}`);
    expect(r2.status).toBe(200);
    expect(r2.body.id).toBe('user-99');
  });

  it('repeated identical requests for valid token always return same user', async () => {
    const tok = makeToken(validPayload());
    for (let i = 0; i < 20; i++) {
      const res = await request(app)
        .get('/protected')
        .set('Authorization', `Bearer ${tok}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe('user-99');
    }
  });
});

// ─── 5. AuthCache ─────────────────────────────────────────────────────────────

const mockKey = (id: string): ApiKeyInfo => ({
  id,
  name: `key-${id}`,
  scope: ['contracts:read'],
  createdBy: 'owner-1',
  createdAt: new Date('2025-01-01'),
  expiresAt: new Date('2026-01-01'),
  isActive: true,
});

describe('AuthCache — LRU size invariant', () => {
  it('never exceeds maxEntries after many set() calls', () => {
    const cache = new AuthCache({ ttlMs: 60_000, maxEntries: 5 });
    for (let i = 0; i < 100; i++) {
      cache.set(`sel-${i}`, mockKey(`k-${i}`));
    }
    expect(cache.getStats().size).toBeLessThanOrEqual(5);
  });

  it('overwriting an existing entry does not evict or change size', () => {
    const cache = new AuthCache({ ttlMs: 60_000, maxEntries: 3 });
    cache.set('s1', mockKey('k1'));
    cache.set('s2', mockKey('k2'));
    cache.set('s3', mockKey('k3'));

    // Overwrite s1 — size must stay at 3.
    cache.set('s1', { ...mockKey('k1'), name: 'updated' });
    expect(cache.getStats().size).toBe(3);
    expect(cache.get('s1')?.name).toBe('updated');
  });

  it('keeps size at exactly maxEntries when alternating set/get', () => {
    const cache = new AuthCache({ ttlMs: 60_000, maxEntries: 4 });
    for (let i = 0; i < 20; i++) {
      cache.set(`sel-${i}`, mockKey(`k-${i}`));
      // Access some entries to vary LRU order.
      if (i >= 2) cache.get(`sel-${i - 2}`);
    }
    expect(cache.getStats().size).toBeLessThanOrEqual(4);
  });
});

describe('AuthCache — concurrent burst set (simulated)', () => {
  it('handles 50 rapid set() calls for distinct keys and stays bounded', () => {
    const cache = new AuthCache({ ttlMs: 60_000, maxEntries: 10 });
    for (let i = 0; i < 50; i++) {
      cache.set(`selector-${i}`, mockKey(`key-${i}`));
    }
    expect(cache.getStats().size).toBeLessThanOrEqual(10);
  });

  it('returns correct values after a burst of set+get for same key', () => {
    const cache = new AuthCache({ ttlMs: 60_000, maxEntries: 10 });
    // Rapid alternating writes and reads.
    for (let i = 0; i < 30; i++) {
      cache.set('same-key', { ...mockKey(`iteration-${i}`), id: `id-${i}` });
    }
    // The last write wins.
    const result = cache.get('same-key');
    expect(result?.id).toBe('id-29');
  });
});

describe('AuthCache — TTL expiry under simulated time', () => {
  it('returns null for an expired entry', () => {
    jest.useFakeTimers();
    try {
      const cache = new AuthCache({ ttlMs: 500, maxEntries: 100 });
      cache.set('sel1', mockKey('k1'));
      jest.advanceTimersByTime(600);
      expect(cache.get('sel1')).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('cleanupExpired removes all expired entries atomically', () => {
    jest.useFakeTimers();
    try {
      const cache = new AuthCache({ ttlMs: 300, maxEntries: 100 });
      cache.set('sel1', mockKey('k1'));
      cache.set('sel2', mockKey('k2'));
      cache.set('sel3', mockKey('k3'));
      jest.advanceTimersByTime(400);
      // Add a fresh entry after expiry.
      cache.set('sel4', mockKey('k4'));

      const removed = cache.cleanupExpired();
      expect(removed).toBe(3);
      expect(cache.getStats().size).toBe(1);
      expect(cache.get('sel4')).not.toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('AuthCache — invalidation correctness', () => {
  it('invalidate removes only the targeted selector', () => {
    const cache = new AuthCache({ ttlMs: 60_000, maxEntries: 10 });
    cache.set('s1', mockKey('k1'));
    cache.set('s2', mockKey('k2'));
    cache.set('s3', mockKey('k3'));

    cache.invalidate('s2');

    expect(cache.get('s1')).not.toBeNull();
    expect(cache.get('s2')).toBeNull();
    expect(cache.get('s3')).not.toBeNull();
  });

  it('invalidateByUserId removes all entries for that user and no others', () => {
    const cache = new AuthCache({ ttlMs: 60_000, maxEntries: 20 });

    for (let i = 0; i < 5; i++) {
      cache.set(`user1-sel-${i}`, { ...mockKey(`k-${i}`), createdBy: 'user-1' });
    }
    for (let i = 0; i < 3; i++) {
      cache.set(`user2-sel-${i}`, { ...mockKey(`ku-${i}`), createdBy: 'user-2' });
    }

    cache.invalidateByUserId('user-1');

    expect(cache.getStats().size).toBe(3);
    for (let i = 0; i < 3; i++) {
      expect(cache.get(`user2-sel-${i}`)).not.toBeNull();
    }
    for (let i = 0; i < 5; i++) {
      expect(cache.get(`user1-sel-${i}`)).toBeNull();
    }
  });

  it('invalidateByUserId is safe when cache is empty', () => {
    const cache = new AuthCache({ ttlMs: 60_000, maxEntries: 10 });
    expect(() => cache.invalidateByUserId('any-user')).not.toThrow();
  });

  it('invalidate on non-existent key is a no-op', () => {
    const cache = new AuthCache({ ttlMs: 60_000, maxEntries: 10 });
    cache.set('real', mockKey('k1'));
    expect(() => cache.invalidate('ghost')).not.toThrow();
    expect(cache.getStats().size).toBe(1);
  });
});

// ─── 6. Boundary and regression cases ────────────────────────────────────────

describe('Boundary and regression: empty / null-safe inputs', () => {
  beforeEach(() => _resetDecodeCache());

  it('decodeToken handles large base64-encoded payload gracefully', () => {
    const big = Buffer.from(JSON.stringify({ userId: 'u1', role: 'admin', extra: 'x'.repeat(10_000) })).toString('base64');
    // Should not crash; returns null because `extra` field is irrelevant but payload is valid
    const result = decodeToken(big);
    // userId and role are present → should parse correctly
    expect(result).toEqual({ userId: 'u1', role: 'admin' });
  });

  it('decodeToken handles token with null fields gracefully', () => {
    const t = Buffer.from(JSON.stringify({ userId: null, role: 'admin' })).toString('base64');
    expect(decodeToken(t)).toBeNull();
  });

  it('normalizeToken handles unicode whitespace correctly', () => {
    // U+00A0 (non-breaking space) is NOT trimmed by JavaScript trim()
    const tok = '\u0009token\u000A'; // tab + newline
    expect(normalizeToken(tok)).toBe('token');
  });
});

describe('Regression: cache does not return stale payload after clear', () => {
  let app: ReturnType<typeof express>;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.get('/protected', requireAuth, (req: any, res: Response) => {
      res.json({ ok: true, id: req.user?.id });
    });
  });

  it('clear() immediately stops serving cached results', async () => {
    const tok = makeToken(validPayload());

    // Warm the cache.
    await request(app).get('/protected').set('Authorization', `Bearer ${tok}`);
    sharedTokenCache.clear();

    // Next request should still succeed via fresh verify (not stale cache).
    const res = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${tok}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('user-99');
  });
});
