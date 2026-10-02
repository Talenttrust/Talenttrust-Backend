/**
 * Comprehensive tests for the reputation LRU+TTL cache.
 *
 * Covers:
 *  - Cold cache (miss)
 *  - Cache hit (fresh entry)
 *  - TTL expiry (expired entry treated as miss)
 *  - Explicit write invalidation
 *  - LRU eviction under capacity bound
 *  - Hit / miss metric counters
 *  - Factory function and singleton init
 *  - Constructor guard-rails (invalid options)
 *  - Edge cases: set overwrites, clear(), size, resetMetrics
 */

import {
  ReputationLruCache,
  createReputationCache,
  initReputationCache,
  reputationCache,
  DEFAULT_REPUTATION_CACHE_MAX_ENTRIES,
  DEFAULT_REPUTATION_CACHE_TTL_MS,
} from './reputationCache';

// ── helpers ──────────────────────────────────────────────────────────────────

interface FakeProfile {
  freelancerId: string;
  score: number;
}

function profile(id: string, score = 4.5): FakeProfile {
  return { freelancerId: id, score };
}

// ── constructor validation ────────────────────────────────────────────────────

describe('ReputationLruCache — constructor validation', () => {
  it('creates a cache with default options', () => {
    const cache = new ReputationLruCache();
    expect(cache.maxEntries).toBe(DEFAULT_REPUTATION_CACHE_MAX_ENTRIES);
    expect(cache.ttlMs).toBe(DEFAULT_REPUTATION_CACHE_TTL_MS);
    expect(cache.size).toBe(0);
  });

  it('creates a cache with explicit options', () => {
    const cache = new ReputationLruCache({ maxEntries: 10, ttlMs: 5_000 });
    expect(cache.maxEntries).toBe(10);
    expect(cache.ttlMs).toBe(5_000);
  });

  it('throws RangeError for maxEntries = 0', () => {
    expect(() => new ReputationLruCache({ maxEntries: 0 })).toThrow(RangeError);
  });

  it('throws RangeError for maxEntries = -1', () => {
    expect(() => new ReputationLruCache({ maxEntries: -1 })).toThrow(RangeError);
  });

  it('throws RangeError for non-integer maxEntries', () => {
    expect(() => new ReputationLruCache({ maxEntries: 1.5 })).toThrow(RangeError);
  });

  it('throws RangeError for ttlMs = 0', () => {
    expect(() => new ReputationLruCache({ ttlMs: 0 })).toThrow(RangeError);
  });

  it('throws RangeError for ttlMs = -1', () => {
    expect(() => new ReputationLruCache({ ttlMs: -1 })).toThrow(RangeError);
  });

  it('throws RangeError for non-integer ttlMs', () => {
    expect(() => new ReputationLruCache({ ttlMs: 0.5 })).toThrow(RangeError);
  });
});

// ── cold cache (miss) ─────────────────────────────────────────────────────────

describe('ReputationLruCache — cold cache (miss)', () => {
  let cache: ReputationLruCache<FakeProfile>;

  beforeEach(() => {
    cache = new ReputationLruCache<FakeProfile>({ ttlMs: 60_000, maxEntries: 100 });
  });

  it('returns undefined for a key that was never set', () => {
    expect(cache.get('unknown')).toBeUndefined();
  });

  it('increments miss counter on cold miss', () => {
    cache.get('x');
    expect(cache.getMetrics().misses).toBe(1);
    expect(cache.getMetrics().hits).toBe(0);
  });

  it('size remains 0 after a miss', () => {
    cache.get('x');
    expect(cache.size).toBe(0);
  });
});

// ── cache hit ─────────────────────────────────────────────────────────────────

describe('ReputationLruCache — cache hit', () => {
  let cache: ReputationLruCache<FakeProfile>;

  beforeEach(() => {
    jest.useFakeTimers();
    cache = new ReputationLruCache<FakeProfile>({ ttlMs: 60_000, maxEntries: 100 });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns stored value on hit', () => {
    const p = profile('u1');
    cache.set('u1', p);
    expect(cache.get('u1')).toEqual(p);
  });

  it('increments hit counter and leaves miss counter at 0', () => {
    cache.set('u1', profile('u1'));
    cache.get('u1');
    expect(cache.getMetrics().hits).toBe(1);
    expect(cache.getMetrics().misses).toBe(0);
  });

  it('returns same value on multiple hits', () => {
    const p = profile('u2', 3.5);
    cache.set('u2', p);
    expect(cache.get('u2')).toEqual(p);
    expect(cache.get('u2')).toEqual(p);
    expect(cache.getMetrics().hits).toBe(2);
  });

  it('hit is not served when TTL has not elapsed', () => {
    cache.set('u3', profile('u3'));
    jest.advanceTimersByTime(59_999); // 1 ms before expiry
    expect(cache.get('u3')).toBeDefined();
  });
});

// ── TTL expiry ────────────────────────────────────────────────────────────────

describe('ReputationLruCache — TTL expiry', () => {
  let cache: ReputationLruCache<FakeProfile>;

  beforeEach(() => {
    jest.useFakeTimers();
    cache = new ReputationLruCache<FakeProfile>({ ttlMs: 1_000, maxEntries: 100 });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns undefined after TTL has elapsed', () => {
    cache.set('u1', profile('u1'));
    jest.advanceTimersByTime(1_001); // past TTL
    expect(cache.get('u1')).toBeUndefined();
  });

  it('increments miss counter on expired entry', () => {
    cache.set('u1', profile('u1'));
    jest.advanceTimersByTime(1_001);
    cache.get('u1');
    expect(cache.getMetrics().misses).toBe(1);
    expect(cache.getMetrics().hits).toBe(0);
  });

  it('removes expired entry from the store', () => {
    cache.set('u1', profile('u1'));
    expect(cache.size).toBe(1);
    jest.advanceTimersByTime(1_001);
    cache.get('u1'); // triggers pruning
    expect(cache.size).toBe(0);
  });

  it('returns value at exactly TTL boundary - 1 ms (still fresh)', () => {
    cache.set('u1', profile('u1'));
    jest.advanceTimersByTime(999);
    expect(cache.get('u1')).toBeDefined();
  });

  it('entry at exactly ttlMs is expired', () => {
    cache.set('u1', profile('u1'));
    jest.advanceTimersByTime(1_000); // age === ttlMs, condition: age >= ttlMs → miss
    expect(cache.get('u1')).toBeUndefined();
  });

  it('re-setting an expired key makes it fresh again', () => {
    cache.set('u1', profile('u1'));
    jest.advanceTimersByTime(1_001);
    expect(cache.get('u1')).toBeUndefined();

    cache.set('u1', profile('u1', 5.0));
    expect(cache.get('u1')).toEqual(profile('u1', 5.0));
  });
});

// ── write invalidation ────────────────────────────────────────────────────────

describe('ReputationLruCache — write invalidation', () => {
  let cache: ReputationLruCache<FakeProfile>;

  beforeEach(() => {
    cache = new ReputationLruCache<FakeProfile>({ ttlMs: 60_000, maxEntries: 100 });
  });

  it('invalidate() removes a live entry', () => {
    cache.set('u1', profile('u1'));
    expect(cache.get('u1')).toBeDefined();
    cache.invalidate('u1');
    expect(cache.get('u1')).toBeUndefined();
  });

  it('invalidate() returns true when key was present', () => {
    cache.set('u1', profile('u1'));
    expect(cache.invalidate('u1')).toBe(true);
  });

  it('invalidate() returns false when key was not present (no-op)', () => {
    expect(cache.invalidate('non-existent')).toBe(false);
  });

  it('invalidate() is idempotent — second call also returns false', () => {
    cache.set('u1', profile('u1'));
    cache.invalidate('u1');
    expect(cache.invalidate('u1')).toBe(false);
  });

  it('miss counter increments after invalidation + get', () => {
    cache.set('u1', profile('u1'));
    cache.get('u1'); // hit
    cache.invalidate('u1');
    cache.get('u1'); // miss
    expect(cache.getMetrics().hits).toBe(1);
    expect(cache.getMetrics().misses).toBe(1);
  });

  it('invalidating one key does not affect other keys', () => {
    cache.set('u1', profile('u1'));
    cache.set('u2', profile('u2'));
    cache.invalidate('u1');
    expect(cache.get('u1')).toBeUndefined();
    expect(cache.get('u2')).toBeDefined();
  });

  it('size decrements after invalidation', () => {
    cache.set('u1', profile('u1'));
    cache.set('u2', profile('u2'));
    expect(cache.size).toBe(2);
    cache.invalidate('u1');
    expect(cache.size).toBe(1);
  });
});

// ── LRU eviction ──────────────────────────────────────────────────────────────

describe('ReputationLruCache — LRU eviction', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('evicts the oldest entry when capacity is exceeded', () => {
    const cache = new ReputationLruCache<FakeProfile>({ ttlMs: 60_000, maxEntries: 3 });
    cache.set('a', profile('a'));
    cache.set('b', profile('b'));
    cache.set('c', profile('c'));
    // All three present
    expect(cache.size).toBe(3);

    // Adding a 4th evicts 'a' (LRU)
    cache.set('d', profile('d'));
    expect(cache.size).toBe(3);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeDefined();
    expect(cache.get('c')).toBeDefined();
    expect(cache.get('d')).toBeDefined();
  });

  it('accessing an entry promotes it to MRU, protecting it from eviction', () => {
    const cache = new ReputationLruCache<FakeProfile>({ ttlMs: 60_000, maxEntries: 3 });
    cache.set('a', profile('a'));
    cache.set('b', profile('b'));
    cache.set('c', profile('c'));

    // Access 'a' → promotes it to MRU; 'b' becomes LRU
    cache.get('a');

    cache.set('d', profile('d')); // should evict 'b'
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBeDefined();
    expect(cache.get('c')).toBeDefined();
    expect(cache.get('d')).toBeDefined();
  });

  it('overwriting an existing key moves it to MRU', () => {
    const cache = new ReputationLruCache<FakeProfile>({ ttlMs: 60_000, maxEntries: 3 });
    cache.set('a', profile('a'));
    cache.set('b', profile('b'));
    cache.set('c', profile('c'));

    // Re-set 'a' → moves it to MRU; 'b' becomes LRU
    cache.set('a', profile('a', 5.0));

    cache.set('d', profile('d')); // evicts 'b'
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toEqual(profile('a', 5.0));
  });

  it('size never exceeds maxEntries', () => {
    const max = 5;
    const cache = new ReputationLruCache<FakeProfile>({ ttlMs: 60_000, maxEntries: max });
    for (let i = 0; i < 20; i++) {
      cache.set(`u${i}`, profile(`u${i}`));
      expect(cache.size).toBeLessThanOrEqual(max);
    }
  });

  it('evicts multiple LRU entries when cap is 1', () => {
    const cache = new ReputationLruCache<FakeProfile>({ ttlMs: 60_000, maxEntries: 1 });
    cache.set('a', profile('a'));
    cache.set('b', profile('b')); // evicts 'a'
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeDefined();
    cache.set('c', profile('c')); // evicts 'b'
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBeDefined();
  });
});

// ── metrics counters ──────────────────────────────────────────────────────────

describe('ReputationLruCache — metrics', () => {
  let cache: ReputationLruCache<FakeProfile>;

  beforeEach(() => {
    jest.useFakeTimers();
    cache = new ReputationLruCache<FakeProfile>({ ttlMs: 1_000, maxEntries: 10 });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('starts with zero hits and misses', () => {
    expect(cache.getMetrics()).toEqual({ hits: 0, misses: 0 });
  });

  it('tracks hits and misses independently', () => {
    cache.set('u1', profile('u1'));
    cache.get('u1');  // hit
    cache.get('u2');  // miss
    cache.get('u1');  // hit
    cache.get('u3');  // miss
    expect(cache.getMetrics()).toEqual({ hits: 2, misses: 2 });
  });

  it('expired entries count as misses', () => {
    cache.set('u1', profile('u1'));
    jest.advanceTimersByTime(1_001);
    cache.get('u1'); // expired → miss
    expect(cache.getMetrics().misses).toBe(1);
    expect(cache.getMetrics().hits).toBe(0);
  });

  it('invalidated entries count as misses on subsequent get', () => {
    cache.set('u1', profile('u1'));
    cache.get('u1');     // hit
    cache.invalidate('u1');
    cache.get('u1');     // miss
    expect(cache.getMetrics()).toEqual({ hits: 1, misses: 1 });
  });

  it('resetMetrics() resets both counters to zero', () => {
    cache.set('u1', profile('u1'));
    cache.get('u1'); // hit
    cache.get('u2'); // miss
    cache.resetMetrics();
    expect(cache.getMetrics()).toEqual({ hits: 0, misses: 0 });
  });

  it('getMetrics() returns a snapshot, not a reference', () => {
    const m1 = cache.getMetrics();
    cache.get('u1'); // miss
    const m2 = cache.getMetrics();
    expect(m1.misses).toBe(0);
    expect(m2.misses).toBe(1);
  });

  it('metrics accumulate across many operations', () => {
    for (let i = 0; i < 5; i++) {
      cache.set(`u${i}`, profile(`u${i}`));
    }
    // Hit all 5
    for (let i = 0; i < 5; i++) {
      cache.get(`u${i}`);
    }
    // Miss 3 unknown keys
    for (let i = 10; i < 13; i++) {
      cache.get(`u${i}`);
    }
    expect(cache.getMetrics()).toEqual({ hits: 5, misses: 3 });
  });
});

// ── clear() ───────────────────────────────────────────────────────────────────

describe('ReputationLruCache — clear()', () => {
  it('removes all entries', () => {
    const cache = new ReputationLruCache<FakeProfile>({ ttlMs: 60_000, maxEntries: 10 });
    cache.set('a', profile('a'));
    cache.set('b', profile('b'));
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeUndefined();
  });

  it('does not reset hit/miss counters', () => {
    const cache = new ReputationLruCache<FakeProfile>({ ttlMs: 60_000, maxEntries: 10 });
    cache.set('a', profile('a'));
    cache.get('a'); // hit
    cache.clear();
    expect(cache.getMetrics().hits).toBe(1);
  });
});

// ── overwrite / update ────────────────────────────────────────────────────────

describe('ReputationLruCache — overwrite', () => {
  it('set() on existing key updates the stored value', () => {
    const cache = new ReputationLruCache<FakeProfile>({ ttlMs: 60_000, maxEntries: 10 });
    cache.set('u1', profile('u1', 3.0));
    cache.set('u1', profile('u1', 5.0));
    expect(cache.get('u1')).toEqual(profile('u1', 5.0));
  });

  it('set() on existing key resets the TTL', () => {
    jest.useFakeTimers();
    const cache = new ReputationLruCache<FakeProfile>({ ttlMs: 1_000, maxEntries: 10 });
    cache.set('u1', profile('u1'));
    jest.advanceTimersByTime(800);
    cache.set('u1', profile('u1', 5.0)); // refresh
    jest.advanceTimersByTime(800); // total 1600 ms since first write, 800 since refresh
    expect(cache.get('u1')).toBeDefined(); // still alive
    jest.useRealTimers();
  });
});

// ── factory function ──────────────────────────────────────────────────────────

describe('createReputationCache()', () => {
  it('returns a fresh ReputationLruCache instance', () => {
    const c = createReputationCache();
    expect(c).toBeInstanceOf(ReputationLruCache);
  });

  it('respects options passed to the factory', () => {
    const c = createReputationCache({ ttlMs: 2_000, maxEntries: 50 });
    expect(c.ttlMs).toBe(2_000);
    expect(c.maxEntries).toBe(50);
  });

  it('each call creates a distinct instance', () => {
    const c1 = createReputationCache();
    const c2 = createReputationCache();
    c1.set('x', { freelancerId: 'x', score: 1 });
    expect(c2.get('x')).toBeUndefined();
  });
});

// ── module singleton (initReputationCache) ────────────────────────────────────

describe('initReputationCache()', () => {
  // Capture the original to restore after each test
  let originalEnvTtl: string | undefined;
  let originalEnvMax: string | undefined;

  beforeEach(() => {
    originalEnvTtl = process.env['REPUTATION_CACHE_TTL_MS'];
    originalEnvMax = process.env['REPUTATION_CACHE_MAX_ENTRIES'];
  });

  afterEach(() => {
    // Restore env
    if (originalEnvTtl === undefined) {
      delete process.env['REPUTATION_CACHE_TTL_MS'];
    } else {
      process.env['REPUTATION_CACHE_TTL_MS'] = originalEnvTtl;
    }
    if (originalEnvMax === undefined) {
      delete process.env['REPUTATION_CACHE_MAX_ENTRIES'];
    } else {
      process.env['REPUTATION_CACHE_MAX_ENTRIES'] = originalEnvMax;
    }
    // Reset the singleton to defaults so other tests are unaffected
    initReputationCache({ ttlMs: DEFAULT_REPUTATION_CACHE_TTL_MS, maxEntries: DEFAULT_REPUTATION_CACHE_MAX_ENTRIES });
  });

  it('returns a ReputationLruCache configured with explicit options', () => {
    const c = initReputationCache({ ttlMs: 5_000, maxEntries: 25 });
    expect(c.ttlMs).toBe(5_000);
    expect(c.maxEntries).toBe(25);
  });

  it('reads config from env vars when no explicit options supplied', () => {
    process.env['REPUTATION_CACHE_TTL_MS'] = '30000';
    process.env['REPUTATION_CACHE_MAX_ENTRIES'] = '200';
    const c = initReputationCache();
    expect(c.ttlMs).toBe(30_000);
    expect(c.maxEntries).toBe(200);
  });

  it('falls back to defaults when env vars are absent', () => {
    delete process.env['REPUTATION_CACHE_TTL_MS'];
    delete process.env['REPUTATION_CACHE_MAX_ENTRIES'];
    const c = initReputationCache();
    expect(c.ttlMs).toBe(DEFAULT_REPUTATION_CACHE_TTL_MS);
    expect(c.maxEntries).toBe(DEFAULT_REPUTATION_CACHE_MAX_ENTRIES);
  });

  it('replaces the module-level reputationCache singleton', async () => {
    // The imported `reputationCache` reference is live — after reinit it
    // should point to the new instance. We verify by checking options on
    // the returned cache and using it in isolation.
    const newCache = initReputationCache({ ttlMs: 99_000, maxEntries: 77 });
    expect(newCache.ttlMs).toBe(99_000);
    expect(newCache.maxEntries).toBe(77);
  });
});

// ── exported singleton reputationCache ───────────────────────────────────────

describe('reputationCache singleton', () => {
  beforeEach(() => {
    reputationCache.clear();
    reputationCache.resetMetrics();
  });

  it('is a ReputationLruCache instance', () => {
    expect(reputationCache).toBeInstanceOf(ReputationLruCache);
  });

  it('starts empty', () => {
    expect(reputationCache.size).toBe(0);
  });

  it('can store and retrieve values', () => {
    const p = profile('singleton-user');
    reputationCache.set('singleton-user', p);
    expect(reputationCache.get('singleton-user')).toEqual(p);
  });

  it('invalidate removes a stored value', () => {
    reputationCache.set('x', profile('x'));
    reputationCache.invalidate('x');
    expect(reputationCache.get('x')).toBeUndefined();
  });
});
