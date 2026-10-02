/**
 * @file authCache.concurrency.test.ts
 * @description Concurrency contract of the shared auth cache (issue #1394).
 *
 * `AuthCache` is process-wide state shared by every concurrent request, so its
 * correctness depends on more than hit rate:
 *
 * - INV-C1 (single flight) — concurrent misses for one selector run the loader
 *   once, not once per request.
 * - INV-C2 (no stale repopulation) — a load that resolves after a concurrent
 *   invalidation must not publish, or a revoked key keeps authenticating for a
 *   full TTL.
 * - Cached identities are frozen, because one entry is handed to many requests.
 * - A credential that expires while its entry is still inside the cache TTL is
 *   treated as a miss (timing boundary).
 *
 * The `AUTH_CACHE_*` bounds are also asserted here: they are read by
 * `getAuthCache()`, and when they were absent the cache was immortal and
 * unbounded.
 */

import { AuthCache } from './authCache';
import { ApiKeyInfo } from './apiKeys';
import { envObjectSchema } from '../config/env.schema';

function mockInfo(overrides: Partial<ApiKeyInfo> = {}): ApiKeyInfo {
  return {
    id: 'key-1',
    name: 'service-key',
    scope: ['contracts:read'],
    createdBy: 'user-1',
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    isActive: true,
    ...overrides,
  };
}

/** A promise plus its resolvers, so a test can hold a load open. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets queued microtasks/timers run so joined promises settle. */
async function settle(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe('AuthCache — single flight (INV-C1)', () => {
  let cache: AuthCache;

  beforeEach(() => {
    cache = new AuthCache({ ttlMs: 60_000, maxEntries: 100 });
  });

  it('runs the loader once for concurrent callers of the same selector', async () => {
    const gate = deferred<ApiKeyInfo | null>();
    const loader = jest.fn().mockReturnValue(gate.promise);

    const callers = Array.from({ length: 5 }, () => cache.getOrLoad('selector-1', loader));

    // The burst must have collapsed before the first load even resolves.
    expect(loader).toHaveBeenCalledTimes(1);

    const info = mockInfo();
    gate.resolve(info);
    const results = await Promise.all(callers);

    expect(results).toHaveLength(5);
    results.forEach((result) => expect(result).toEqual(info));
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('serves subsequent calls from the cache without re-running the loader', async () => {
    const loader = jest.fn().mockResolvedValue(mockInfo());

    await cache.getOrLoad('selector-1', loader);
    await cache.getOrLoad('selector-1', loader);

    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('collapses concurrent callers of distinct selectors independently', async () => {
    const loader = jest.fn().mockImplementation(async (id: string) => mockInfo({ id }));

    await Promise.all([
      cache.getOrLoad('selector-1', () => loader('a')),
      cache.getOrLoad('selector-1', () => loader('a')),
      cache.getOrLoad('selector-2', () => loader('b')),
    ]);

    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('does not cache a rejected credential, but still shares the single load', async () => {
    const gate = deferred<ApiKeyInfo | null>();
    const loader = jest.fn().mockReturnValue(gate.promise);

    const callers = Array.from({ length: 3 }, () => cache.getOrLoad('selector-1', loader));
    expect(loader).toHaveBeenCalledTimes(1);

    gate.resolve(null);
    await expect(Promise.all(callers)).resolves.toEqual([null, null, null]);

    // A rejected credential must be re-checked, not pinned for a TTL.
    expect(cache.get('selector-1')).toBeNull();
    await cache.getOrLoad('selector-1', loader);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('rejects every joined caller when the loader fails, then retries on the next call', async () => {
    const failure = new Error('store unavailable');
    const loader = jest.fn().mockRejectedValue(failure);

    const callers = Array.from({ length: 3 }, () => cache.getOrLoad('selector-1', loader));
    await expect(Promise.all(callers)).rejects.toThrow('store unavailable');
    expect(loader).toHaveBeenCalledTimes(1);

    // The in-flight entry must have been cleared, so this is a fresh attempt.
    loader.mockResolvedValue(mockInfo());
    await expect(cache.getOrLoad('selector-1', loader)).resolves.toEqual(mockInfo());
    expect(loader).toHaveBeenCalledTimes(2);
  });
});

describe('AuthCache — no stale repopulation (INV-C2)', () => {
  let cache: AuthCache;

  beforeEach(() => {
    cache = new AuthCache({ ttlMs: 60_000, maxEntries: 100 });
  });

  it('does not publish a load that resolves after its selector was invalidated', async () => {
    const gate = deferred<ApiKeyInfo | null>();
    const loader = jest.fn().mockReturnValue(gate.promise);

    const inFlight = cache.getOrLoad('selector-1', loader);
    await settle(1);

    // A concurrent revoke lands while the load is in flight.
    cache.invalidate('selector-1');

    const revokedButResolved = mockInfo();
    gate.resolve(revokedButResolved);

    // The request that started before the revoke still gets its answer ...
    await expect(inFlight).resolves.toEqual(revokedButResolved);
    // ... but the pre-revocation identity must not be cached.
    expect(cache.get('selector-1')).toBeNull();
  });

  it('does not publish a load that resolves after a user-wide invalidation', async () => {
    const gate = deferred<ApiKeyInfo | null>();
    const loader = jest.fn().mockReturnValue(gate.promise);

    const inFlight = cache.getOrLoad('selector-1', loader);
    await settle(1);

    cache.invalidateByUserId('user-1');
    gate.resolve(mockInfo({ createdBy: 'user-1' }));

    await inFlight;
    expect(cache.get('selector-1')).toBeNull();
  });

  it('does not publish a load that resolves after a full clear', async () => {
    const gate = deferred<ApiKeyInfo | null>();
    const loader = jest.fn().mockReturnValue(gate.promise);

    const inFlight = cache.getOrLoad('selector-1', loader);
    await settle(1);

    cache.clear();
    gate.resolve(mockInfo());

    await inFlight;
    expect(cache.get('selector-1')).toBeNull();
  });

  it('still publishes a load when no invalidation intervened', async () => {
    const loader = jest.fn().mockResolvedValue(mockInfo());

    await cache.getOrLoad('selector-1', loader);
    expect(cache.get('selector-1')).toEqual(mockInfo());
  });
});

describe('AuthCache — identity immutability', () => {
  it('freezes cached identities so one request cannot rewrite another view', () => {
    const cache = new AuthCache({ ttlMs: 60_000, maxEntries: 10 });
    const info = mockInfo();

    cache.set('selector-1', info);
    const retrieved = cache.get('selector-1');

    expect(retrieved).not.toBeNull();
    expect(Object.isFrozen(retrieved)).toBe(true);

    // Best-effort mutation; strict mode throws, sloppy mode is a silent no-op.
    try {
      (retrieved as ApiKeyInfo).isActive = false;
      (retrieved as ApiKeyInfo).scope = ['*'];
    } catch {
      /* strict mode: frozen write throws, which is the desired failure */
    }

    expect(cache.get('selector-1')?.isActive).toBe(true);
    expect(cache.get('selector-1')?.scope).toEqual(['contracts:read']);
  });
});

describe('AuthCache — credential expiry is a timing boundary', () => {
  it('treats a cached identity whose credential expired as a miss and reloads', async () => {
    const cache = new AuthCache({ ttlMs: 60_000, maxEntries: 10 });
    cache.set(
      'selector-1',
      mockInfo({ expiresAt: new Date(Date.now() - 1_000) })
    );

    const fresh = mockInfo({ expiresAt: new Date(Date.now() + 60_000) });
    const loader = jest.fn().mockResolvedValue(fresh);

    await expect(cache.getOrLoad('selector-1', loader)).resolves.toEqual(fresh);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(cache.get('selector-1')).toEqual(fresh);
  });

  it('keeps serving an identity whose credential is still valid', async () => {
    const cache = new AuthCache({ ttlMs: 60_000, maxEntries: 10 });
    const valid = mockInfo({ expiresAt: new Date(Date.now() + 60_000) });
    cache.set('selector-1', valid);

    const loader = jest.fn().mockResolvedValue(mockInfo({ id: 'should-not-be-used' }));

    await expect(cache.getOrLoad('selector-1', loader)).resolves.toEqual(valid);
    expect(loader).not.toHaveBeenCalled();
  });
});

describe('AUTH_CACHE_* environment bounds', () => {
  it('provides finite, bounded defaults for TTL and capacity', () => {
    const ttl = envObjectSchema.shape.AUTH_CACHE_TTL_MS.parse(undefined);
    const maxEntries = envObjectSchema.shape.AUTH_CACHE_MAX_ENTRIES.parse(undefined);

    // Before these keys existed, `getAuthCache()` received `undefined` for both:
    // `Date.now() + undefined` is NaN (never past, so entries never expired) and
    // `size >= undefined` is always false (so nothing was ever evicted).
    expect(Number.isFinite(ttl)).toBe(true);
    expect(ttl).toBeGreaterThan(0);
    expect(Number.isFinite(maxEntries)).toBe(true);
    expect(maxEntries).toBeGreaterThan(0);
  });

  it('honours explicit values and rejects out-of-range ones', () => {
    expect(envObjectSchema.shape.AUTH_CACHE_TTL_MS.parse('1000')).toBe(1000);
    expect(envObjectSchema.shape.AUTH_CACHE_MAX_ENTRIES.parse('50')).toBe(50);

    expect(() => envObjectSchema.shape.AUTH_CACHE_TTL_MS.parse('0')).toThrow();
    expect(() => envObjectSchema.shape.AUTH_CACHE_MAX_ENTRIES.parse('-1')).toThrow();
    expect(() => envObjectSchema.shape.AUTH_CACHE_TTL_MS.parse('999999999')).toThrow();
  });
});
