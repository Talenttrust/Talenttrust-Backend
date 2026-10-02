/**
 * @module utils/reputationCache
 * @description Bounded LRU cache with TTL and explicit write-invalidation for
 * reputation profile reads.
 *
 * ### Design rationale
 * The SWR cache in `swrCache.ts` is purpose-built for upstream HTTP resources
 * with degraded-fallback semantics. Reputation profiles need a simpler contract:
 *  - Return a fresh cached value within the TTL window.
 *  - Return `undefined` (cache miss) when the entry is absent or expired.
 *  - Expose an explicit `invalidate(key)` method called by write paths so that
 *    post-write reads always reflect the latest state.
 *  - Evict the LRU entry when the cap is exceeded.
 *
 * ### LRU implementation
 * Uses a `Map` whose insertion order is the LRU order. Every `get` and `set`
 * that touches an existing key does a delete-then-set to move that entry to
 * the "most recently used" end. When the size would exceed `maxEntries`, the
 * first (oldest/LRU) key is removed.
 *
 * ### Metrics
 * Hit and miss counters are tracked internally. Call `getMetrics()` to read
 * the running totals without any external dependency. A Prometheus-compatible
 * interface is exposed via `ReputationCacheMetrics` for integration with the
 * metrics service.
 */

/** A single cached entry. */
interface CacheEntry<T> {
  /** The stored value. */
  data: T;
  /** Unix timestamp (ms) when this entry was written. */
  cachedAt: number;
}

/** Running hit / miss counters. */
export interface ReputationCacheMetrics {
  hits: number;
  misses: number;
}

/** Configuration options for {@link ReputationLruCache}. */
export interface ReputationCacheOptions {
  /**
   * Maximum number of entries to retain. When the cache would exceed this
   * bound the least-recently-used entry is evicted.
   * Must be a positive integer. Default: 500.
   */
  maxEntries?: number;
  /**
   * Entry lifetime in milliseconds. Entries older than `ttlMs` are treated as
   * cache misses even if they are still physically present.
   * Must be a positive integer. Default: 60_000 (1 minute).
   */
  ttlMs?: number;
}

/** Default maximum number of entries. */
export const DEFAULT_REPUTATION_CACHE_MAX_ENTRIES = 500;

/** Default TTL in milliseconds (1 minute). */
export const DEFAULT_REPUTATION_CACHE_TTL_MS = 60_000;

/**
 * Bounded LRU cache with per-entry TTL and explicit invalidation.
 *
 * @example
 * ```typescript
 * const cache = new ReputationLruCache<ReputationProfile>({ ttlMs: 30_000, maxEntries: 200 });
 *
 * // Read path (miss):
 * const profile = await cache.get('user-1');         // undefined — cold cache
 * const fresh = await service.getProfile('user-1');
 * cache.set('user-1', fresh);
 *
 * // Read path (hit):
 * const cached = cache.get('user-1');                // ReputationProfile — served from cache
 *
 * // Write path (invalidation):
 * cache.invalidate('user-1');                        // evict so next GET recomputes
 * ```
 */
export class ReputationLruCache<T = unknown> {
  /** Effective TTL (ms). */
  public readonly ttlMs: number;
  /** Effective capacity cap. */
  public readonly maxEntries: number;

  /** Insertion-ordered map — LRU = first key, MRU = last key. */
  private readonly store = new Map<string, CacheEntry<T>>();

  /** Cumulative hit counter. */
  private _hits = 0;
  /** Cumulative miss counter. */
  private _misses = 0;

  /**
   * @param options - Cache configuration. Missing values fall back to defaults.
   * @throws {RangeError} when `maxEntries` or `ttlMs` is not a positive integer.
   */
  constructor(options: ReputationCacheOptions = {}) {
    const maxEntries = options.maxEntries ?? DEFAULT_REPUTATION_CACHE_MAX_ENTRIES;
    const ttlMs = options.ttlMs ?? DEFAULT_REPUTATION_CACHE_TTL_MS;

    if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
      throw new RangeError(
        `ReputationLruCache: maxEntries must be a positive integer (got ${String(options.maxEntries)})`,
      );
    }
    if (!Number.isInteger(ttlMs) || ttlMs <= 0) {
      throw new RangeError(
        `ReputationLruCache: ttlMs must be a positive integer (got ${String(options.ttlMs)})`,
      );
    }

    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
  }

  /**
   * Returns the number of physically stored entries (including potentially
   * expired ones that have not been pruned yet).
   */
  public get size(): number {
    return this.store.size;
  }

  /**
   * Retrieve an entry.
   *
   * - Returns the stored value if the entry exists **and** is within the TTL.
   * - Returns `undefined` on a cache miss or if the entry has expired.
   * - Updates LRU order on a live hit.
   * - Increments the hit or miss counter accordingly.
   */
  public get(key: string): T | undefined {
    const entry = this.store.get(key);

    if (entry === undefined) {
      this._misses++;
      return undefined;
    }

    const age = Date.now() - entry.cachedAt;
    if (age >= this.ttlMs) {
      // Expired — remove and report miss
      this.store.delete(key);
      this._misses++;
      return undefined;
    }

    // Live hit — promote to MRU
    this.store.delete(key);
    this.store.set(key, entry);
    this._hits++;
    return entry.data;
  }

  /**
   * Store an entry and enforce the capacity bound.
   *
   * If `key` already exists the entry is updated in-place (moved to MRU).
   * When the store would exceed `maxEntries` after the write, the LRU entry
   * (first in Map iteration order) is evicted first.
   */
  public set(key: string, value: T): void {
    // Delete first to reset insertion order (MRU semantics).
    this.store.delete(key);

    // Enforce cap before inserting to keep store.size ≤ maxEntries at all
    // times (not maxEntries + 1 even transiently).
    while (this.store.size >= this.maxEntries) {
      const lruKey = this.store.keys().next().value;
      if (lruKey === undefined) break;
      this.store.delete(lruKey);
    }

    this.store.set(key, { data: value, cachedAt: Date.now() });
  }

  /**
   * Explicitly remove an entry regardless of its TTL.
   *
   * Call this from write paths (e.g. after a successful rating submission) to
   * ensure that the next read re-fetches fresh data from the service layer.
   *
   * @returns `true` if the key was present and removed, `false` if it was not
   *          cached (no-op is safe — idempotent).
   */
  public invalidate(key: string): boolean {
    return this.store.delete(key);
  }

  /**
   * Remove **all** entries from the cache.
   * Useful for test teardown or full-cache flush scenarios.
   * Does not reset the hit/miss counters.
   */
  public clear(): void {
    this.store.clear();
  }

  /**
   * Snapshot of current hit / miss counters.
   * The counters are monotonically increasing and never reset automatically.
   */
  public getMetrics(): ReputationCacheMetrics {
    return { hits: this._hits, misses: this._misses };
  }

  /**
   * Reset hit / miss counters to zero.
   * Useful in tests that need isolated metric assertions.
   */
  public resetMetrics(): void {
    this._hits = 0;
    this._misses = 0;
  }
}

/**
 * Factory function that creates a new {@link ReputationLruCache} instance.
 * Prefer the singleton {@link reputationCache} for production use; use this
 * factory to inject a fresh cache in tests.
 */
export function createReputationCache<T = unknown>(
  options?: ReputationCacheOptions,
): ReputationLruCache<T> {
  return new ReputationLruCache<T>(options);
}

/**
 * Process-level singleton cache for `ReputationProfile` objects.
 *
 * Configuration is applied lazily from environment variables on first use
 * via {@link initReputationCache}. For tests, reset with
 * `reputationCache.clear()` or replace the singleton by calling
 * `initReputationCache()` with explicit options.
 *
 * TTL and capacity are sourced from:
 *  - `REPUTATION_CACHE_TTL_MS`  (env) → default 60 000 ms
 *  - `REPUTATION_CACHE_MAX_ENTRIES` (env) → default 500
 */
// Start with the defaults; callers can replace via initReputationCache().
export let reputationCache: ReputationLruCache = new ReputationLruCache();

/**
 * (Re-)initialise the module-level singleton.
 *
 * Called once at application startup after environment variables have been
 * validated by `validateEnv()`. Tests may call this with explicit values to
 * override the defaults without touching `process.env`.
 *
 * @param options - Explicit configuration; falls back to env / defaults.
 */
export function initReputationCache(options?: ReputationCacheOptions): ReputationLruCache {
  const ttlMs = options?.ttlMs ??
    (process.env['REPUTATION_CACHE_TTL_MS']
      ? parseInt(process.env['REPUTATION_CACHE_TTL_MS'], 10)
      : DEFAULT_REPUTATION_CACHE_TTL_MS);

  const maxEntries = options?.maxEntries ??
    (process.env['REPUTATION_CACHE_MAX_ENTRIES']
      ? parseInt(process.env['REPUTATION_CACHE_MAX_ENTRIES'], 10)
      : DEFAULT_REPUTATION_CACHE_MAX_ENTRIES);

  reputationCache = new ReputationLruCache({ ttlMs, maxEntries });
  return reputationCache;
}
