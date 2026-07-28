/**
 * Tests for CacheService with TTL and LRU eviction.
 *
 * Tests cover:
 * - TTL expiry: entries expire after configured TTL
 * - LRU eviction: least-recently-used entries are evicted when max is reached
 * - Invalidation patterns: glob patterns correctly match and invalidate keys
 */

import { CacheService } from './cacheService';
import type { CacheConfig } from '../config/cache';

describe('CacheService', () => {
  let config: CacheConfig;
  let evictionCallbacks: { key: string; reason: string }[];

  beforeEach(() => {
    config = {
      contractsTtlMs: 10000, // 10 second TTL
      contractsMaxEntries: 5,
    };
    evictionCallbacks = [];
  });

  describe('Get and Set', () => {
    it('stores and retrieves values', () => {
      const cache = new CacheService(config);
      cache.set('key1', { value: 'data1' });
      expect(cache.get('key1')).toEqual({ value: 'data1' });
    });

    it('returns undefined for missing keys', () => {
      const cache = new CacheService(config);
      expect(cache.get('nonexistent')).toBeUndefined();
    });

    it('overwrites existing keys', () => {
      const cache = new CacheService(config);
      cache.set('key1', 'value1');
      cache.set('key1', 'value2');
      expect(cache.get('key1')).toBe('value2');
    });
  });

  describe('TTL expiry', () => {
    it('treats expired entries as misses', (done) => {
      const fastConfig: CacheConfig = {
        contractsTtlMs: 100, // 100ms TTL
        contractsMaxEntries: 10,
      };

      const cache = new CacheService(fastConfig);
      cache.set('key1', 'value1');

      // Should be in cache
      expect(cache.get('key1')).toBe('value1');

      // After TTL elapses, should be gone
      setTimeout(() => {
        expect(cache.get('key1')).toBeUndefined();
        done();
      }, 150); // Wait longer than TTL
    });

    it('returns undefined for expired entries and removes them', (done) => {
      const fastConfig: CacheConfig = {
        contractsTtlMs: 100,
        contractsMaxEntries: 10,
      };

      const cache = new CacheService(fastConfig, {
        onEvicted: (key, reason) => {
          evictionCallbacks.push({ key, reason });
        },
      });

      cache.set('key1', 'value1');
      expect(cache.size()).toBe(1);

      setTimeout(() => {
        expect(cache.get('key1')).toBeUndefined(); // Triggers removal
        expect(cache.size()).toBe(0);
        done();
      }, 150);
    });
  });

  describe('LRU eviction', () => {
    it('evicts least-recently-used entry when max is exceeded', () => {
      const cache = new CacheService(
        { contractsTtlMs: 10000, contractsMaxEntries: 3 },
        {
          onEvicted: (key, reason) => {
            if (reason === 'evicted') {
              evictionCallbacks.push({ key, reason });
            }
          },
        },
      );

      // Fill cache
      cache.set('key1', 'value1');
      cache.set('key2', 'value2');
      cache.set('key3', 'value3');
      expect(cache.size()).toBe(3);

      // Add a 4th entry (should evict LRU, which is key1)
      cache.set('key4', 'value4');
      expect(cache.size()).toBe(3);
      expect(cache.get('key1')).toBeUndefined();
      expect(cache.get('key2')).toBe('value2');
    });

    it('updates LRU order on get', () => {
      const cache = new CacheService(
        { contractsTtlMs: 10000, contractsMaxEntries: 2 },
        {
          onEvicted: (key, reason) => {
            if (reason === 'evicted') {
              evictionCallbacks.push({ key, reason });
            }
          },
        },
      );

      cache.set('key1', 'value1');
      cache.set('key2', 'value2');

      // Access key1 (makes it recently used)
      cache.get('key1');

      // Add a 3rd entry (should evict key2, not key1, because key1 was accessed)
      cache.set('key3', 'value3');
      expect(cache.get('key1')).toBe('value1');
      expect(cache.get('key2')).toBeUndefined();
      expect(cache.get('key3')).toBe('value3');
    });
  });

  describe('Invalidation', () => {
    it('invalidates specific keys', () => {
      const cache = new CacheService(config, {
        onEvicted: (key, reason) => {
          evictionCallbacks.push({ key, reason });
        },
      });

      cache.set('contracts:single:id1', { id: 'id1' });
      cache.set('contracts:single:id2', { id: 'id2' });

      cache.invalidateKey('contracts:single:id1');

      expect(cache.get('contracts:single:id1')).toBeUndefined();
      expect(cache.get('contracts:single:id2')).toEqual({ id: 'id2' });
    });

    it('invalidates keys matching glob patterns', () => {
      const cache = new CacheService(config, {
        onEvicted: (key, reason) => {
          evictionCallbacks.push({ key, reason });
        },
      });

      cache.set('contracts:page:limit_10_cursor_abc', 'page1');
      cache.set('contracts:page:limit_10_cursor_def', 'page2');
      cache.set('contracts:list', 'list');
      cache.set('contracts:stats', 'stats');

      // Invalidate all page cache entries
      cache.invalidatePattern('contracts:page:**');

      expect(cache.get('contracts:page:limit_10_cursor_abc')).toBeUndefined();
      expect(cache.get('contracts:page:limit_10_cursor_def')).toBeUndefined();
      expect(cache.get('contracts:list')).toBe('list');
      expect(cache.get('contracts:stats')).toBe('stats');
    });

    it('invalidates with single asterisk pattern', () => {
      const cache = new CacheService(config);

      cache.set('contracts:single:id1', 'contract1');
      cache.set('contracts:single:id2', 'contract2');
      cache.set('contracts:stats', 'stats');

      // Single * matches anything except :
      cache.invalidatePattern('contracts:single:*');

      expect(cache.get('contracts:single:id1')).toBeUndefined();
      expect(cache.get('contracts:single:id2')).toBeUndefined();
      expect(cache.get('contracts:stats')).toBe('stats');
    });

    it('calls onEvicted callback for invalidated keys', () => {
      const cache = new CacheService(config, {
        onEvicted: (key, reason) => {
          evictionCallbacks.push({ key, reason });
        },
      });

      cache.set('key1', 'value1');
      cache.invalidateKey('key1');

      expect(evictionCallbacks).toContainEqual({ key: 'key1', reason: 'invalidated' });
    });
  });

  describe('Metrics', () => {
    it('calls onHit callback on cache hits', () => {
      let hits = 0;
      let misses = 0;

      const cache = new CacheService(config, {
        onHit: () => { hits++; },
        onMiss: () => { misses++; },
      });

      cache.set('key1', 'value1');
      cache.get('key1'); // Hit
      cache.get('key1'); // Hit
      cache.get('nonexistent'); // Miss

      expect(hits).toBe(2);
      expect(misses).toBe(1);
    });

    it('reports cache size', () => {
      const cache = new CacheService(config);
      expect(cache.size()).toBe(0);

      cache.set('key1', 'value1');
      expect(cache.size()).toBe(1);

      cache.set('key2', 'value2');
      expect(cache.size()).toBe(2);

      cache.invalidateKey('key1');
      expect(cache.size()).toBe(1);
    });
  });

  describe('Clear', () => {
    it('clears all entries', () => {
      const cache = new CacheService(config);
      cache.set('key1', 'value1');
      cache.set('key2', 'value2');
      cache.set('key3', 'value3');
      expect(cache.size()).toBe(3);

      cache.clear();
      expect(cache.size()).toBe(0);
      expect(cache.get('key1')).toBeUndefined();
    });
  });

  describe('Edge cases', () => {
    it('handles invalidating non-existent keys gracefully', () => {
      const cache = new CacheService(config);
      expect(() => cache.invalidateKey('nonexistent')).not.toThrow();
    });

    it('handles invalidating with empty pattern', () => {
      const cache = new CacheService(config);
      cache.set('key1', 'value1');
      expect(() => cache.invalidatePattern('')).not.toThrow();
    });

    it('supports storing null and undefined values', () => {
      const cache = new CacheService(config);
      cache.set('key1', null);
      cache.set('key2', undefined);

      // Note: undefined is treated as "not in cache" by design
      // This is consistent with CacheService.get returning undefined for misses
      expect(cache.get('key2')).toBeUndefined();
      // null is a real value, so it should be cached
      expect(cache.get('key1')).toBeNull();
    });
  });
});
