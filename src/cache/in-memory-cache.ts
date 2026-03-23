import type { CacheStore } from './cache-store';

interface CacheEntry {
  value: unknown;
  expiresAt: number;
  updatedAt: number;
}

/**
 * @notice Simple in-memory cache with TTL and bounded size.
 * @dev This implementation is intentionally conservative and is suitable for
 *      the current single-process backend shape. It is not intended as a
 *      distributed cache.
 */
export class InMemoryCache implements CacheStore {
  private readonly entries = new Map<string, CacheEntry>();

  /**
   * @param options Cache configuration and clock injection for tests.
   */
  constructor(
    private readonly options: {
      maxItems: number;
      now?: () => number;
    },
  ) {}

  /**
   * @inheritdoc
   */
  get<T>(key: string): T | undefined {
    const entry = this.entries.get(key);

    if (!entry) {
      return undefined;
    }

    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }

    return entry.value as T;
  }

  /**
   * @inheritdoc
   */
  set<T>(key: string, value: T, ttlSeconds: number): void {
    this.evictExpiredEntries();

    if (!this.entries.has(key) && this.entries.size >= this.options.maxItems) {
      this.evictOldestEntry();
    }

    this.entries.set(key, {
      value,
      expiresAt: this.now() + ttlSeconds * 1000,
      updatedAt: this.now(),
    });
  }

  /**
   * @inheritdoc
   */
  delete(key: string): void {
    this.entries.delete(key);
  }

  /**
   * @inheritdoc
   */
  clear(): void {
    this.entries.clear();
  }

  /**
   * @notice Return the current item count for testing.
   */
  size(): number {
    this.evictExpiredEntries();
    return this.entries.size;
  }

  /**
   * @notice Return the active clock time in milliseconds.
   */
  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  /**
   * @notice Remove expired entries opportunistically.
   */
  private evictExpiredEntries(): void {
    for (const [key, entry] of this.entries.entries()) {
      if (entry.expiresAt <= this.now()) {
        this.entries.delete(key);
      }
    }
  }

  /**
   * @notice Remove the least recently written entry to keep memory bounded.
   */
  private evictOldestEntry(): void {
    let oldestKey: string | undefined;
    let oldestUpdatedAt = Number.POSITIVE_INFINITY;

    for (const [key, entry] of this.entries.entries()) {
      if (entry.updatedAt < oldestUpdatedAt) {
        oldestUpdatedAt = entry.updatedAt;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.entries.delete(oldestKey);
    }
  }
}
