/**
 * Configurable fixed-window rate limiter for named policies.
 *
 * Each policy has its own request budget per window (default 60 s).
 * The client map is bounded to `maxClients` entries; when it fills, the
 * oldest key (insertion order) is evicted so memory stays constant.
 *
 * An injectable clock makes the implementation unit-testable without
 * real timers.
 */

export type RateLimitPolicy = 'default' | 'auth' | 'tx' | 'chain';

export interface RateLimitConfig {
  /** Requests per window for each policy (0 or negative = unlimited). */
  limits: Record<RateLimitPolicy, number>;
  /** Window size in milliseconds (default 60 000). */
  windowMs?: number;
  /** Maximum number of distinct client keys to track per policy (default 4096). */
  maxClients?: number;
  /** Monotonic clock in milliseconds (default Date.now). */
  now?: () => number;
  /** When false all checks pass regardless of counts (master on/off switch). */
  enabled?: boolean;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Remaining requests in the current window (after this one is counted). */
  remaining: number;
  /** Total limit for the window. */
  limit: number;
  /** Epoch-second timestamp when the window resets. */
  resetAt: number;
  /** Seconds until the window resets (ceil). */
  retryAfter: number;
}

interface ClientBucket {
  windowStarted: number;
  count: number;
}

class PolicyLimiter {
  private readonly clients = new Map<string, ClientBucket>();

  constructor(
    private readonly maxRequests: number,
    private readonly windowMs: number,
    private readonly maxClients: number,
    private readonly now: () => number,
  ) {}

  check(key: string): RateLimitResult {
    const ts = this.now();
    const resetAt = Math.ceil((ts + this.windowMs) / 1000); // epoch-s, pessimistic

    // Unlimited policy
    if (this.maxRequests <= 0) {
      return { allowed: true, remaining: Infinity, limit: Infinity, resetAt, retryAfter: 0 };
    }

    let bucket = this.clients.get(key);
    if (!bucket || ts - bucket.windowStarted >= this.windowMs) {
      // New window — evict oldest entry if map is at capacity
      if (!bucket && this.clients.size >= this.maxClients) {
        this.clients.delete(this.clients.keys().next().value as string);
      }
      bucket = { windowStarted: ts, count: 0 };
      this.clients.set(key, bucket);
    }

    const windowResetAt = Math.ceil((bucket.windowStarted + this.windowMs) / 1000);

    if (bucket.count >= this.maxRequests) {
      return {
        allowed: false,
        remaining: 0,
        limit: this.maxRequests,
        resetAt: windowResetAt,
        // Clamp to windowMs / 1000 so the value never exceeds the configured window.
        retryAfter: Math.min(
          Math.ceil(this.windowMs / 1000),
          Math.max(1, windowResetAt - Math.floor(ts / 1000)),
        ),
      };
    }

    bucket.count += 1;
    return {
      allowed: true,
      remaining: this.maxRequests - bucket.count,
      limit: this.maxRequests,
      resetAt: windowResetAt,
      retryAfter: 0,
    };
  }

  /** Evict all buckets whose window has fully expired (called by RateLimiter.evictStale). */
  evictStale(): void {
    const ts = this.now();
    for (const [key, bucket] of this.clients) {
      if (ts - bucket.windowStarted >= this.windowMs) {
        this.clients.delete(key);
      }
    }
  }

  get size(): number {
    return this.clients.size;
  }
}

export class RateLimiter {
  private readonly policies: Map<RateLimitPolicy, PolicyLimiter>;
  private readonly enabled: boolean;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(cfg: RateLimitConfig) {
    this.enabled = cfg.enabled ?? true;
    this.windowMs = cfg.windowMs ?? 60_000;
    this.now = cfg.now ?? Date.now;
    const maxClients = cfg.maxClients ?? 4096;

    this.policies = new Map();
    for (const name of ['default', 'auth', 'tx', 'chain'] as RateLimitPolicy[]) {
      this.policies.set(
        name,
        new PolicyLimiter(cfg.limits[name], this.windowMs, maxClients, this.now),
      );
    }
  }

  /**
   * Check whether `key` is within the budget for `policy`.
   * When the limiter is disabled every call returns `allowed: true`.
   */
  check(policy: RateLimitPolicy, key: string): RateLimitResult {
    if (!this.enabled) {
      const ts = this.now();
      return { allowed: true, remaining: Infinity, limit: Infinity, resetAt: Math.ceil((ts + this.windowMs) / 1000), retryAfter: 0 };
    }
    return this.policies.get(policy)!.check(key);
  }

  /** Remove expired buckets across all policies (call periodically if desired). */
  evictStale(): void {
    for (const limiter of this.policies.values()) {
      limiter.evictStale();
    }
  }

  /** Number of tracked clients for a policy (useful in tests). */
  clientCount(policy: RateLimitPolicy): number {
    return this.policies.get(policy)!.size;
  }
}

/**
 * Build a RateLimiter from the application environment.
 *
 * Environment variables:
 *   RATE_LIMIT_ENABLED          "false" to disable globally (default true)
 *   RATE_LIMIT_DEFAULT_PER_MIN  default policy (default 120)
 *   RATE_LIMIT_AUTH_PER_MIN     auth/token policy (default 20)
 *   RATE_LIMIT_TX_PER_MIN       tx/build + tx/submit policy (default 60)
 *
 * The chain policy always reads from CHAIN_RATE_LIMIT_PER_MIN (default 60) so
 * the existing ChainRateLimiter behaviour is preserved.
 */
export function createRateLimiterFromEnv(overrides?: Partial<RateLimitConfig>): RateLimiter {
  const enabled = process.env.RATE_LIMIT_ENABLED !== 'false';
  const parseLimit = (name: string, fallback: number): number => {
    const raw = process.env[name];
    if (!raw || raw.trim() === '') return fallback;
    const n = Number(raw.trim());
    if (!Number.isInteger(n) || n < 0) throw new Error(`Invalid ${name}: "${raw}". Must be a non-negative integer.`);
    return n;
  };

  return new RateLimiter({
    enabled,
    windowMs: 60_000,
    maxClients: 4096,
    limits: {
      default: parseLimit('RATE_LIMIT_DEFAULT_PER_MIN', 120),
      auth: parseLimit('RATE_LIMIT_AUTH_PER_MIN', 20),
      tx: parseLimit('RATE_LIMIT_TX_PER_MIN', 60),
      chain: parseLimit('RATE_LIMIT_CHAIN_PER_MIN', 60),
    },
    ...overrides,
  });
}
