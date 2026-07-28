/**
 * @module auditCache
 * @description Response caching for audit reads with TTL and LRU eviction.
 *
 * Provides a bounded cache for audit query results to reduce database load.
 * Cache entries expire after a configurable TTL and are evicted when the cache
 * reaches its max entry bound.
 *
 * Cache invalidation:
 *   - Explicit invalidation on write operations (log/append)
 *   - TTL-based expiration
 *   - LRU eviction when capacity is reached
 *
 * Metrics:
 *   - Cache hits and misses are tracked via Prometheus counters
 */

import { Counter } from 'prom-client';
import type { AuditEntry, AuditQuery, AuditQueryResult } from './types';

export interface AuditCacheOptions {
  ttlMs: number;
  maxEntries: number;
}

export interface CacheEntry {
  data: AuditEntry[] | AuditEntry | AuditQueryResult;
  expiresAt: number;
  lastAccessed: number;
}

/**
 * LRU cache with TTL for audit read responses.
 */
export class AuditCache {
  private cache: Map<string, CacheEntry>;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private hits: Counter<string>;
  private misses: Counter<string>;
  private hitCount: number;
  private missCount: number;

  constructor(options: AuditCacheOptions, register?: any) {
    this.ttlMs = options.ttlMs;
    this.maxEntries = options.maxEntries;
    this.cache = new Map();
    this.hitCount = 0;
    this.missCount = 0;

    // Initialize metrics
    const Registry = require('prom-client').Registry;
    const registry = register && register.constructor && register.constructor.name === 'Registry' ? register : new Registry();

    this.hits = new Counter({
      name: 'audit_cache_hits_total',
      help: 'Total number of audit cache hits.',
      registers: [registry],
    });

    this.misses = new Counter({
      name: 'audit_cache_misses_total',
      help: 'Total number of audit cache misses.',
      registers: [registry],
    });
  }

  /**
   * Generate a cache key from an audit query.
   */
  private generateKey(query: AuditQuery, type: 'query' | 'queryWithCursor' | 'getById', id?: string): string {
    const base = type === 'getById' ? `getById:${id}` : `${type}:${JSON.stringify(query)}`;
    return base;
  }

  /**
   * Get cached audit query results.
   *
   * @param query - The audit query
   * @param type - The type of query (query, queryWithCursor, or getById)
   * @param id - Optional ID for getById queries
   * @returns The cached data if valid and not expired, null otherwise
   */
  get(query: AuditQuery, type: 'query' | 'queryWithCursor' | 'getById', id?: string): AuditEntry[] | AuditEntry | AuditQueryResult | null {
    const key = this.generateKey(query, type, id);
    const entry = this.cache.get(key);
    const now = Date.now();

    if (!entry) {
      this.misses.inc();
      this.missCount++;
      return null;
    }

    // Check if entry has expired
    if (now > entry.expiresAt) {
      this.cache.delete(key);
      this.misses.inc();
      this.missCount++;
      return null;
    }

    // Update last accessed time for LRU eviction
    entry.lastAccessed = now;
    this.hits.inc();
    this.hitCount++;
    return entry.data;
  }

  /**
   * Set a cache entry for an audit query result.
   *
   * @param query - The audit query
   * @param data - The data to cache
   * @param type - The type of query (query, queryWithCursor, or getById)
   * @param id - Optional ID for getById queries
   */
  set(query: AuditQuery, data: AuditEntry[] | AuditEntry | AuditQueryResult, type: 'query' | 'queryWithCursor' | 'getById', id?: string): void {
    const key = this.generateKey(query, type, id);
    const now = Date.now();
    const entry: CacheEntry = {
      data,
      expiresAt: now + this.ttlMs,
      lastAccessed: now,
    };

    // Evict oldest entries if at capacity
    if (this.cache.size >= this.maxEntries && !this.cache.has(key)) {
      this.evictOldest();
    }

    this.cache.set(key, entry);
  }

  /**
   * Invalidate all cache entries (called on write operations).
   */
  invalidate(): void {
    this.cache.clear();
  }

  /**
   * Invalidate cache entries for a specific resource ID.
   *
   * @param resourceId - The resource ID whose cache entries should be invalidated
   */
  invalidateByResourceId(resourceId: string): void {
    const keysToDelete: string[] = [];
    this.cache.forEach((entry, key) => {
      // Check if the cache key contains the resource ID
      if (key.includes(`"resourceId":"${resourceId}"`) || key.includes(`"resourceId":'${resourceId}'`)) {
        keysToDelete.push(key);
      }
    });
    keysToDelete.forEach(key => this.cache.delete(key));
  }

  /**
   * Clear all cache entries.
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get current cache statistics.
   */
  getStats(): { size: number; hits: number; misses: number } {
    return {
      size: this.cache.size,
      hits: this.hitCount,
      misses: this.missCount,
    };
  }

  /**
   * Evict the least recently used entry.
   */
  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestAccessed = Infinity;

    this.cache.forEach((entry, key) => {
      if (entry.lastAccessed < oldestAccessed) {
        oldestAccessed = entry.lastAccessed;
        oldestKey = key;
      }
    });

    if (oldestKey) {
      this.cache.delete(oldestKey);
    }
  }

  /**
   * Clean up expired entries (called periodically).
   */
  cleanupExpired(): number {
    const now = Date.now();
    let cleaned = 0;
    const keysToDelete: string[] = [];

    this.cache.forEach((entry, key) => {
      if (now > entry.expiresAt) {
        keysToDelete.push(key);
      }
    });

    keysToDelete.forEach(key => {
      this.cache.delete(key);
      cleaned++;
    });

    return cleaned;
  }
}
