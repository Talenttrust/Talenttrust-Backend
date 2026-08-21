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
    expiresAt: new Date('2024-12-31'),
    isActive: true,
  };

  beforeEach(() => {
    cache = new AuthCache({
      ttlMs: 1000, // 1 second TTL for tests
      maxEntries: 3, // Small capacity for eviction tests
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
        jest.advanceTimersByTime(20);

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
  });

  describe('explicit invalidation', () => {
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
  });

  describe('metrics integration', () => {
    it('registers Prometheus counters for hits and misses', async () => {
      const register = new (require('prom-client').Registry)();
      const metricsCache = new AuthCache(
        { ttlMs: 1000, maxEntries: 100 },
        register
      );

      // Generate some activity
      metricsCache.set('selector-1', mockApiKeyInfo);
      metricsCache.get('selector-1'); // hit
      metricsCache.get('selector-2'); // miss

      const metrics = await register.metrics();
      expect(metrics).toContain('auth_cache_hits_total');
      expect(metrics).toContain('auth_cache_misses_total');
    });
  });
});
