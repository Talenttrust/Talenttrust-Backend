/**
 * @module cacheService
 * @description Bounded TTL-based LRU cache for contracts read endpoints.
 *
 * ## Design
 *
 * This service wraps an LRU cache with TTL support. Each cached value is stored
 * with an expiration timestamp. On `get`, if the TTL has elapsed, the entry is
 * treated as stale and removed.
 *
 * Cache keys are deterministic and include all parameters that affect the response:
 * - Single contract: `contracts:single:{contractId}`
 * - List/filtered: `contracts:list:{page}:{limit}:{filterHash}`
 * - Aggregate (stats): `contracts:stats`
 * - Config (bounds): `contracts:bounds`
 *
 * Invalidation is always synchronous and explicit: on a write, the service owner
 * calls `invalidateKey(key)` or `invalidatePattern(pattern)` before the write
 * response is sent. This guarantees no stale data immediately after a write.
 *
 * ## Metrics
 *
 * This service does NOT directly emit metrics. Instead, callers (e.g., the
 * CacheInterceptor) use onHit/onMiss callbacks to notify the MetricsService.
 * This decouples cache logic from observability infrastructure.
 *
 * @internal Implementation uses lru-cache with dispose callback
 * for lifecycle visibility.
 */

import { LRUCache } from 'lru-cache';
import type { CacheConfig } from '../config/cache';

/**
 * Represents a cached value with its expiration timestamp.
 * @internal
 */
interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

/**
 * Metrics callbacks for cache hit/miss events.
 * Decouples cache logic from observability infrastructure.
 */
export interface CacheMetricsCallbacks {
  /** Called when a cache key is hit (value is valid and not expired) */
  onHit?: (key: string) => void;
  /** Called when a cache key is missed (not present or expired) */
  onMiss?: (key: string) => void;
  /** Called when an entry is evicted due to LRU bound */
  onEvicted?: (key: string, reason: 'evicted' | 'expired' | 'invalidated') => void;
}

/**
 * Bounded TTL-based LRU cache for response caching.
 *
 * @template T The type of values stored in the cache.
 */
export class CacheService<T = any> {
  private readonly cache: LRUCache<string, CacheEntry<T>>;
  private readonly ttlMs: number;
  private readonly callbacks: CacheMetricsCallbacks;

  /**
   * @param config - Cache configuration with TTL and max-entry settings
   * @param callbacks - Optional metrics callbacks for hit/miss/eviction events
   */
  constructor(config: CacheConfig, callbacks: CacheMetricsCallbacks = {}) {
    this.ttlMs = config.contractsTtlMs;
    this.callbacks = callbacks;

    // Create an LRU cache with:
    // - max: enforces the bounded entry limit
    // - dispose: called when an entry is evicted (for metrics/cleanup)
    this.cache = new LRUCache<string, CacheEntry<T>>({
      max: config.contractsMaxEntries,
      dispose: (entry: CacheEntry<T>, key: string, reason: string) => {
        // Reason from lru-cache can be: 'evict', 'set', 'delete', 'expire', 'fetch'
        // Map to our custom reasons
        const mappedReason = reason === 'evict' ? 'evicted' : reason === 'delete' ? 'invalidated' : 'expired';
        this.callbacks.onEvicted?.(key, mappedReason as any);
      },
    });
  }

  /**
   * Retrieves a value from the cache. Returns undefined if the key is not found,
   * is expired, or if the cache size exceeds the configured maximum (which triggers
   * LRU eviction).
   *
   * @param key - Cache key
   * @returns The cached value, or undefined if not found or expired
   */
  public get(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) {
      this.callbacks.onMiss?.(key);
      return undefined;
    }

    // Check if the entry has expired based on TTL
    if (Date.now() > entry.expiresAt) {
      // Entry has expired; remove it and treat as a miss
      this.cache.delete(key);
      this.callbacks.onMiss?.(key);
      return undefined;
    }

    // Cache hit: entry is valid and not expired
    this.callbacks.onHit?.(key);
    return entry.value;
  }

  /**
   * Stores a value in the cache with the configured TTL.
   *
   * @param key - Cache key
   * @param value - Value to cache
   */
  public set(key: string, value: T): void {
    const expiresAt = Date.now() + this.ttlMs;
    this.cache.set(key, { value, expiresAt });
  }

  /**
   * Removes a specific cache entry by key.
   * Called during invalidation after a write operation.
   *
   * @param key - Cache key to remove
   */
  public invalidateKey(key: string): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
      this.callbacks.onEvicted?.(key, 'invalidated');
    }
  }

  /**
   * Removes all cache entries that match a glob pattern.
   * Used for broader invalidation (e.g., invalidate all list cache keys
   * when a contract is created/updated/deleted).
   *
   * Pattern syntax:
   * - `*` matches any sequence of characters except `:`
   * - `**` matches any sequence including `:`
   * - Exact match: just provide the exact key
   *
   * @param pattern - Glob pattern to match keys
   */
  public invalidatePattern(pattern: string): void {
    // Simple glob matching: convert pattern to regex
    const regexPattern = this.globToRegex(pattern);
    const keysToDelete: string[] = [];

    // Iterate over all keys in the cache
    for (const key of this.cache.keys()) {
      if (regexPattern.test(key)) {
        keysToDelete.push(key);
      }
    }

    for (const key of keysToDelete) {
      this.cache.delete(key);
      this.callbacks.onEvicted?.(key, 'invalidated');
    }
  }

  /**
   * Clears all entries from the cache.
   * Should be used sparingly; prefer targeted invalidation.
   */
  public clear(): void {
    this.cache.clear();
  }

  /**
   * Returns the number of entries currently in the cache.
   */
  public size(): number {
    return this.cache.size;
  }

  /**
   * Converts a simple glob pattern to a RegExp for key matching.
   * Supported patterns:
   * - `*`: matches any characters within a key segment (separated by `:`)
   * - `**`: matches any characters across segments
   * - Literal text: matched exactly
   *
   * @internal
   */
  private globToRegex(pattern: string): RegExp {
    // Escape special regex characters, but preserve * and **
    let regexStr = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&') // Escape regex special chars
      .replace(/\*\*/g, '__DOUBLESTAR__') // Temporarily protect **
      .replace(/\*/g, '[^:]*') // Single * matches anything except :
      .replace(/__DOUBLESTAR__/g, '.*'); // ** matches anything including :

    return new RegExp(`^${regexStr}$`);
  }
}
