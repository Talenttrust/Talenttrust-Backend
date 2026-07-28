/**
 * @module authCache
 * @description Response caching for auth reads with TTL and LRU eviction.
 *
 * Provides a bounded cache for API key validation results to reduce database
 * load and cryptographic verification overhead. Cache entries expire after a
 * configurable TTL and are evicted when the cache reaches its max entry bound.
 *
 * Cache invalidation:
 *   - Explicit invalidation on write operations (create, rotate, deactivate, update)
 *   - TTL-based expiration
 *   - LRU eviction when capacity is reached
 */

export interface AuthCacheOptions {
  ttlMs: number;
  maxEntries: number;
}

export interface CacheEntry {
  info: ApiKeyInfo;
  expiresAt: number;
  lastAccessed: number;
}

export interface ApiKeyInfo {
  id: string;
  name: string;
  scope: string[];
  createdBy: string;
  createdAt: Date;
  expiresAt?: Date;
  isActive: boolean;
}

/**
 * LRU cache with TTL for auth read responses.
 */
export class AuthCache {
  private cache: Map<string, CacheEntry>;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private hitCount: number;
  private missCount: number;

  constructor(options: AuthCacheOptions) {
    this.ttlMs = options.ttlMs;
    this.maxEntries = options.maxEntries;
    this.cache = new Map();
    this.hitCount = 0;
    this.missCount = 0;
  }

  /**
   * Get a cached API key info by its selector.
   *
   * @param selector - The key selector (SHA-256 hash of the API key)
   * @returns The cached API key info if valid and not expired, null otherwise
   */
  get(selector: string): ApiKeyInfo | null {
    const entry = this.cache.get(selector);
    const now = Date.now();

    if (!entry) {
      this.missCount++;
      return null;
    }

    // Check if entry has expired
    if (now > entry.expiresAt) {
      this.cache.delete(selector);
      this.missCount++;
      return null;
    }

    // Update last accessed time for LRU eviction
    entry.lastAccessed = now;
    this.hitCount++;
    return entry.info;
  }

  /**
   * Set a cache entry for a key selector.
   *
   * @param selector - The key selector (SHA-256 hash of the API key)
   * @param info - The API key info to cache
   */
  set(selector: string, info: ApiKeyInfo): void {
    const now = Date.now();
    const entry: CacheEntry = {
      info,
      expiresAt: now + this.ttlMs,
      lastAccessed: now,
    };

    // Evict oldest entries if at capacity
    if (this.cache.size >= this.maxEntries && !this.cache.has(selector)) {
      this.evictOldest();
    }

    this.cache.set(selector, entry);
  }

  /**
   * Invalidate a cache entry by selector.
   *
   * @param selector - The key selector to invalidate
   */
  invalidate(selector: string): void {
    this.cache.delete(selector);
  }

  /**
   * Invalidate all cache entries for a specific user ID.
   *
   * @param userId - The user ID whose cache entries should be invalidated
   */
  invalidateByUserId(userId: string): void {
    const selectorsToDelete: string[] = [];
    this.cache.forEach((entry, selector) => {
      if (entry.info.createdBy === userId) {
        selectorsToDelete.push(selector);
      }
    });
    selectorsToDelete.forEach((selector) => this.cache.delete(selector));
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
    let oldestSelector: string | null = null;
    let oldestAccessed = Infinity;

    this.cache.forEach((entry, selector) => {
      if (entry.lastAccessed < oldestAccessed) {
        oldestAccessed = entry.lastAccessed;
        oldestSelector = selector;
      }
    });

    if (oldestSelector) {
      this.cache.delete(oldestSelector);
    }
  }

}
