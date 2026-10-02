/**
 * @file authCache.test.ts
 * @description Comprehensive tests for auth cache functionality.
 *
 * Covers:
 * - Cache hits and misses
 * - TTL-based expiration
 * - LRU eviction when capacity is reached
 * - Explicit invalidation (by selector and user ID)
 * - Cold cache scenarios
 * - Metrics tracking
 * - State invariants (defensive copies, input validation, bounded size)
 */

import { AuthCache } from './authCache';
import { ApiKeyInfo } from './apiKeys';

describe('AuthCache', () => {
  let cache: AuthCache;
  const mockApiKeyInfo: ApiKeyInfo = {
    id: 'key-1',
    name: 'Test Key',
    scope: ['contracts:read'],
    createdBy: 'user-1',
    createdAt: new Date('2024-01-01'),
    expiresAt: new Date('2030-12-31'),
    isActive: true,
  };

  beforeEach(() => {
    cache = new AuthCache({
      ttlMs: 1000, // 1 second TTL for tests
      maxEntries: 3, // Small capacity for eviction tests
    });
  });

  describe('configuration boundaries', () => {
    it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid ttlMs %s', (ttlMs) => {
      expect(() => new AuthCache({ ttlMs, maxEntries: 1 })).toThrow(RangeError);
    });

    it.each([0, -1, 1.5, Number.NaN])('rejects invalid maxEntries %s', (maxEntries) => {
      expect(() => new AuthCache({ ttlMs: 100, maxEntries })).toThrow(RangeError);
    });
  });

  describe('cache hits and misses', () => {
    it('returns null on cache miss', () => {
      const result = cache.get('non-existent-selector');
      expect(result).toBeNull();
    });

    it('returns cached value on cache hit', () => {
      cache.set('selector-1', mockApiKeyInfo);
      const result = cache.get('selector-1');
      expect(result).toEqual(mockApiKeyInfo);
    });

    it('increments miss counter on cache miss', () => {
      const statsBefore = cache.getStats();
      cache.get('non-existent-selector');
      const statsAfter = cache.getStats();
      expect(statsAfter.misses).toBe(statsBefore.misses + 1);
    });

    it('increments hit counter on cache hit', () => {
      cache.set('selector-1', mockApiKeyInfo);
      const statsBefore = cache.getStats();
      cache.get('selector-1');
      const statsAfter = cache.getStats();
      expect(statsAfter.hits).toBe(statsBefore.hits + 1);
    });

    it('does not increment hit counter on expired entry', () => {
      jest.useFakeTimers();
      try {
        const shortTtlCache = new AuthCache({ ttlMs: 10, maxEntries: 100 });
        shortTtlCache.set('selector-1', mockApiKeyInfo);

        // Wait for expiration
        jest.advanceTimersBy(20);

        const statsBefore = shortTtlCache.getStats();
        const result = shortTtlCache.get('selector-1');
        const statsAfter = shortTtlCache.getStats();

        expect(result).toBeNull();
        expect(statsAfter.misses).toBe(statsBefore.misses + 1);
        expect(statsAfter.hits).toBe(statsBefore.hits);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('TTL-based expiration', () => {
    it('expires an entry exactly at the TTL deadline', () => {
      jest.useFakeTimers();
      try {
        const deadlineCache = new AuthCache({ ttlMs: 100, maxEntries: 1 });
        deadlineCache.set('selector-1', mockApiKeyInfo);

        jest.advanceTimersByTime(100);

        expect(deadlineCache.get('selector-1')).toBeNull();
        expect(deadlineCache.cleanupExpired()).toBe(0);
      } finally {
        jest.useRealTimers();
      }
    });

    it('expires an entry at the API key deadline even when cache TTL is longer', () => {
      jest.useFakeTimers();
      try {
        const keyExpiresAt = new Date(Date.now() + 100);
        const keyExpiryCache = new AuthCache({ ttlMs: 1000, maxEntries: 1 });
        keyExpiryCache.set('selector-1', { ...mockApiKeyInfo, expiresAt: keyExpiresAt });

        jest.advanceTimersByTime(100);

        expect(keyExpiryCache.get('selector-1')).toBeNull();
      } finally {
        jest.useRealTimers();
      }
    });

    it('expires entries after TTL', () => {
      const shortTtlCache = new AuthCache({ ttlMs: 100, maxEntries: 100 });
      shortTtlCache.set('selector-1', mockApiKeyInfo);

      // Entry should be available before TTL
      expect(shortTtlCache.get('selector-1')).toEqual(mockApiKeyInfo);

      // Wait for expiration
      const startTime = Date.now();
      while (Date.now() - startTime < 150) {
        // busy wait
      }

      // Entry should be expired
      expect(shortTtlCache.get('selector-1')).toBeNull();
    });

    it('updates last accessed time on get (for LRU, not TTL)', () => {
      const shortTtlCache = new AuthCache({ ttlMs: 500, maxEntries: 100 });
      shortTtlCache.set('selector-1', mockApiKeyInfo);

      // Wait 300ms
      const startTime = Date.now();
      while (Date.now() - startTime < 300) {
        // busy wait
      }

      // Access the entry - this updates lastAccessed for LRU but does NOT refresh TTL
      expect(shortTtlCache.get('selector-1')).toEqual(mockApiKeyInfo);

      // Wait another 250ms (total 550ms from set, past TTL)
      const startTime2 = Date.now();
      while (Date.now() - startTime2 < 250) {
        // busy wait
      }

      // Entry should be expired (TTL is from creation time, not last access)
      expect(shortTtlCache.get('selector-1')).toBeNull();
    });

    it('cleanupExpired removes expired entries', () => {
      const shortTtlCache = new AuthCache({ ttlMs: 50, maxEntries: 100 });
      shortTtlCache.set('selector-1', mockApiKeyInfo);
      shortTtlCache.set('selector-2', mockApiKeyInfo);
      shortTtlCache.set('selector-3', mockApiKeyInfo);

      expect(shortTtlCache.getStats().size).toBe(3);

      // Wait for expiration
      const startTime = Date.now();
      while (Date.now() - startTime < 100) {
        // busy wait
      }

      const cleaned = shortTtlCache.cleanupExpired();
      expect(cleaned).toBe(3);
      expect(shortTtlCache.getStats().size).toBe(0);
    });

    it('cleanupExpired only removes expired entries', () => {
      const shortTtlCache = new AuthCache({ ttlMs: 100, maxEntries: 100 });
      shortTtlCache.set('selector-1', mockApiKeyInfo);

      // Wait 50ms (not past TTL)
      const startTime = Date.now();
      while (Date.now() - startTime < 50) {
        // busy wait
      }

      // Add another entry
      shortTtlCache.set('selector-2', mockApiKeyInfo);

      const cleaned = shortTtlCache.cleanupExpired();
      expect(cleaned).toBe(0);
      expect(shortTtlCache.getStats().size).toBe(2);
    });
  });

  describe('LRU eviction', () => {
    it('evicts an empty-string selector when it is the least recently used', () => {
      const singleEntryCache = new AuthCache({ ttlMs: 1000, maxEntries: 1 });
      singleEntryCache.set('', mockApiKeyInfo);

      singleEntryCache.set('selector-2', mockApiKeyInfo);

      expect(singleEntryCache.getStats().size).toBe(1);
      expect(singleEntryCache.get('')).toBeNull();
      expect(singleEntryCache.get('selector-2')).not.toBeNull();
    });

    it('evicts least recently used entry when capacity is reached', () => {
      // Fill cache to capacity
      cache.set('selector-1', { ...mockApiKeyInfo, id: 'key-1' });
      cache.set('selector-2', { ...mockApiKeyInfo, id: 'key-2' });
      cache.set('selector-3', { ...mockApiKeyInfo, id: 'key-3' });

      expect(cache.getStats().size).toBe(3);

      // Add a fourth entry (should evict one entry)
      cache.set('selector-4', { ...mockApiKeyInfo, id: 'key-4' });

      expect(cache.getStats().size).toBe(3);
      // One of the first three should be evicted
      const presentCount = [cache.get('selector-1'), cache.get('selector-2'), cache.get('selector-3')].filter(x => x !== null).length;
      expect(presentCount).toBe(2);
      expect(cache.get('selector-4')).not.toBeNull(); // New entry
    });

    it('updates existing entry without eviction', () => {
      cache.set('selector-1', { ...mockApiKeyInfo, id: 'key-1' });
      cache.set('selector-2', { ...mockApiKeyInfo, id: 'key-2' });
      cache.set('selector-3', { ...mockApiKeyInfo, id: 'key-3' });

      // Update an existing entry
      cache.set('selector-1', { ...mockApiKeyInfo, id: 'key-1-updated' });

      expect(cache.getStats().size).toBe(3);
      expect(cache.get('selector-1')?.id).toBe('key-1-updated');
    });

    it('evicts the least recently accessed entry when at capacity', () => {
      cache.set('selector-1', { ...mockApiKeyInfo, id: 'key-1' });
      cache.set('selector-2', { ...mockApiKeyInfo, id: 'key-2' });
      cache.set('selector-3', { ...mockApiKeyInfo, id: 'key-3' });

      // Access selector-1 and selector-2 so selector-3 is the LRU
      cache.get('selector-1');
      cache.get('selector-2');

      cache.set('selector-4', { ...mockApiKeyInfo, id: 'key-4' });

      expect(cache.get('selector-3')).toBeNull();
      expect(cache.get('selector-1')).not.toBeNull();
      expect(cache.get('selector-2')).not.toBeNull();
      expect(cache.get('selector-4')).not.toBeNull();
    });

    it('never exceeds maxEntries under repeated inserts', () => {
      for (let i = 0; i < 50; i++) {
        cache.set(`selector-${i}`, { ...mockApiKeyInfo, id: `key-${i}` });
        expect(cache.getStats().size).toBeLessThanOrEqual(3);
      }
    });
  });

  describe('explicit invalidation', () => {
    it('does not accept a delayed cache fill from before invalidation', () => {
      const generation = cache.getGeneration();

      cache.invalidateByUserId('user-1');
      cache.set('selector-1', mockApiKeyInfo, generation);

      expect(cache.get('selector-1')).toBeNull();
    });

    it('invalidates entry by selector', () => {
      cache.set('selector-1', mockApiKeyInfo);
      cache.set('selector-2', mockApiKeyInfo);

      cache.invalidate('selector-1');

      expect(cache.get('selector-1')).toBeNull();
      expect(cache.get('selector-2')).not.toBeNull();
    });

    it('invalidates all entries for a user ID', () => {
      const user1Key1: ApiKeyInfo = { ...mockApiKeyInfo, id: 'key-1', createdBy: 'user-1' };
      const user1Key2: ApiKeyInfo = { ...mockApiKeyInfo, id: 'key-2', createdBy: 'user-1' };
      const user2Key1: ApiKeyInfo = { ...mockApiKeyInfo, id: 'key-3', createdBy: 'user-2' };

      cache.set('selector-1', user1Key1);
      cache.set('selector-2', user1Key2);
      cache.set('selector-3', user2Key1);

      cache.invalidateByUserId('user-1');

      expect(cache.get('selector-1')).toBeNull();
      expect(cache.get('selector-2')).toBeNull();
      expect(cache.get('selector-3')).not.toBeNull();
    });

    it('clears all entries', () => {
      cache.set('selector-1', mockApiKeyInfo);
      cache.set('selector-2', mockApiKeyInfo);
      cache.set('selector-3', mockApiKeyInfo);

      cache.clear();

      expect(cache.getStats().size).toBe(0);
      expect(cache.get('selector-1')).toBeNull();
      expect(cache.get('selector-2')).toBeNull();
      expect(cache.get('selector-3')).toBeNull();
    });

    it('repeated invalidation is idempotent', () => {
      cache.set('selector-1', mockApiKeyInfo);
      cache.invalidate('selector-1');
      expect(() => cache.invalidate('selector-1')).not.toThrow();
      expect(cache.getStats().size).toBe(0);
    });
  });

  describe('cold cache scenarios', () => {
    it('handles empty cache gracefully', () => {
      const emptyCache = new AuthCache({ ttlMs: 1000, maxEntries: 100 });

      expect(emptyCache.getStats().size).toBe(0);
      expect(emptyCache.getStats().hits).toBe(0);
      expect(emptyCache.getStats().misses).toBe(0);

      expect(emptyCache.get('any-selector')).toBeNull();
      expect(emptyCache.getStats().misses).toBe(1);
    });

    it('first access after cache creation is a miss', () => {
      const statsBefore = cache.getStats();
      cache.get('selector-1');
      const statsAfter = cache.getStats();

      expect(statsAfter.misses).toBe(statsBefore.misses + 1);
      expect(statsAfter.hits).toBe(statsBefore.hits);
    });

    it('populates cache on first set', () => {
      expect(cache.getStats().size).toBe(0);

      cache.set('selector-1', mockApiKeyInfo);

      expect(cache.getStats().size).toBe(1);
      expect(cache.get('selector-1')).toEqual(mockApiKeyInfo);
    });
  });

  describe('cache statistics', () => {
    it('returns accurate cache size', () => {
      expect(cache.getStats().size).toBe(0);

      cache.set('selector-1', mockApiKeyInfo);
      expect(cache.getStats().size).toBe(1);

      cache.set('selector-2', mockApiKeyInfo);
      expect(cache.getStats().size).toBe(2);

      cache.invalidate('selector-1');
      expect(cache.getStats().size).toBe(1);
    });

    it('tracks hit and miss counts accurately', () => {
      cache.set('selector-1', mockApiKeyInfo);

      // 3 hits
      cache.get('selector-1');
      cache.get('selector-1');
      cache.get('selector-1');

      // 2 misses
      cache.get('selector-2');
      cache.get('selector-3');

      const stats = cache.getStats();
      expect(stats.hits).toBe(3);
      expect(stats.misses).toBe(2);
    });

    it('stats are monotonic across invalidation and clear', () => {
      cache.set('selector-1', mockApiKeyInfo);
      cache.get('selector-1'); // hit
      cache.get('missing'); // miss
      const before = cache.getStats();
      cache.invalidate('selector-1');
      cache.clear();
      const after = cache.getStats();
      expect(after.hits).toBeGreaterThanOrEqual(before.hits);
      expect(after.misses).toBeGreaterThanOrEqual(before.misses);
    });
  });

  describe('metrics integration', () => {
    it('registers Prometheus counters for hits and misses', async () => {
      const registry = new Registry();
      const metricsCache = new AuthCache(
        { ttlMs: 1000, maxEntries: 100 },
        registry
      );

      // Generate some activity
      metricsCache.set('selector-1', mockApiKeyInfo);
      metricsCache.get('selector-1'); // hit
      metricsCache.get('selector-2'); // miss

      const metrics = await registry.metrics();
      expect(metrics).toContain('auth_cache_hits_total');
      expect(metrics).toContain('auth_cache_misses_total');
    });
  });

  describe('state invariants', () => {
    it('rejects a non-empty selector requirement on get', () => {
      expect(() => cache.get('')).toThrow(TypeError);
      expect(() => cache.get(undefined as unknown as string)).toThrow(TypeError);
      expect(cache.getStats()).toEqual({ size: 0, hits: 0, misses: 0 });
    });

    it('rejects invalid info on set and leaves cache unchanged', () => {
      expect(() => cache.set('selector', null as unknown as ApiKeyInfo)).toThrow(TypeError);
      expect(() => cache.set('selector', { id: '' } as unknown as ApiKeyInfo)).toThrow(TypeError);
      expect(() => cache.set('selector', { ...mockApiKeyInfo, createdBy: '' })).toThrow(TypeError);
      expect(cache.getStats().size).toBe(0);
    });

    it('rejects invalid options', () => {
      expect(() => new AuthCache({ ttlMs: -1, maxEntries: 1 })).toThrow(TypeError);
      expect(() => new AuthCache({ ttlMs: 1000, maxEntries: 0 })).toThrow(TypeError);
      expect(() => new AuthCache({ ttlMs: NaN, maxEntries: 1 })).toThrow(TypeError);
      expect(() => new AuthCache({ ttlMs: 1000, maxEntries: 1.5 })).toThrow(TypeError);
    });

    it('returns a defensive copy from get', () => {
      cache.set('selector-1', mockApiKeyInfo);
      const first = cache.get('selector-1');
      expect(first).not.toBe(null);
      first!.scope.push('contracts:write');
      first!.isActive = false;

      const second = cache.get('selector-1');
      expect(second).not.toBe(null);
      expect(second!.scope).toEqual(['contracts:read']);
      expect(second!.isActive).toBe(true);
    });

    it('stores a defensive copy on set', () => {
      const mutable = { ...mockApiKeyInfo, scope: ['contracts:read'] };
      cache.set('selector-1', mutable);
      mutable.scope.push('contracts:write');
      mutable.isActive = false;

      const stored = cache.get('selector-1');
      expect(stored).not.toBeNull();
      expect(stored!.scope).toEqual(['contracts:read']);
      expect(stored!.isActive).toBe(true);
    });

    it('rejects invalid selector on invalidate', () => {
      expect(() => cache.invalidate('')).toThrow(TypeError);
      expect(() => cache.invalidateByUserId('')).toThrow(TypeError);
    });

    it('handles concurrent set/get interleaving without losing invariants', () => {
      const operations: Promise<void>[] = [];
      for (let i = 0; i < 20; i++) {
        operations.push(
          Promise.resolve().then(() => {
            cache.set(`selector-${i}`, { ...mockApiKeyInfo, id: `key-${i}` });
            cache.get(`selector-${i}`);
          })
        );
      }
      return Promise.all(operations).then(() => {
        expect(cache.getStats().size).toBeLessThanOrEqual(3);
      });
    });
  });
});
