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
 *
 * Concurrency (INV-C1 / INV-C2 below)
 * -------------------------------
 * The cache is shared by every concurrent request, so two properties matter as
 * much as hit rate:
 *
 * INV-C1 — Single flight: concurrent misses for the same selector run the loader
 *          exactly once. A burst of requests carrying the same API key must not
 *          each perform a database read plus a PBKDF2 verification (10,000
 *          synchronous iterations) and each write `last_used_at`; those
 *          duplicates serialise on the event loop and turn one request into N.
 *
 * INV-C2 — No stale repopulation: an in-flight load that resolves *after* a
 *          concurrent invalidation (deactivate / rotate / user-wide purge) must
 *          not publish its result. Otherwise the pre-revocation identity wins
 *          the race and keeps authenticating for a whole TTL after the key was
 *          revoked.
 *
 * Metrics:
 *   - Cache hits and misses are tracked via Prometheus counters
 *
 * Concurrency notes:
 *   - All methods execute synchronously on the Node.js event-loop thread, so
 *     Map operations are atomic from the perspective of concurrent async code.
 *   - `set()` atomically checks capacity AND inserts in a single synchronous
 *     pass, preventing the check-then-act race where two concurrent callers
 *     could both observe `size >= maxEntries` before either inserts, causing
 *     the cache to transiently exceed its capacity bound.
 *   - `evictOldest()` runs inside `set()` before the new entry is added, so
 *     the post-insert size is always ≤ maxEntries.
 *   - `cleanupExpired()` collects keys then deletes them in the same
 *     synchronous call, ensuring no intermediate state is observable.
 */

import { Counter, Registry } from 'prom-client';
import { ApiKeyInfo } from './apiKeys';

export interface AuthCacheOptions {
  ttlMs: number;
  maxEntries: number;
}

export interface CacheEntry {
  info: ApiKeyInfo;
  expiresAt: number;
  lastAccessed: number;
}

export interface AuthCacheStats {
  size: number;
  hits: number;
  misses: number;
}

/**
 * Whether a credential's own `expiresAt` has passed.
 *
 * Distinct from {@link CacheEntry.expiresAt}, which is the cache's own TTL for
 * the entry. A credential can expire while its cached entry is still within TTL
 * (e.g. a key issued with a short lifetime), so both have to be checked before
 * an identity is served.
 */
function isCredentialExpired(info: ApiKeyInfo): boolean {
  if (!info.expiresAt) return false;
  const expiresAt =
    info.expiresAt instanceof Date ? info.expiresAt.getTime() : new Date(info.expiresAt).getTime();
  return Number.isFinite(expiresAt) && Date.now() >= expiresAt;
}

/**
 * LRU cache with TTL for auth read responses.
 */
export class AuthCache {
  private cache: Map<string, CacheEntry>;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private generation = 0;
  private hits: Counter<string>;
  private misses: Counter<string>;
  private hitCount: number;
  private missCount: number;
  /** INV-C1: in-flight loads keyed by selector, shared by concurrent callers. */
  private inFlight: Map<string, Promise<ApiKeyInfo | null>>;
  /**
   * INV-C2: monotonically increasing counter bumped by every invalidation.
   *
   * A load records the epoch it started in and refuses to publish if the epoch
   * moved underneath it. Bumping globally (rather than per selector) also
   * covers `invalidateByUserId` and `clear`, where the selectors to bump are not
   * known up front. The cost is only that loads in flight at the exact moment of
   * a write are not cached — writes are rare, so this is cheap and strictly
   * safer than trying to be precise.
   */
  private epoch: number;

    this.ttlMs = options.ttlMs;
    this.maxEntries = options.maxEntries;
    this.cache = new Map();
    this.inFlight = new Map();
    this.epoch = 0;
    this.hitCount = 0;
    this.missCount = 0;
    this.lruHead = null;
    this.lruTail = null;
    this.lruNodes = new Map();

    // Initialize metrics. Reuse the provided registry when it is a Registry;
    // otherwise fall back to a private registry so tests and callers do not
    // accidentally collide on the global registry.
    const registry = register instanceof Registry ? register : new Registry();

    this.hits = new Counter({
      name: 'auth_cache_hits_total',
      help: 'Total number of auth cache hits.',
      registers: [registry],
    });

    this.misses = new Counter({
      name: 'auth_cache_misses_total',
      help: 'Total number of auth cache misses.',
      registers: [registry],
    });
  }

  /**
   * Get a cached API key info by its selector.
   * 
   * Thread-safe: Multiple concurrent calls for the same selector will share
   * the same cache lookup without race conditions.
   *
   * @param selector - The key selector (SHA-256 hash of the API key)
   * @returns The cached API key info if valid and not expired, null otherwise
   * @throws TypeError if `selector` is not a non-empty string
   */
  get(selector: string): ApiKeyInfo | null {
    if (!isNonEmptyString(selector)) {
      throw new TypeError('AuthCache.get: selector must be a non-empty string');
    }

    const entry = this.cache.get(selector);
    const now = Date.now();

      if (!entry) {
        this.misses.inc();
        this.missCount++;
        this.recordTiming('get_miss', startTime);
        return null;
      }

      // Check if entry has expired
      if (now > entry.expiresAt) {
        this.cache.delete(selector);
        this.misses.inc();
        this.missCount++;
        this.recordTiming('get_expired', startTime);
        return null;
      }

      // Update last accessed time for LRU eviction
      entry.lastAccessed = now;
      this.hits.inc();
      this.hitCount++;
      this.recordTiming('get_hit', startTime);
      return entry.info;
    } catch (error) {
      this.recordTiming('get_error', startTime);
      throw error;
    }
  }

  /**
   * Async get with in-flight operation deduplication.
   * 
   * Prevents cache stampede: If multiple concurrent requests for the same selector
   * arrive and the cache is empty, only one fetch operation will be performed and
   * all callers will receive the same result.
   *
   * @param selector - The key selector
   * @param fetchFn - Function to fetch the value if not cached
   * @returns The cached or fetched API key info
   */
  async getOrFetch(
    selector: string,
    fetchFn: () => Promise<ApiKeyInfo | null>
  ): Promise<ApiKeyInfo | null> {
    const startTime = Date.now();

    // Check cache first (synchronous)
    const cached = this.get(selector);
    if (cached !== null) {
      return cached;
    }

    // Check if entry has expired
    if (now >= entry.expiresAt) {
      this.cache.delete(selector);
      this.misses.inc();
      this.missCount++;
      return null;
    }

    // Update last accessed time for LRU eviction and move to tail.
    entry.lastAccessed = now;
    this.touchLru(selector);
    this.hits.inc();
    this.hitCount++;
    return cloneApiKeyInfo(entry.info);
  }

  /**
   * Returns a snapshot used to prevent stale in-flight reads from refilling
   * the cache after an invalidation.
   */
  getGeneration(): number {
    return this.generation;
  }

  /**
   * Set a cache entry for a key selector.
   * 
   * Thread-safe: Uses write lock to ensure atomic updates.
   *
   * INV-C1 corollary: a cached identity is handed to every request that hits it,
   * so it is frozen. Without this, a request that mutates `req.apiKey` (for
   * example filtering `scope` in place) would silently rewrite the authorization
   * view seen by every other concurrent request sharing the entry.
   *
   * Concurrency invariant: the capacity check and the insertion happen in the
   * same synchronous operation. Because Node.js is single-threaded, no other
   * code can observe the Map between the size check and the set() call, so the
   * cache size never transiently exceeds maxEntries.
   *
   * Specifically:
   *   1. If selector already exists, overwrite it — no eviction needed.
   *   2. If selector is new and cache is at capacity, evict one entry FIRST,
   *      then insert. This keeps size ≤ maxEntries at all times.
   *
   * @param selector - The key selector (SHA-256 hash of the API key)
   * @param info - The API key info to cache
   * @throws TypeError if `selector` or `info` is invalid
   */
  set(selector: string, info: ApiKeyInfo): void {
    if (!isNonEmptyString(selector)) {
      throw new TypeError('AuthCache.set: selector must be a non-empty string');
    }

    assertValidApiKeyInfo(info);

    const now = Date.now();
    const cacheExpiresAt = now + this.ttlMs;
    const keyExpiresAt = info.expiresAt?.getTime();
    const entry: CacheEntry = {
      info: Object.freeze(info),
      expiresAt: now + this.ttlMs,
      lastAccessed: now,
    };

    // If the selector is new and we are at capacity, evict before inserting.
    // Checking `has` before `size` avoids an unnecessary eviction when updating
    // an existing entry (which doesn't change the Map's size).
    if (!this.cache.has(selector) && this.cache.size >= this.maxEntries) {
      this.evictOldest();
    }

    this.cache.set(selector, entry);
    this.touchLru(selector);
  }

  /**
   * Async set with write lock for thread-safe updates.
   * 
   * @param selector - The key selector
   * @param info - The API key info to cache
   */
  async setAsync(selector: string, info: ApiKeyInfo): Promise<void> {
    const startTime = Date.now();
    
    // Acquire write lock
    const previousLock = this.writeLock;
    let releaseLock: () => void;
    
    this.writeLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    try {
      await previousLock;
      this.set(selector, info);
      this.recordTiming('setAsync', startTime);
    } finally {
      releaseLock!();
    }
  }

  /**
   * Returns a cached identity, or runs `loader` once for concurrent callers of
   * the same selector and caches a successful result.
   *
   * Semantics:
   * - cache hit (and the credential has not itself expired) → returns immediately.
   * - concurrent miss → every caller receives the *same* promise, so the loader
   *   runs exactly once (INV-C1).
   * - the loader's result is published only if no invalidation happened while it
   *   was in flight (INV-C2).
   * - a `null` result (unknown / rejected credential) is deliberately **not**
   *   cached, so a revoked key re-checks against the store rather than being
   *   pinned; concurrent callers still share the single load.
   * - a rejected load rejects for every joined caller and is not cached; the
   *   in-flight entry is cleared so the next attempt retries.
   *
   * @param selector - The key selector (SHA-256 digest of the API key).
   * @param loader   - Produces the identity to cache on a miss.
   */
  async getOrLoad(
    selector: string,
    loader: () => Promise<ApiKeyInfo | null>
  ): Promise<ApiKeyInfo | null> {
    const cached = this.get(selector);
    if (cached) {
      if (!isCredentialExpired(cached)) {
        return cached;
      }
      // The credential outlived its own expiry while still inside the cache TTL:
      // drop it and fall through to a fresh load.
      this.invalidate(selector);
    }

    const existing = this.inFlight.get(selector);
    if (existing) {
      return existing;
    }

    const epoch = this.epoch;
    const pending = (async () => {
      const info = await loader();
      if (info !== null && this.epoch === epoch) {
        this.set(selector, info);
      }
      return info;
    })().finally(() => {
      this.inFlight.delete(selector);
    });

    this.inFlight.set(selector, pending);
    return pending;
  }

  /**
   * Invalidate a cache entry by selector.
   * 
   * Thread-safe: Uses write lock to ensure atomic invalidation.
   *
   * @param selector - The key selector to invalidate
   * @throws TypeError if `selector` is not a non-empty string
   */
  invalidate(selector: string): void {
    if (!isNonEmptyString(selector)) {
      throw new TypeError('AuthCache.invalidate: selector must be a non-empty string');
    }

    this.cache.delete(selector);
    this.epoch++;
  }

  /**
   * Invalidate all cache entries for a specific user ID.
   * 
   * Thread-safe: Uses write lock to ensure atomic batch invalidation.
   *
   * Iterates over the entire cache once, collecting selectors whose
   * `createdBy` matches the given userId, then deletes them in a second
   * synchronous pass. Both passes happen in the same event-loop turn so
   * no entries can be concurrently inserted between collection and deletion.
   *
   * @param userId - The user ID whose cache entries should be invalidated
   * @throws TypeError if `userId` is not a non-empty string
   */
  invalidateByUserId(userId: string): void {
    if (!isNonEmptyString(userId)) {
      throw new TypeError('AuthCache.invalidateByUserId: userId must be a non-empty string');
    }

    const selectorsToDelete: string[] = [];
    this.cache.forEach((entry, selector) => {
      if (entry.info.createdBy === userId) {
        selectorsToDelete.push(selector);
      }
    });
    selectorsToDelete.forEach(selector => this.cache.delete(selector));
    this.epoch++;
  }

  /**
   * Clear all cache entries.
   */
  clear(): void {
    this.generation += 1;
    this.cache.clear();
    this.epoch++;
  }

  /**
   * Get current cache statistics.
   */
  getStats(): AuthCacheStats {
    return {
      size: this.cache.size,
      hits: this.hitCount,
      misses: this.missCount,
      inFlightOps: this.inFlightOps.size,
      timings,
    };
  }

  /**
   * Record timing information for operations.
   * 
   * @param operation - The operation name
   * @param startTime - The operation start time
   */
  private recordTiming(operation: string, startTime: number): void {
    const duration = Date.now() - startTime;
    
    if (!this.operationTimings.has(operation)) {
      this.operationTimings.set(operation, []);
    }
    
    const timings = this.operationTimings.get(operation)!;
    timings.push(duration);
    
    // Keep only last 1000 measurements per operation to prevent memory leak
    if (timings.length > 1000) {
      timings.shift();
    }
  }

  /**
   * Clean up stale in-flight operations (called periodically).
   * 
   * Removes operations that have been in-flight for longer than the TTL,
   * which may indicate a hung promise or error condition.
   * 
   * @param maxAgeMs - Maximum age in milliseconds for in-flight operations
   * @returns Number of stale operations cleaned
   */
  cleanupStaleInFlight(maxAgeMs: number = this.ttlMs * 2): number {
    const now = Date.now();
    let cleaned = 0;
    const selectorsToDelete: string[] = [];

    this.inFlightOps.forEach((op, selector) => {
      if (now - op.timestamp > maxAgeMs) {
        selectorsToDelete.push(selector);
      }
    });

    selectorsToDelete.forEach(selector => {
      this.inFlightOps.delete(selector);
      cleaned++;
    });

    return cleaned;
  }

  /**
   * Evict the least recently used entry.
   *
   * Scans all entries to find the one with the smallest `lastAccessed`
   * timestamp (i.e. the one that has not been read for the longest time).
   * Called synchronously from `set()` before a new entry is added, so
   * the cache size invariant (≤ maxEntries) is maintained atomically from
   * the event-loop's perspective.
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

    if (oldestSelector === null) {
      throw new Error('AuthCache: evictOldest called on an empty cache');
    }

    this.cache.delete(oldestSelector);
  }

  /**
   * Clean up expired entries (called periodically).
   *
   * Collects all expired selectors in one synchronous pass, then removes
   * them in a second pass. Both passes execute within a single event-loop
   * turn, so the set of entries visible to `get()` immediately after this
   * call contains no expired entries.
   *
   * @returns The number of entries that were removed.
   */
  cleanupExpired(): number {
    const now = Date.now();
    let cleaned = 0;
    const selectorsToDelete: string[] = [];

    this.cache.forEach((entry, selector) => {
      if (now >= entry.expiresAt) {
        selectorsToDelete.push(selector);
      }
    });

    selectorsToDelete.forEach(selector => {
      this.removeEntry(selector);
      cleaned++;
    });

    return cleaned;
  }

  /**
   * Remove an entry from both the map and the LRU list.
   * No-op if the selector is not present.
   */
  private removeEntry(selector: string): void {
    if (!this.cache.delete(selector)) {
      return;
    }
    const node = this.lruNodes.get(selector);
    if (node) {
      this.detachNode(node);
      this.lruNodes.delete(selector);
    }
  }

  /**
   * Move a key to the tail (MRU) in the LRU list, creating a node if needed.
   */
  private touchLru(selector: string): void {
    let node = this.lruNodes.get(selector);
    if (!node) {
      node = { key: selector, prev: null, next: null };
      this.lruNodes.set(selector, node);
    } else {
      this.detachNode(node);
    }
    this.appendToTail(node);
  }

  private detachNode(node: LruNode): void {
    if (node.prev) {
      node.prev.next = node.next;
    } else if (this.lruHead === node) {
      this.lruHead = node.next;
    }
    if (node.next) {
      node.next.prev = node.prev;
    } else if (this.lruTail === node) {
      this.lruTail = node.prev;
    }
    node.prev = null;
    node.next = null;
  }

  private appendToTail(node: LruNode): void {
    node.prev = this.lruTail;
    node.next = null;
    if (this.lruTail) {
      this.lruTail.next = node;
    } else {
      this.lruHead = node;
    }
    this.lruTail = node;
  }
}

/**
 * Returns a defensive copy of an ApiKeyInfo object.
 *
 * The cache must not expose internal references to callers and must not
 * store caller-owned references. Otherwise a mutation to a returned object
 * could change authorization decisions for future requests, and a mutation to
 * an input object could silently corrupt cached state.
 */
function cloneApiKeyInfo(info: ApiKeyInfo): ApiKeyInfo {
  return {
    ...info,
    scope: Array.isArray(info.scope) ? [...info.scope] : info.scope,
    createdAt: info.createdAt instanceof Date ? new Date(info.createdAt.getTime()) : info.createdAt,
    expiresAt: info.expiresAt instanceof Date ? new Date(info.expiresAt.getTime()) : info.expiresAt,
  };
}
