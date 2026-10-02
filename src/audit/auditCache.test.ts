/**
 * @module audit/auditCache.test
 * @description Unit tests for AuditCache.
 */

import { AuditCache } from './auditCache';
import type { AuditEntry, AuditQuery, AuditQueryResult } from './types';
import { Registry } from 'prom-client';

describe('AuditCache', () => {
  let cache: AuditCache;
  let registry: Registry;

  beforeEach(() => {
    registry = new Registry();
    cache = new AuditCache(
      {
        ttlMs: 1000,
        maxEntries: 10,
      },
      registry,
    );
  });

  afterEach(() => {
    registry.clear();
  });

  describe('constructor', () => {
    it('should initialize with default values', () => {
      expect(cache.getStats()).toEqual({ size: 0, hits: 0, misses: 0 });
    });

    it('should initialize metrics', () => {
      const metrics = registry.getMetricsAsArray();
      expect(metrics.some(m => m.name === 'audit_cache_hits_total')).toBe(true);
      expect(metrics.some(m => m.name === 'audit_cache_misses_total')).toBe(true);
    });
  });

  describe('get and set', () => {
    it('should return null for cache miss', () => {
      const query: AuditQuery = { action: 'CONTRACT_CREATED' };
      const result = cache.get(query, 'query');
      expect(result).toBeNull();
      expect(cache.getStats().misses).toBe(1);
    });

    it('should store and retrieve cached data', () => {
      const query: AuditQuery = { action: 'CONTRACT_CREATED' };
      const data: AuditEntry[] = [
        {
          id: '1',
          timestamp: new Date().toISOString(),
          action: 'CONTRACT_CREATED',
          severity: 'INFO',
          actor: 'user1',
          resource: 'contract',
          resourceId: 'contract1',
          metadata: {},
          previousHash: 'hash0',
          hash: 'hash1',
        },
      ];

      cache.set(query, data, 'query');
      const result = cache.get(query, 'query');

      expect(result).toEqual(data);
      expect(cache.getStats().hits).toBe(1);
      expect(cache.getStats().misses).toBe(0);
    });

    it('should handle cursor-based query results', () => {
      const query: AuditQuery = { action: 'CONTRACT_CREATED' };
      const data: AuditQueryResult = {
        entries: [],
        count: 0,
        limit: 50,
        nextCursor: 'cursor123',
      };

      cache.set(query, data, 'queryWithCursor');
      const result = cache.get(query, 'queryWithCursor');

      expect(result).toEqual(data);
      expect(cache.getStats().hits).toBe(1);
    });

    it('should handle getById queries', () => {
      const data: AuditEntry = {
        id: 'entry1',
        timestamp: new Date().toISOString(),
        action: 'CONTRACT_CREATED',
        severity: 'INFO',
        actor: 'user1',
        resource: 'contract',
        resourceId: 'contract1',
        metadata: {},
        previousHash: 'hash0',
        hash: 'hash1',
      };

      cache.set({}, data, 'getById', 'entry1');
      const result = cache.get({}, 'getById', 'entry1');

      expect(result).toEqual(data);
      expect(cache.getStats().hits).toBe(1);
    });

    it('should generate different keys for different query types', () => {
      const query: AuditQuery = { action: 'CONTRACT_CREATED' };
      const data: AuditEntry[] = [];

      cache.set(query, data, 'query');
      cache.set(query, data, 'queryWithCursor');

      expect(cache.getStats().size).toBe(2);
    });
  });

  describe('TTL expiration', () => {
    it('should expire entries after TTL', async () => {
      registry.clear();
      cache = new AuditCache({ ttlMs: 50, maxEntries: 10 }, registry);
      const query: AuditQuery = { action: 'CONTRACT_CREATED' };
      const data: AuditEntry[] = [];

      cache.set(query, data, 'query');

      // Should be cached immediately
      expect(cache.get(query, 'query')).toEqual(data);
      expect(cache.getStats().hits).toBe(1);

      // Wait for expiration
      await new Promise(resolve => setTimeout(resolve, 60));

      // Should be expired
      const result = cache.get(query, 'query');
      expect(result).toBeNull();
      expect(cache.getStats().misses).toBe(1);
    });
  });

  describe('LRU eviction', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should evict oldest entry when at capacity', () => {
      registry.clear();
      cache = new AuditCache({ ttlMs: 10000, maxEntries: 3 }, registry);

      const query1: AuditQuery = { action: 'CONTRACT_CREATED' };
      const query2: AuditQuery = { action: 'CONTRACT_UPDATED' };
      const query3: AuditQuery = { action: 'CONTRACT_CANCELLED' };
      const query4: AuditQuery = { action: 'CONTRACT_COMPLETED' };

      cache.set(query1, [], 'query');
      jest.advanceTimersByTime(10);
      cache.set(query2, [], 'query');
      jest.advanceTimersByTime(10);
      cache.set(query3, [], 'query');
      jest.advanceTimersByTime(10);

      expect(cache.getStats().size).toBe(3);

      // Access query1 to make it recently used
      cache.get(query1, 'query');
      jest.advanceTimersByTime(10);

      // Add query4, should evict the oldest not accessed (which is query2)
      cache.set(query4, [], 'query');

      expect(cache.getStats().size).toBe(3);
      expect(cache.get(query1, 'query')).toEqual([]); // Still cached
      expect(cache.get(query4, 'query')).toEqual([]); // New entry
      
      // query2 should be evicted as it's the oldest not recently accessed
      expect(cache.get(query2, 'query')).toBeNull();
      // query3 should still be cached
      expect(cache.get(query3, 'query')).toEqual([]);
    });
  });

  describe('invalidate', () => {
    it('should clear all cache entries', () => {
      const query1: AuditQuery = { action: 'CONTRACT_CREATED' };
      const query2: AuditQuery = { action: 'CONTRACT_UPDATED' };

      cache.set(query1, [], 'query');
      cache.set(query2, [], 'query');

      expect(cache.getStats().size).toBe(2);

      cache.invalidate();

      expect(cache.getStats().size).toBe(0);
      expect(cache.get(query1, 'query')).toBeNull();
      expect(cache.get(query2, 'query')).toBeNull();
    });
  });

  describe('invalidateByResourceId', () => {
    it('should invalidate entries for a specific resource ID', () => {
      const query1: AuditQuery = { resourceId: 'resource1' };
      const query2: AuditQuery = { resourceId: 'resource2' };
      const query3: AuditQuery = { resourceId: 'resource1', action: 'CONTRACT_CREATED' };

      cache.set(query1, [], 'query');
      cache.set(query2, [], 'query');
      cache.set(query3, [], 'query');

      expect(cache.getStats().size).toBe(3);

      cache.invalidateByResourceId('resource1');

      expect(cache.getStats().size).toBe(1);
      expect(cache.get(query1, 'query')).toBeNull();
      expect(cache.get(query2, 'query')).toEqual([]); // Not invalidated
      expect(cache.get(query3, 'query')).toBeNull();
    });
  });

  describe('clear', () => {
    it('should clear all cache entries', () => {
      const query: AuditQuery = { action: 'CONTRACT_CREATED' };
      cache.set(query, [], 'query');

      expect(cache.getStats().size).toBe(1);

      cache.clear();

      expect(cache.getStats().size).toBe(0);
    });
  });

  describe('getStats', () => {
    it('should return current cache statistics', () => {
      const query: AuditQuery = { action: 'CONTRACT_CREATED' };
      cache.set(query, [], 'query');

      cache.get(query, 'query');
      cache.get(query, 'query');

      const stats = cache.getStats();
      expect(stats.size).toBe(1);
      expect(stats.hits).toBe(2);
      expect(stats.misses).toBe(0);
    });
  });

  describe('cleanupExpired', () => {
    it('should remove expired entries', async () => {
      registry.clear();
      cache = new AuditCache({ ttlMs: 50, maxEntries: 10 }, registry);

      const query1: AuditQuery = { action: 'CONTRACT_CREATED' };
      const query2: AuditQuery = { action: 'CONTRACT_UPDATED' };

      cache.set(query1, [], 'query');
      cache.set(query2, [], 'query');

      await new Promise(resolve => setTimeout(resolve, 60));

      const cleaned = cache.cleanupExpired();

      expect(cleaned).toBe(2);
      expect(cache.getStats().size).toBe(0);
    });

    it('should not remove non-expired entries', () => {
      const query: AuditQuery = { action: 'CONTRACT_CREATED' };
      cache.set(query, [], 'query');

      const cleaned = cache.cleanupExpired();

      expect(cleaned).toBe(0);
      expect(cache.getStats().size).toBe(1);
    });
  });

  describe('metrics', () => {
    it('should increment hit counter on cache hit', () => {
      const query: AuditQuery = { action: 'CONTRACT_CREATED' };
      cache.set(query, [], 'query');

      cache.get(query, 'query');

      const hitMetric = registry.getMetricsAsArray().find(m => m.name === 'audit_cache_hits_total');
      expect(hitMetric).toBeDefined();
    });

    it('should increment miss counter on cache miss', () => {
      const query: AuditQuery = { action: 'CONTRACT_CREATED' };
      cache.get(query, 'query');

      const missMetric = registry.getMetricsAsArray().find(m => m.name === 'audit_cache_misses_total');
      expect(missMetric).toBeDefined();
    });
  });

  describe('metric registration (repeated / concurrent construction)', () => {
    it('is idempotent when several caches share one registry', () => {
      const shared = new Registry();

      expect(() => new AuditCache({ ttlMs: 1000, maxEntries: 10 }, shared)).not.toThrow();
      expect(() => new AuditCache({ ttlMs: 1000, maxEntries: 10 }, shared)).not.toThrow();

      const second = new AuditCache({ ttlMs: 1000, maxEntries: 10 }, shared);
      second.set({ action: 'CONTRACT_CREATED' }, [], 'query');
      second.get({ action: 'CONTRACT_CREATED' }, 'query');

      expect(shared.getSingleMetric('audit_cache_hits_total')).toBeDefined();
      expect(shared.getSingleMetric('audit_cache_misses_total')).toBeDefined();
    });

    it('shares a single counter across instances on the same registry', async () => {
      const shared = new Registry();
      const first = new AuditCache({ ttlMs: 1000, maxEntries: 10 }, shared);
      const second = new AuditCache({ ttlMs: 1000, maxEntries: 10 }, shared);

      first.get({ action: 'CONTRACT_CREATED' }, 'query');
      second.get({ action: 'CONTRACT_UPDATED' }, 'query');

      const metric = shared.getSingleMetric('audit_cache_misses_total') as { get(): Promise<{ values: Array<{ value: number }> }> };
      const output = await metric.get();
      expect(output.values[0].value).toBe(2);
    });
  });

  describe('concurrent / interleaved access', () => {
    it('keeps the size invariant under interleaved set/get/evict cycles', () => {
      const local = new AuditCache({ ttlMs: 60_000, maxEntries: 3 }, new Registry());

      for (let i = 0; i < 200; i++) {
        local.set({ action: `A${i}` }, [], 'query');
        local.get({ action: `A${i - 1}` }, 'query');
        expect(local.getStats().size).toBeLessThanOrEqual(3);
      }
    });

    it('resolves concurrent misses without corrupting or duplicating state', async () => {
      const local = new AuditCache({ ttlMs: 60_000, maxEntries: 5 }, new Registry());

      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          Promise.resolve().then(() => {
            const query: AuditQuery = { action: `A${i % 4}` };
            const cached = local.get(query, 'query');
            if (cached) {
              return 'hit';
            }
            local.set(query, [], 'query');
            return 'miss';
          }),
        ),
      );

      expect(results).toHaveLength(20);
      expect(local.getStats().size).toBeLessThanOrEqual(5);
      for (const action of ['A0', 'A1', 'A2', 'A3']) {
        expect(local.get({ action }, 'query')).toEqual([]);
      }
    });
  });

  describe('deterministic cache keys', () => {
    it('treats queries with reordered keys as the same entry', () => {
      const local = new AuditCache({ ttlMs: 60_000, maxEntries: 10 }, new Registry());

      local.set({ action: 'CONTRACT_CREATED', resourceId: 'r1' }, [], 'query');

      expect(local.get({ resourceId: 'r1', action: 'CONTRACT_CREATED' }, 'query')).toEqual([]);
      expect(local.getStats()).toEqual({ size: 1, hits: 1, misses: 0 });
    });

    it('ignores undefined fields when building the key', () => {
      const local = new AuditCache({ ttlMs: 60_000, maxEntries: 10 }, new Registry());

      local.set({ action: 'CONTRACT_CREATED', actor: undefined }, [], 'query');

      expect(local.get({ action: 'CONTRACT_CREATED' }, 'query')).toEqual([]);
    });

    it('degrades circular / non-serialisable queries to a miss instead of throwing', () => {
      const local = new AuditCache({ ttlMs: 60_000, maxEntries: 10 }, new Registry());
      const circular: AuditQuery & { self?: unknown } = { action: 'CONTRACT_CREATED' };
      circular.self = circular;

      expect(() => local.get(circular, 'query')).not.toThrow();
      expect(local.get(circular, 'query')).toBeNull();

      expect(() => local.set(circular, [], 'query')).not.toThrow();
      expect(local.getStats().size).toBe(0);
    });
  });

  describe('capacity and boundary handling', () => {
    it('disables storage when maxEntries is non-positive', () => {
      const disabled = new AuditCache({ ttlMs: 60_000, maxEntries: 0 }, new Registry());

      disabled.set({ action: 'CONTRACT_CREATED' }, [], 'query');

      expect(disabled.getStats().size).toBe(0);
      expect(disabled.get({ action: 'CONTRACT_CREATED' }, 'query')).toBeNull();
    });

    it('never exceeds maxEntries after capacity is applied', () => {
      const local = new AuditCache({ ttlMs: 60_000, maxEntries: 2 }, new Registry());

      local.set({ action: 'A' }, [], 'query');
      local.set({ action: 'B' }, [], 'query');
      local.set({ action: 'C' }, [], 'query');

      expect(local.getStats().size).toBe(2);
    });

    it('normalizes invalid TTL / maxEntries instead of throwing', () => {
      expect(() => new AuditCache({ ttlMs: Number.NaN, maxEntries: 10 }, new Registry())).not.toThrow();
      expect(() => new AuditCache({ ttlMs: -1, maxEntries: -5 }, new Registry())).not.toThrow();
    });
  });

  describe('defensive copies (state integrity under repeated access)', () => {
    it('does not let readers mutate cached data', () => {
      const local = new AuditCache({ ttlMs: 60_000, maxEntries: 10 }, new Registry());
      local.set({ action: 'A' }, [{ id: '1' } as AuditEntry], 'query');

      const first = local.get({ action: 'A' }, 'query') as AuditEntry[];
      first.push({ id: '2' } as AuditEntry);

      const second = local.get({ action: 'A' }, 'query') as AuditEntry[];
      expect(second).toHaveLength(1);
    });

    it('does not let the writer mutate cached data after set', () => {
      const local = new AuditCache({ ttlMs: 60_000, maxEntries: 10 }, new Registry());
      const data: AuditEntry[] = [{ id: '1' } as AuditEntry];

      local.set({ action: 'A' }, data, 'query');
      data.push({ id: '2' } as AuditEntry);

      const stored = local.get({ action: 'A' }, 'query') as AuditEntry[];
      expect(stored).toHaveLength(1);
    });
  });

  describe('invalidation boundaries', () => {
    it('ignores empty or non-string resource ids', () => {
      const local = new AuditCache({ ttlMs: 60_000, maxEntries: 10 }, new Registry());
      local.set({ resourceId: 'r1' }, [], 'query');

      expect(() => local.invalidateByResourceId('')).not.toThrow();
      expect(() => local.invalidateByResourceId(undefined as unknown as string)).not.toThrow();
      expect(local.getStats().size).toBe(1);
    });

    it('only invalidates the exact resource id (no prefix collisions)', () => {
      const local = new AuditCache({ ttlMs: 60_000, maxEntries: 10 }, new Registry());
      local.set({ resourceId: 'resource1' }, [], 'query');
      local.set({ resourceId: 'resource10' }, [], 'query');

      local.invalidateByResourceId('resource1');

      expect(local.get({ resourceId: 'resource1' }, 'query')).toBeNull();
      expect(local.get({ resourceId: 'resource10' }, 'query')).toEqual([]);
    });
  });

  describe('getById boundaries', () => {
    it('does not cache getById entries without a usable id', () => {
      const local = new AuditCache({ ttlMs: 60_000, maxEntries: 10 }, new Registry());
      local.set({}, { id: 'x' } as AuditEntry, 'getById', '');

      expect(local.getStats().size).toBe(0);
      expect(local.get({}, 'getById', '')).toBeNull();
    });
  });
});
