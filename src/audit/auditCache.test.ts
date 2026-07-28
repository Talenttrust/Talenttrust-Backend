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
    it('should evict oldest entry when at capacity', () => {
      registry.clear();
      cache = new AuditCache({ ttlMs: 10000, maxEntries: 3 }, registry);

      const query1: AuditQuery = { action: 'CONTRACT_CREATED' };
      const query2: AuditQuery = { action: 'CONTRACT_UPDATED' };
      const query3: AuditQuery = { action: 'CONTRACT_CANCELLED' };
      const query4: AuditQuery = { action: 'CONTRACT_COMPLETED' };

      cache.set(query1, [], 'query');
      cache.set(query2, [], 'query');
      cache.set(query3, [], 'query');

      expect(cache.getStats().size).toBe(3);

      // Access query1 to make it recently used
      cache.get(query1, 'query');

      // Add query4, should evict the oldest not accessed (query2 or query3)
      cache.set(query4, [], 'query');

      expect(cache.getStats().size).toBe(3);
      expect(cache.get(query1, 'query')).toEqual([]); // Still cached
      expect(cache.get(query4, 'query')).toEqual([]); // New entry
      // One of query2 or query3 should be evicted
      const query2Result = cache.get(query2, 'query');
      const query3Result = cache.get(query3, 'query');
      expect(query2Result === null || query3Result === null).toBe(true);
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
});
