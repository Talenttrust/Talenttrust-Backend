/**
 * @module utils/swrCache
 * @description Stale-While-Revalidate (SWR) in-memory cache layer.
 * Provides high-availability fallback by returning stale data with a
 * degraded signal while transparently updating from upstream in the background.
 */

export interface CacheOptions {
  /** Time-To-Live in milliseconds. Cache is considered fresh during this period. */
  ttlMs: number;
  /** Stale-While-Revalidate window in milliseconds. Allowed time past TTL to serve stale data. */
  swrMs: number;
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

export class SWRCache {
  private cache = new Map<string, CacheEntry<any>>();
  private activeFetches = new Map<string, Promise<any>>();

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
        return { data: entry.data as T, degraded: false, source: 'cache_fresh' };
      }

      // 2. Stale hit (within SWR window)
      if (age < options.ttlMs + options.swrMs) {
        if (!this.activeFetches.has(key)) {
          this.revalidate(key, fetcher);
        }
        return { data: entry.data as T, degraded: true, source: 'cache_stale' };
      }
    }

    // 3. Cache miss or completely expired - block and wait for upstream
    if (this.activeFetches.has(key)) {
      // Coalesce identical overlapping fetches to prevent upstream stampedes
      const data = await this.activeFetches.get(key);
      return { data, degraded: false, source: 'upstream' };
    }

    const data = await this.revalidate(key, fetcher);
    return { data, degraded: false, source: 'upstream' };
  }

  private async revalidate<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
    const fetchPromise = fetcher()
      .then((newData) => {
        this.cache.set(key, { data: newData, updatedAt: Date.now() });
        this.activeFetches.delete(key);
        return newData;
      })
      .catch((err) => {
        this.activeFetches.delete(key);
        // Depending on error handling policy, we could log this explicitly
        console.error(`[SWR Cache] Background revalidation failed for key: ${key}`, err.message);
        throw err;
      });

    this.activeFetches.set(key, fetchPromise);
    return fetchPromise;
  }
}