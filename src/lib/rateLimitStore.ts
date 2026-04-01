/**
 * @module rateLimitStore
 * @description
 * In-memory store for rate limiting using a sliding-window counter algorithm.
 *
 * Each entry tracks:
 *   - `count`     – requests in the current window
 *   - `windowStart` – epoch ms when the current window began
 *   - `blocked`   – if the key is hard-blocked (abuse guard)
 *   - `blockedUntil` – epoch ms when the block expires
 *
 * The store auto-expires stale entries via a periodic sweep to prevent
 * unbounded memory growth in production.
 *
 * @security
 *   - Keys are hashed before storage to avoid leaking raw IPs in memory dumps.
 *   - Blocked entries survive the sweep until `blockedUntil` passes.
 */

import { createHash } from 'crypto';

export interface RateLimitEntry {
  count: number;
  windowStart: number;
  blocked: boolean;
  blockedUntil: number;
}

export interface StoreOptions {
  /** How often (ms) the GC sweep runs. Default: 60_000 */
  sweepIntervalMs?: number;
}

export class RateLimitStore {
  private readonly store = new Map<string, RateLimitEntry>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: StoreOptions = {}) {
    const interval = options.sweepIntervalMs ?? 60_000;
    this.sweepTimer = setInterval(() => this.sweep(), interval);
    // Allow Node to exit even if this timer is active
    if (this.sweepTimer.unref) this.sweepTimer.unref();
  }

  /**
   * Derive a stable, opaque key from a raw identifier (e.g. IP address).
   * Using SHA-256 prevents raw PII from appearing in heap snapshots.
   */
  static hashKey(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
  }

  /** Retrieve an entry or undefined if it doesn't exist. */
  get(rawKey: string): RateLimitEntry | undefined {
    return this.store.get(RateLimitStore.hashKey(rawKey));
  }

  /** Upsert an entry. */
  set(rawKey: string, entry: RateLimitEntry): void {
    this.store.set(RateLimitStore.hashKey(rawKey), entry);
  }

  /** Delete an entry. */
  delete(rawKey: string): void {
    this.store.delete(RateLimitStore.hashKey(rawKey));
  }

  /** Total number of tracked keys (for diagnostics). */
  get size(): number {
    return this.store.size;
  }

  /**
   * Remove entries whose windows have expired AND whose block has lifted.
   * Called automatically; exposed for testing.
   */
  sweep(windowMs = 60_000): void {
    const now = Date.now();
    for (const [key, entry] of this.store.entries()) {
      const windowExpired = now - entry.windowStart > windowMs;
      const blockExpired = !entry.blocked || now > entry.blockedUntil;
      if (windowExpired && blockExpired) {
        this.store.delete(key);
      }
    }
  }

  /** Stop the background sweep (call in tests / shutdown). */
  destroy(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.store.clear();
  }
}