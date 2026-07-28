/**
 * @module rateLimitStore
 * @description Shared in-process storage for all rate-limit state.
 *
 * The HTTP middleware uses fixed-window counter entries, while the outbound
 * webhook limiter uses token-bucket entries. Both paths store their data
 * through the same interface so key hashing, lifecycle, and cleanup semantics
 * stay consistent.
 *
 * @security
 *   - Keys are hashed before storage to avoid leaking raw IPs, hostnames, or
 *     provider IDs in heap snapshots.
 *   - Blocked counter entries survive the sweep until `blockedUntil` passes.
 */

import { createHash } from 'crypto';

export interface RateLimitEntry {
  count: number;
  windowStart: number;
  blocked: boolean;
  blockedUntil: number;
}

export interface TokenBucketEntry {
  /** Current token count, including fractional tokens between refill ticks. */
  tokens: number;
  /** Epoch millisecond timestamp of the last refill calculation. */
  lastRefillMs: number;
  /** FIFO queue of in-process waiters released when tokens refill. */
  queue: Array<() => void>;
}

export interface StoreOptions {
  /** How often (ms) the GC sweep runs. Default: 60_000 */
  sweepIntervalMs?: number;
}

/**
 * Unified storage contract for rate limiting.
 *
 * Implementations must hash or otherwise protect raw keys before persistence.
 * Counter operations are used by Express request limiting. Token bucket
 * operations are used by outbound webhook delivery pacing. `sweep` only removes
 * stale counter entries because token-bucket queues may contain live waiters.
 */
export interface RateLimitStoreInterface {
  /** Retrieve a fixed-window counter entry for a raw rate-limit key. */
  get(rawKey: string): RateLimitEntry | undefined;
  /** Upsert a fixed-window counter entry for a raw rate-limit key. */
  set(rawKey: string, entry: RateLimitEntry): void;
  /** Delete all rate-limit state associated with a raw key. */
  delete(rawKey: string): void;
  /** Retrieve a token-bucket entry for a raw provider key. */
  getTokenBucket(rawKey: string): TokenBucketEntry | undefined;
  /** Upsert a token-bucket entry for a raw provider key. */
  setTokenBucket(rawKey: string, entry: TokenBucketEntry): void;
  /** Number of fixed-window counter entries tracked by this store. */
  readonly size: number;
  /** Number of token-bucket entries tracked by this store. */
  readonly tokenBucketSize: number;
  /** Remove stale fixed-window entries. */
  sweep(windowMs?: number): void;
  /** Clear all stored state without destroying the store. */
  clear(): void;
  /** Stop background work and clear all stored state. */
  destroy(): void;
}

export class RateLimitStore implements RateLimitStoreInterface {
  private readonly counters = new Map<string, RateLimitEntry>();
  private readonly tokenBuckets = new Map<string, TokenBucketEntry>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private _destroyed = false;

  constructor(options: StoreOptions = {}) {
    const interval = options.sweepIntervalMs ?? 60_000;
    if (interval > 0) {
      const timer: ReturnType<typeof setInterval> = setInterval(() => this.sweep(), interval);
      if (typeof (timer as unknown as { unref?: () => void }).unref === 'function') {
        (timer as unknown as { unref: () => void }).unref();
      }
      this.sweepTimer = timer;
    }
  }

  /** Returns true if the store has been destroyed. */
  get destroyed(): boolean {
    return this._destroyed;
  }

  /**
   * Derive a stable, opaque key from a raw identifier.
   * Using SHA-256 prevents raw PII or provider identifiers from appearing in
   * heap snapshots.
   */
  static hashKey(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
  }

  /** Retrieve a fixed-window counter entry or undefined if it does not exist. */
  get(rawKey: string): RateLimitEntry | undefined {
    return this.counters.get(RateLimitStore.hashKey(rawKey));
  }

  /** Upsert a fixed-window counter entry. */
  set(rawKey: string, entry: RateLimitEntry): void {
    this.counters.set(RateLimitStore.hashKey(rawKey), entry);
  }

  /** Delete both counter and token-bucket state for a raw key. */
  delete(rawKey: string): void {
    const hashedKey = RateLimitStore.hashKey(rawKey);
    this.counters.delete(hashedKey);
    this.tokenBuckets.delete(hashedKey);
  }

  /** Retrieve a token-bucket entry or undefined if it does not exist. */
  getTokenBucket(rawKey: string): TokenBucketEntry | undefined {
    return this.tokenBuckets.get(RateLimitStore.hashKey(rawKey));
  }

  /** Upsert a token-bucket entry. */
  setTokenBucket(rawKey: string, entry: TokenBucketEntry): void {
    this.tokenBuckets.set(RateLimitStore.hashKey(rawKey), entry);
  }

  /** Total number of fixed-window counter keys. */
  get size(): number {
    return this.counters.size;
  }

  /** Total number of token-bucket keys. */
  get tokenBucketSize(): number {
    return this.tokenBuckets.size;
  }

  /**
   * Remove counter entries whose windows have expired and whose block has
   * lifted. Token buckets are intentionally not swept here because queued
   * waiters are live in-process callbacks.
   */
  sweep(windowMs = 60_000): void {
    if (this._destroyed) return;
    const now = Date.now();
    for (const [key, entry] of this.counters.entries()) {
      const windowExpired = now - entry.windowStart > windowMs;
      const blockExpired = !entry.blocked || now > entry.blockedUntil;
      if (windowExpired && blockExpired) {
        this.counters.delete(key);
      }
    }
  }

  /** Clear all stored state. */
  clear(): void {
    this.counters.clear();
    this.tokenBuckets.clear();
  }

  /** Stop the background sweep and clear all entries. */
  destroy(): void {
    this._destroyed = true;
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.clear();
  }
}
