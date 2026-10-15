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
 *
 * Concurrency & state invariants (preserved through repeated/interleaved use):
 *   - Every mutation is synchronous, so cache operations are atomic with respect
 *     to the Node event loop; there is no async window in which a half-updated
 *     entry can be observed.
 *   - `this.cache.size <= this.maxEntries` at all times. A non-positive
 *     `maxEntries` disables storage entirely.
 *   - Equivalent queries (same fields, regardless of object key order) map to the
 *     same cache key, so duplicate work and duplicate entries cannot occur.
 *   - Cached values are snapshotted on write and cloned on read, so callers can
 *     never mutate the cache's internal state and readers never share mutable
 *     references.
 *   - Metric registration is idempotent: constructing multiple caches against the
 *     same registry never throws and never duplicates counters.
 *   - Invalid or non-serialisable queries/data degrade to a cache miss/no-op
 *     instead of throwing.
 */

import { Counter, Registry } from 'prom-client';
import type { AuditEntry, AuditQuery, AuditQueryResult } from './types';

export interface AuditCacheOptions {
  ttlMs: number;
  maxEntries: number;
}

export interface CacheEntry {
  data: AuditEntry[] | AuditEntry | AuditQueryResult;
  expiresAt: number;
  lastAccessed: number;
  /**
   * Resource id the entry was cached for, when the query filtered by one.
   * Used for precise, allocation-free invalidation instead of string matching.
   */
  resourceId?: string;
}

export type AuditCacheQueryType = 'query' | 'queryWithCursor' | 'getById';

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
    this.ttlMs = AuditCache.normalizeTtl(options == null ? undefined : options.ttlMs);
    this.maxEntries = AuditCache.normalizeMaxEntries(options == null ? undefined : options.maxEntries);
    this.cache = new Map();
    this.hitCount = 0;
    this.missCount = 0;

    // Initialize metrics. Prefer the caller-supplied registry (so metrics are
    // actually exported) and reuse any counters that are already registered to
    // it, which makes repeated construction safe.
    const registry = AuditCache.resolveRegistry(register);

    this.hits = AuditCache.resolveCounter(
      registry,
      'audit_cache_hits_total',
      'Total number of audit cache hits.',
    );

    this.misses = AuditCache.resolveCounter(
      registry,
      'audit_cache_misses_total',
      'Total number of audit cache misses.',
    );
  }

  /**
   * Clamp an arbitrary TTL to a non-negative finite integer. Invalid input
   * falls back to `0`, which expires entries immediately.
   */
  private static normalizeTtl(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      return 0;
    }
    return Math.floor(value);
  }

  /**
   * Clamp an arbitrary max-entries value to a non-negative finite integer.
   * A non-positive result disables the cache.
   */
  private static normalizeMaxEntries(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      return 0;
    }
    return Math.floor(value);
  }

  /**
   * Resolve the Prometheus registry to register metrics on. Falls back to an
   * isolated registry only when the caller does not provide a usable one.
   */
  private static resolveRegistry(register?: unknown): Registry {
    if (register instanceof Registry) {
      return register;
    }

    if (
      register !== null &&
      typeof register === 'object' &&
      typeof (register as Registry).getSingleMetric === 'function' &&
      typeof (register as Registry).registerMetric === 'function'
    ) {
      return register as Registry;
    }

    return new Registry();
  }

  /**
   * Return the existing counter for `name` on `registry`, or create it. This is
   * idempotent so constructing several caches with one registry cannot throw
   * "A metric with the name ... has already been registered".
   */
  private static resolveCounter(registry: Registry, name: string, help: string): Counter<string> {
    const existing = registry.getSingleMetric(name);
    if (existing) {
      return existing as Counter<string>;
    }
    return new Counter({ name, help, registers: [registry] });
  }

  /**
   * Deterministic JSON serialization with sorted object keys. Guarantees the
   * same key for logically equivalent queries regardless of property order.
   */
  private static canonicalize(value: unknown, seen: WeakSet<object> = new WeakSet()): string {
    if (value === null) {
      return 'null';
    }

    const type = typeof value;
    if (type === 'string') {
      return JSON.stringify(value);
    }
    if (type === 'number') {
      return Number.isFinite(value as number) ? String(value) : 'null';
    }
    if (type === 'boolean') {
      return value ? 'true' : 'false';
    }
    if (type !== 'object') {
      return 'null';
    }

    const objectValue = value as object;
    if (seen.has(objectValue)) {
      throw new Error('Cannot serialize circular audit query');
    }
    seen.add(objectValue);

    try {
      if (Array.isArray(value)) {
        return `[${value.map((item) => AuditCache.canonicalize(item, seen)).join(',')}]`;
      }

      const record = value as Record<string, unknown>;
      const parts = Object.keys(record)
        .sort()
        .filter((key) => record[key] !== undefined)
        .map((key) => `${JSON.stringify(key)}:${AuditCache.canonicalize(record[key], seen)}`);
      return `{${parts.join(',')}}`;
    } finally {
      seen.delete(objectValue);
    }
  }

  /**
   * Generate a deterministic cache key from an audit query.
   *
   * Returns `null` for queries that cannot be represented (missing id for
   * `getById`, non-object query, or a circular structure) so callers degrade to
   * a miss instead of throwing.
   */
  private generateKey(query: AuditQuery, type: AuditCacheQueryType, id?: string): string | null {
    if (type === 'getById') {
      if (id === undefined || id === null || id === '') {
        return null;
      }
      return `getById:${String(id)}`;
    }

    if (query === null || typeof query !== 'object') {
      return null;
    }

    try {
      return `${type}:${AuditCache.canonicalize(query)}`;
    } catch {
      return null;
    }
  }

  /**
   * Defensive snapshot/clone so cached values can never be mutated by callers
   * and readers never share a reference with the cache's internal state.
   */
  private static clone<T>(value: T): T {
    try {
      return structuredClone(value);
    } catch {
      // Non-cloneable payloads (e.g. functions) are passed through unchanged
      // rather than throwing; this preserves the previous behavior.
      return value;
    }
  }

  private recordHit(): void {
    this.hits.inc();
    this.hitCount++;
  }

  private recordMiss(): void {
    this.misses.inc();
    this.missCount++;
  }

  /**
   * Get cached audit query results.
   *
   * @param query - The audit query
   * @param type - The type of query (query, queryWithCursor, or getById)
   * @param id - Optional ID for getById queries
   * @returns A defensive copy of the cached data if valid and not expired, null otherwise
   */
  get(
    query: AuditQuery,
    type: AuditCacheQueryType,
    id?: string,
  ): AuditEntry[] | AuditEntry | AuditQueryResult | null {
    const key = this.generateKey(query, type, id);
    if (key === null) {
      this.recordMiss();
      return null;
    }

    const entry = this.cache.get(key);
    const now = Date.now();

    if (!entry) {
      this.recordMiss();
      return null;
    }

    // Check if entry has expired
    if (now > entry.expiresAt) {
      this.cache.delete(key);
      this.recordMiss();
      return null;
    }

    // Update last accessed time for LRU eviction
    entry.lastAccessed = now;
    this.recordHit();
    return AuditCache.clone(entry.data);
  }

  /**
   * Set a cache entry for an audit query result.
   *
   * @param query - The audit query
   * @param data - The data to cache
   * @param type - The type of query (query, queryWithCursor, or getById)
   * @param id - Optional ID for getById queries
   */
  set(
    query: AuditQuery,
    data: AuditEntry[] | AuditEntry | AuditQueryResult,
    type: AuditCacheQueryType,
    id?: string,
  ): void {
    // Defensive: never store null/undefined and never throw for bad keys.
    if (data === undefined || data === null) {
      return;
    }

    const key = this.generateKey(query, type, id);
    if (key === null) {
      return;
    }

    // A non-positive capacity disables the cache entirely.
    if (this.maxEntries <= 0) {
      return;
    }

    const now = Date.now();
    const resourceId =
      query !== null &&
      typeof query === 'object' &&
      typeof (query as AuditQuery).resourceId === 'string' &&
      (query as AuditQuery).resourceId !== ''
        ? (query as AuditQuery).resourceId
        : undefined;

    const entry: CacheEntry = {
      data: AuditCache.clone(data),
      expiresAt: now + this.ttlMs,
      lastAccessed: now,
      resourceId,
    };

    // Evict least-recently-used entries until there is room. This keeps the
    // size invariant even when maxEntries was reduced.
    if (!this.cache.has(key)) {
      while (this.cache.size >= this.maxEntries) {
        if (!this.evictOldest()) {
          // Empty cache — nothing left to evict; avoid an infinite loop.
          break;
        }
      }
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
    if (typeof resourceId !== 'string' || resourceId === '') {
      return;
    }

    const keysToDelete: string[] = [];
    this.cache.forEach((entry, key) => {
      if (entry.resourceId === resourceId) {
        keysToDelete.push(key);
      }
    });

    keysToDelete.forEach((key) => this.cache.delete(key));
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
   *
   * @returns `true` when an entry was evicted, `false` when the cache was empty.
   */
  private evictOldest(): boolean {
    let oldestKey: string | null = null;
    let oldestAccessed = Infinity;

    this.cache.forEach((entry, key) => {
      if (entry.lastAccessed < oldestAccessed) {
        oldestAccessed = entry.lastAccessed;
        oldestKey = key;
      }
    });

    if (oldestKey !== null) {
      this.cache.delete(oldestKey);
      return true;
    }

    return false;
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
