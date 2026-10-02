/**
 * @module auth/tokenCache
 * @description Concurrent-safe, bounded LRU cache for decoded JWT payloads
 * with in-flight request coalescing.
 *
 * ## Problem
 * Under bursty load (e.g., an API integration opening 50 simultaneous
 * requests, all bearing the same access token) the `requireAuth` middleware
 * would call `jwt.verify()` 50 times for identical tokens — wasting CPU on
 * HMAC computation whose result is deterministic.
 *
 * ## Solution: two-layer defence
 *
 * ### Layer 1 — Promise coalescing (in-flight deduplication)
 * When a token is currently being verified by another concurrent call, the
 * second (and subsequent) callers receive a reference to the *same* Promise
 * rather than initiating a duplicate verification.  This guarantees that N
 * simultaneous requests for the same token trigger exactly one
 * `jwt.verify()` call.
 *
 * ### Layer 2 — LRU result cache (verified-payload memoization)
 * Once verification completes, the decoded payload is stored in a bounded
 * Map.  Subsequent requests for the same token within the TTL window get an
 * instant synchronous result without touching `jwt.verify()` at all.
 *
 * ## Concurrency guarantees
 * - All Map operations occur synchronously on the Node.js event-loop
 *   thread, so there are no torn reads/writes.
 * - The in-flight Map prevents duplicate verifications even when dozens of
 *   requests arrive in the same event-loop tick.
 * - Entries whose `exp` claim has passed are evicted lazily on the next
 *   access for that token, bounding stale-result exposure.
 * - The result cache is capped at `maxEntries`; the oldest insertion is
 *   evicted when capacity is reached to keep memory bounded.
 *
 * ## Security
 * - Only successfully decoded, non-expired payloads are cached.
 * - Verification failures (bad signature, expired token, unknown algorithm)
 *   are NOT cached — every subsequent request with an invalid token still
 *   hits `jwt.verify()` so that a token revoked mid-TTL-window is rejected
 *   as soon as the in-process result expires.
 * - The TTL is capped at `MAX_TTL_MS` (5 min) regardless of the token's
 *   own `exp` claim — even a long-lived service token receives a
 *   conservative server-side cache window.
 *
 * @example
 * ```ts
 * const cache = new TokenCache({ maxEntries: 512, ttlMs: 5 * 60 * 1000 });
 *
 * // In requireAuth middleware:
 * const payload = await cache.verify(rawToken, secret, JWT_VERIFY_OPTIONS);
 * // payload is a JwtPayload or throws (same contract as jwt.verify).
 * ```
 */

import jwt from 'jsonwebtoken';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Opaque JWT payload returned by `jwt.verify`. */
export type JwtPayload = jwt.JwtPayload;

/** Options controlling cache capacity and TTL. */
export interface TokenCacheOptions {
  /**
   * Maximum number of decoded payloads to retain.
   * When the cache is full, the oldest entry is evicted before inserting.
   */
  maxEntries: number;
  /**
   * Maximum cache lifetime in milliseconds for a single entry.
   * Capped internally at MAX_TTL_MS regardless of the caller-supplied value.
   */
  ttlMs: number;
}

/** A single cached result entry. */
interface CacheEntry {
  payload: JwtPayload;
  /** Absolute epoch-ms at which this entry should be considered stale. */
  expiresAt: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Hard upper bound on result cache TTL (5 minutes). */
const MAX_TTL_MS = 5 * 60 * 1000;

// ─── TokenCache ───────────────────────────────────────────────────────────────

/**
 * Concurrent-safe JWT verification cache with in-flight deduplication.
 *
 * Thread-safety model: Node.js runs JavaScript on a single event-loop
 * thread, so all Map mutations are serialized — no locks are required.
 * The coalescing guarantee (only one `jwt.verify` per distinct in-flight
 * token) holds because Promise resolution callbacks are queued and
 * executed between event-loop ticks; any concurrent caller that arrives
 * before the first resolution will find the in-flight entry and attach to
 * it.
 */
export class TokenCache {
  private readonly maxEntries: number;
  private readonly ttlMs: number;

  /**
   * Memoized results for successfully decoded tokens.
   * Map preserves insertion order so oldest = first key.
   */
  private readonly results = new Map<string, CacheEntry>();

  /**
   * In-flight verifications keyed by token string.
   * While a verification Promise is pending, all concurrent callers for
   * the same token attach to this Promise instead of starting a new one.
   */
  private readonly inFlight = new Map<string, Promise<JwtPayload>>();

  // Observable counters (no Prometheus dependency — callers instrument if needed)
  private _hits = 0;
  private _misses = 0;
  private _coalescedHits = 0;

  constructor(options: TokenCacheOptions) {
    this.maxEntries = Math.max(1, options.maxEntries);
    this.ttlMs = Math.min(options.ttlMs, MAX_TTL_MS);
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Verify a JWT token, returning a cached payload when available.
   *
   * Semantics mirror `jwt.verify(token, secret, options)`:
   * - Resolves with the decoded `JwtPayload` on success.
   * - Rejects with a `JsonWebTokenError`, `TokenExpiredError`, or
   *   `NotBeforeError` on any verification failure.
   *
   * Caching contract:
   * - Only successful verifications are cached.
   * - Failures propagate to the caller unchanged and are never cached,
   *   so a retried request with the same (still-invalid) token always
   *   re-runs `jwt.verify`.
   *
   * @param token   - The raw JWT string (must already be trimmed).
   * @param secret  - The HMAC secret or public key.
   * @param options - `jsonwebtoken.VerifyOptions` (algorithm allowlist, etc.).
   * @returns The decoded, validated payload.
   * @throws `JsonWebTokenError` | `TokenExpiredError` | `NotBeforeError`
   */
  async verify(
    token: string,
    secret: string,
    options: jwt.VerifyOptions,
  ): Promise<JwtPayload> {
    // ── Layer 2: result cache ─────────────────────────────────────────────
    const cached = this.getFromResultCache(token);
    if (cached !== undefined) {
      this._hits++;
      return cached;
    }

    // ── Layer 1: in-flight coalescing ─────────────────────────────────────
    const existing = this.inFlight.get(token);
    if (existing) {
      this._coalescedHits++;
      return existing;
    }

    // ── Slow path: start a new verification ───────────────────────────────
    this._misses++;
    const verifyPromise = this.runVerify(token, secret, options);
    this.inFlight.set(token, verifyPromise);

    try {
      const payload = await verifyPromise;
      this.storeInResultCache(token, payload);
      return payload;
    } finally {
      // Always remove the in-flight entry regardless of success/failure so
      // a subsequent retry starts a fresh verification rather than
      // permanently attaching to a failed Promise.
      this.inFlight.delete(token);
    }
  }

  /**
   * Synchronously invalidate a cached entry by token string.
   * No-op when the token is not in the cache.
   *
   * Use this when the token is revoked or the user is logged out, so the
   * next request re-verifies against the current secret.
   */
  invalidate(token: string): void {
    this.results.delete(token);
    // In-flight entries are intentionally left running — they will
    // self-clean via the `finally` block in `verify()`.
  }

  /** Evict all cached results. In-flight verifications are unaffected. */
  clear(): void {
    this.results.clear();
  }

  /** Diagnostic counters for observability (no side-effects). */
  getStats(): { size: number; hits: number; misses: number; coalescedHits: number } {
    return {
      size: this.results.size,
      hits: this._hits,
      misses: this._misses,
      coalescedHits: this._coalescedHits,
    };
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  /**
   * Retrieve a live entry from the result cache.
   * Returns `undefined` on a miss or a stale entry (stale entries are
   * lazily evicted).
   */
  private getFromResultCache(token: string): JwtPayload | undefined {
    const entry = this.results.get(token);
    if (!entry) return undefined;

    if (Date.now() >= entry.expiresAt) {
      this.results.delete(token);
      return undefined;
    }

    return entry.payload;
  }

  /**
   * Insert a decoded payload into the result cache.
   *
   * Eviction policy: if the cache is at capacity, delete the first (oldest)
   * key before inserting.  Map preserves insertion order so this is O(1)
   * and correct even when entries are accessed out of order.
   *
   * TTL is the minimum of `this.ttlMs` and the time remaining until the
   * token's own `exp` claim — a token expiring in 2 min should not be
   * cached for 5 min.
   */
  private storeInResultCache(token: string, payload: JwtPayload): void {
    // Never overwrite an existing live entry (a concurrent caller may have
    // already stored it while this branch was awaiting).
    if (this.results.has(token)) return;

    if (this.results.size >= this.maxEntries) {
      const oldest = this.results.keys().next().value;
      if (oldest !== undefined) {
        this.results.delete(oldest);
      }
    }

    // Respect the token's own expiry when computing cache TTL.
    let cacheTtl = this.ttlMs;
    if (typeof payload.exp === 'number') {
      const msUntilExp = payload.exp * 1000 - Date.now();
      if (msUntilExp <= 0) {
        // Token already expired — do not cache.
        return;
      }
      cacheTtl = Math.min(cacheTtl, msUntilExp);
    }

    this.results.set(token, {
      payload,
      expiresAt: Date.now() + cacheTtl,
    });
  }

  /**
   * Wraps `jwt.verify` in a Promise.  The synchronous `jwt.verify` call is
   * fine here because it is CPU-bound (HMAC) and fast.  Wrapping in a
   * Promise keeps the coalescing logic uniform.
   */
  private runVerify(
    token: string,
    secret: string,
    options: jwt.VerifyOptions,
  ): Promise<JwtPayload> {
    return new Promise<JwtPayload>((resolve, reject) => {
      try {
        const payload = jwt.verify(token, secret, options) as JwtPayload;
        resolve(payload);
      } catch (err) {
        reject(err);
      }
    });
  }
}

// ─── Module-level singleton ───────────────────────────────────────────────────

/**
 * Shared `TokenCache` instance used by `requireAuth` in
 * `middleware/authorization.ts`.
 *
 * Sizing rationale:
 * - 512 entries covers the vast majority of active sessions in a
 *   moderately busy service (each entry is a small plain object).
 * - 5-minute TTL is conservative relative to the 15-minute JWT lifetime,
 *   limiting the window during which a revoked token could be served from
 *   cache.
 *
 * Exposed as a named export so tests can call `sharedTokenCache.clear()`
 * for isolation and `sharedTokenCache.getStats()` for assertions.
 */
export const sharedTokenCache = new TokenCache({
  maxEntries: 512,
  ttlMs: MAX_TTL_MS,
});
