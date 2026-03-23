/**
 * @notice Generic cache interface used by the backend cache layer.
 * @dev The implementation is intentionally small so the backend can switch
 *      cache backends later without changing route or service logic.
 */
export interface CacheStore {
  /**
   * @notice Read a cached value by key.
   * @param key Deterministic cache key.
   */
  get<T>(key: string): T | undefined;

  /**
   * @notice Write a cached value with a TTL.
   * @param key Deterministic cache key.
   * @param value Value to cache.
   * @param ttlSeconds Time to live in seconds.
   */
  set<T>(key: string, value: T, ttlSeconds: number): void;

  /**
   * @notice Delete a single cache entry.
   * @param key Deterministic cache key.
   */
  delete(key: string): void;

  /**
   * @notice Remove all cache entries for this store.
   */
  clear(): void;
}
