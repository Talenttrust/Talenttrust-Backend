/**
 * @module utils/swrCache
 * @description Stale-While-Revalidate (SWR) in-memory cache layer.
 * Provides high-availability fallback by returning stale data with a
 * degraded signal while transparently updating from upstream in the
 * background.
 *
 * Capacity is bounded via an LRU eviction policy configurable through
 * the {@link SWRCacheOptions.maxEntries | maxEntries} constructor option.
 * The cache map's insertion order is the source of truth: every {@link
 * SWRCache.get | get} call that hits an existing entry, and every write via
 * the internal setter, performs a delete-then-set so the entry is treated
 * as most-recently-used. When the cache exceeds the configured cap, the
 * insertion-order-oldest entry is purged until cap is satisfied.
 *
 * Eviction never blocks or corrupts in-flight coalesced revalidations:
 * `activeFetches` is tracked independently of cache membership and any
 * promise already pending resolves with the data it was awaiting.
 */

export interface CacheOptions {
  /** Time-To-Live in milliseconds. Cache is considered fresh during this period. */
  ttlMs: number;
  /** Stale-While-Revalidate window in milliseconds. Allowed time past TTL to serve stale data. */
  swrMs: number;
}

export interface SWRCacheOptions {
  /**
   * Maximum number of cached entries before LRU eviction kicks in.
   * Must be a positive integer. Defaults to {@link DEFAULT_MAX_ENTRIES}.
   */
  maxEntries?: number;
}

export interface SWRResult<T> {
  data: T;
  /** True if the data served was stale (SWR window) */
  degraded: boolean;
  /** Identifies the origin of the response payload */
  source: 'upstream' | 'cache_fresh' | 'cache_stale';
}

interface CacheEntry<T> {
  data: T;
  updatedAt: number;
}

/** Default cap applied when no `maxEntries` is supplied to the constructor. */
export const DEFAULT_MAX_ENTRIES = 1000;

export class SWRCache {
  /** Maximum number of entries permitted before LRU eviction is triggered. */
  public readonly maxEntries: number;
  /** Insertion-ordered Map keyed by `string`. Iteration yields least-recently-used first. */
  private cache = new Map<string, CacheEntry<unknown>>();
  /** In-flight fetch promises, decoupled from cache membership so eviction cannot corrupt them. */
  private activeFetches = new Map<string, Promise<unknown>>();

  /**
   * @param options - Cache configuration. Defaults are applied when omitted.
   * @throws RangeError if `options.maxEntries` is not a positive integer.
   */
  constructor(options: SWRCacheOptions = {}) {
    const supplied = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    if (!Number.isInteger(supplied) || supplied <= 0) {
      throw new RangeError(
        `SWRCache: maxEntries must be a positive integer (got ${String(options.maxEntries)})`,
      );
    }
    this.maxEntries = supplied;
  }

  /**
   * Current number of cached entries. Excludes in-flight fetch promises —
   * use this for observability and to assert cap invariants in tests.
   */
  public get size(): number {
    return this.cache.size;
  }

  /**
   * Retrieve data from cache or upstream fetcher using SWR strategy.
   *
   * @param key - The cache key. Use scoped keys (e.g. `resource:userId`) to prevent access control violations.
   * @param fetcher - Async function to fetch fresh data from upstream.
   * @param options - TTL and SWR window configurations.
   */
  async get<T>(
    key: string,
    fetcher: () => Promise<T>,
    options: CacheOptions
  ): Promise<SWRResult<T>> {
    const now = Date.now();
    const entry = this.cache.get(key);

    if (entry) {
      const age = now - entry.updatedAt;

      // 1. Fresh hit
      if (age < options.ttlMs) {
        this.touch(key, entry);
        return { data: entry.data as T, degraded: false, source: 'cache_fresh' };
      }

      // 2. Stale hit (within SWR window)
      if (age < options.ttlMs + options.swrMs) {
        if (!this.activeFetches.has(key)) {
          this.revalidate(key, fetcher);
        }
        this.touch(key, entry);
        return { data: entry.data as T, degraded: true, source: 'cache_stale' };
      }
    }

    // 3. Cache miss or completely expired - block and wait for upstream
    if (this.activeFetches.has(key)) {
      // Coalesce identical overlapping fetches to prevent upstream stampedes.
      // activeFetches intentionally outlives cache membership: if the
      // entry was evicted while this fetch is in flight, the promise here
      // still resolves with the awaited data and the caller is unaffected.
      const data = await this.activeFetches.get(key);
      this.touchIfPresent(key);
      return { data: data as T, degraded: false, source: 'upstream' };
    }

    const data = await this.revalidate(key, fetcher);
    return { data, degraded: false, source: 'upstream' };
  }

  /**
   * Insert (or replace) a cache entry, then enforce the configured cap by
   * purging insertion-order-oldest entries until size satisfies the bound.
   *
   * @remarks
   * We always perform a delete-then-set so the entry's Map position is
   * brought to the most-recently-used end. Map.set on an existing key does
   * NOT reorder, so true LRU semantics require this two-step pattern.
   *
   * Eviction iterates from the Map's first key (insertion-order = LRU order)
   * and deletes until `cache.size <= maxEntries`. This never blocks the
   * caller: eviction is bounded O(n) per write and the cap itself is a
   * tunable constant, so even pathological keys are removed in O(maxEntries)
   * worst case per write.
   */
  private setEntry(key: string, entry: CacheEntry<unknown>): void {
    this.cache.delete(key);
    this.cache.set(key, entry);
    while (this.cache.size > this.maxEntries) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      this.cache.delete(oldestKey);
    }
  }

  /**
   * Mark an existing entry as most-recently-used without altering its
   * contents or `updatedAt`. No-ops when the entry is no longer cached.
   */
  private touch(key: string, entry: CacheEntry<unknown>): void {
    this.cache.delete(key);
    this.cache.set(key, entry);
  }

  /** Convenience: touch only if the entry is still present. */
  private touchIfPresent(key: string): void {
    const current = this.cache.get(key);
    if (current !== undefined) {
      this.touch(key, current);
    }
  }

  /**
   * Run an upstream fetch, persist its result through the cap-enforcing
   * setter, and clean up the in-flight bookkeeping in a `finally` block so
   * error paths do not leak `activeFetches` entries.
   *
   * @remarks
   * We deliberately use try/catch/finally rather than chained `.then` /
   * `.catch` so that the activeFetches bookkeeping is guaranteed even if
   * the upstream fetcher throws synchronously.
   */
  private revalidate<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
    const fetchPromise = (async (): Promise<T> => {
      try {
        const newData = await fetcher();
        this.setEntry(key, { data: newData as unknown, updatedAt: Date.now() });
        return newData;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(
          `[SWR Cache] Background revalidation failed for key: ${key}`,
          (err as Error).message,
        );
        throw err;
      } finally {
        this.activeFetches.delete(key);
      }
    })();
    this.activeFetches.set(key, fetchPromise as Promise<unknown>);
    return fetchPromise;
  }
}
