/**
 * @title Rate Limiting Configuration
 * @notice Env-driven config for tiered rate limits on sensitive endpoints.
 *
 * ## Environment Variables
 *
 * | Variable                   | Default    | Description                              |
 * |----------------------------|------------|------------------------------------------|
 * | RL_STANDARD_MAX            | 600        | Max requests per window (standard tier)  |
 * | RL_SENSITIVE_MAX           | 300        | Max requests per window (sensitive tier) |
 * | RL_STRICT_MAX              | 180        | Max requests per window (strict tier)    |
 * | RL_AUTH_MAX                | 30         | Max requests per window (auth tier)      |
 * | RL_STANDARD_WINDOW_MS      | 60000      | Window duration in ms (standard)         |
 * | RL_SENSITIVE_WINDOW_MS     | 60000      | Window duration in ms (sensitive)        |
 * | RL_STRICT_WINDOW_MS        | 60000      | Window duration in ms (strict)           |
 * | RL_AUTH_WINDOW_MS          | 60000      | Window duration in ms (auth)             |
 * | RL_AUTH_ABUSE_THRESHOLD    | 3          | Violations before hard block (auth)      |
 * | RL_ABUSE_THRESHOLD         | 5/3        | Violations before hard block             |
 * | RL_BLOCK_WINDOW_MS         | 300000     | Violation observation window             |
 * | RL_BLOCK_DURATION_MS       | 600000     | Initial block duration                   |
 * | RL_MAX_BLOCK_MS            | 86400000   | Maximum block duration (24h)             |
 *
 * ## Tier Descriptions
 *
 * **Standard (600 req/min):** Authenticated read-heavy endpoints. Allows safe
 * bursts of ~10 req/s for legitimate users while preventing coordinated abuse.
 *
 * **Sensitive (300 req/min):** Write operations (POST/PUT/DELETE). Reduces to
 * ~5 req/s to deter automated attacks while allowing legitimate batch operations.
 *
 * **Auth (30 req/min, issue #756):** Authentication endpoints
 * (login/register/refresh/logout). Enforced per-client using an `X-API-Key`
 * header when present, otherwise the client IP. All four endpoints share
 * the same per-client bucket — this is intentional; the issue only asked
 * for an "auth" tier, and a spammer exhausting `/login` cannot reach
 * `/logout`/`/refresh` for the same window but is also not allowed to
 * lock out unrelated endpoints. ~0.5 req/s prevents credential stuffing
 * and brute-force attacks while leaving comfortable headroom for
 * legitimate clients.
 *
 * Trade-off: a single client that exhausts one endpoint's quota cannot
 * reach the others either, but cross-endpoint reuse of the same key is
 * rare in legitimate traffic. To split quota per endpoint, define
 * further tiers and bind them in `src/routes/auth.routes.ts`.
 *
 * Hard-block: the abuse-guard escalates to a hard block after
 * `RL_AUTH_ABUSE_THRESHOLD` (default 3) violations.
 *
 * **Strict (180 req/min):** Other sensitive write endpoints, job creation.
 * ~3 req/s prevents coordinated abuse while preserving throughput.
 *
 * ## Production Recommendations
 *
 * 1. Behind a load balancer, ensure `trust proxy` is configured so `req.ip`
 *    reflects the real client IP (not the proxy).
 * 2. For multi-instance deployments, replace `RateLimitStore` with a shared
 *    Redis-backed store to maintain rate limit state across instances.
 * 3. Monitor the `rateLimitStore.size` metric to detect unusual traffic patterns.
 * 4. Consider lowering `abuseThreshold` in production (e.g., 3) to block repeat
 *    offenders faster.
 *
 * @security
 *  - Keys are hashed in the store (raw IPs never persisted).
 *  - Headers expose only aggregate counts, never raw identifiers.
 */

import type { RateLimiterConfig } from '../middleware/rateLimiter';
import { RateLimitStore } from '../lib/rateLimitStore';

function toMs(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (Number.isNaN(parsed) || parsed < 0) {
    console.warn(`[rateLimit] Invalid env value "${value}", using fallback ${fallback}`);
    return fallback;
  }
  return parsed;
}

function toCount(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Math.floor(Number(value));
  if (Number.isNaN(parsed) || parsed < 1) {
    console.warn(`[rateLimit] Invalid env value "${value}", using fallback ${fallback}`);
    return fallback;
  }
  return parsed;
}

export const rateLimitStore = new RateLimitStore({ sweepIntervalMs: 60_000 });

const sharedStore = { store: rateLimitStore };

export const rateLimitConfig = {
  /**
   * Standard tier: all authenticated endpoints.
   * Allows safe bursts (~10 req/s), resets every 60s.
   */
  standard: {
    maxRequests: toCount(process.env.RL_STANDARD_MAX, 600),
    windowMs: toMs(process.env.RL_STANDARD_WINDOW_MS, 60_000),
    abuseThreshold: toCount(process.env.RL_ABUSE_THRESHOLD, 5),
    blockWindowMs: toMs(process.env.RL_BLOCK_WINDOW_MS, 300_000),
    blockDurationMs: toMs(process.env.RL_BLOCK_DURATION_MS, 600_000),
    maxBlockDurationMs: toMs(process.env.RL_MAX_BLOCK_MS, 86_400_000),
    sendHeaders: true,
    ...sharedStore,
  } satisfies RateLimiterConfig,

  /**
   * Sensitive tier: write operations (POST/PUT/DELETE), auth, and job endpoints.
   * Stricter limits to prevent abuse while allowing legitimate bursts (~5 req/s).
   */
  sensitive: {
    maxRequests: toCount(process.env.RL_SENSITIVE_MAX, 300),
    windowMs: toMs(process.env.RL_SENSITIVE_WINDOW_MS, 60_000),
    abuseThreshold: toCount(process.env.RL_ABUSE_THRESHOLD, 5),
    blockWindowMs: toMs(process.env.RL_BLOCK_WINDOW_MS, 300_000),
    blockDurationMs: toMs(process.env.RL_BLOCK_DURATION_MS, 600_000),
    maxBlockDurationMs: toMs(process.env.RL_MAX_BLOCK_MS, 86_400_000),
    sendHeaders: true,
    ...sharedStore,
  } satisfies RateLimiterConfig,

  /**
   * Strict tier: other sensitive write endpoints, job creation.
   * Very strict (~3 req/s) to deter coordinated abuse.
   */
  strict: {
    maxRequests: toCount(process.env.RL_STRICT_MAX, 180),
    windowMs: toMs(process.env.RL_STRICT_WINDOW_MS, 60_000),
    abuseThreshold: toCount(process.env.RL_ABUSE_THRESHOLD, 3),
    blockWindowMs: toMs(process.env.RL_BLOCK_WINDOW_MS, 300_000),
    blockDurationMs: toMs(process.env.RL_BLOCK_DURATION_MS, 600_000),
    maxBlockDurationMs: toMs(process.env.RL_MAX_BLOCK_MS, 86_400_000),
    sendHeaders: true,
    ...sharedStore,
  } satisfies RateLimiterConfig,

  /**
   * Auth tier: login/register/refresh/logout endpoints (issue #756).
   *
   * Tuned tighter than the general `strict` tier to deter credential
   * stuffing and brute-force probing. Defaults support roughly 0.5 req/s
   * per client — well above legitimate client throughput while making
   * automated abuse expensive.
   *
   * The per-client key is derived by `createAuthKeyFn` in
   * `src/auth/rateLimitKey.ts`, which prefers `X-API-Key` (for service-to-service
   * calls) and falls back to the client IP. Each key gets a dedicated bucket.
   */
  auth: {
    maxRequests: toCount(process.env.RL_AUTH_MAX, 30),
    windowMs: toMs(process.env.RL_AUTH_WINDOW_MS, 60_000),
    abuseThreshold: toCount(process.env.RL_AUTH_ABUSE_THRESHOLD, 3),
    blockWindowMs: toMs(process.env.RL_BLOCK_WINDOW_MS, 300_000),
    blockDurationMs: toMs(process.env.RL_BLOCK_DURATION_MS, 600_000),
    maxBlockDurationMs: toMs(process.env.RL_MAX_BLOCK_MS, 86_400_000),
    sendHeaders: true,
    ...sharedStore,
  } satisfies RateLimiterConfig,

  /**
   * Audit export tier: compliance downloads and bulk exports.
   * Kept intentionally low because each request can generate and stream a file.
   */
  auditExport: {
    maxRequests: toCount(process.env.RL_AUDIT_EXPORT_MAX, 5),
    windowMs: toMs(process.env.RL_AUDIT_EXPORT_WINDOW_MS, 3_600_000),
    abuseThreshold: toCount(process.env.RL_AUDIT_EXPORT_ABUSE_THRESHOLD, 3),
    blockWindowMs: toMs(process.env.RL_AUDIT_EXPORT_BLOCK_WINDOW_MS, 21_600_000),
    blockDurationMs: toMs(process.env.RL_AUDIT_EXPORT_BLOCK_DURATION_MS, 3_600_000),
    maxBlockDurationMs: toMs(process.env.RL_AUDIT_EXPORT_MAX_BLOCK_MS, 86_400_000),
    sendHeaders: true,
    ...sharedStore,
  } satisfies RateLimiterConfig,

  /**
   * Disputes tier: dispute creation, resolution, and management.
   * Write-heavy endpoints with moderate limits (~5 req/s).
   */
  disputes: {
    maxRequests: toCount(process.env.RL_DISPUTES_MAX, 300),
    windowMs: toMs(process.env.RL_DISPUTES_WINDOW_MS, 60_000),
    abuseThreshold: toCount(process.env.RL_DISPUTES_ABUSE_THRESHOLD, 5),
    blockWindowMs: toMs(process.env.RL_DISPUTES_BLOCK_WINDOW_MS, 300_000),
    blockDurationMs: toMs(process.env.RL_DISPUTES_BLOCK_DURATION_MS, 600_000),
    maxBlockDurationMs: toMs(process.env.RL_DISPUTES_MAX_BLOCK_MS, 86_400_000),
    sendHeaders: true,
    ...sharedStore,
  } satisfies RateLimiterConfig,

  /**
   * Webhook token bucket configuration for rate limiting outbound webhook deliveries.
   */
  webhook: {
    capacity: toCount(process.env.WEBHOOK_BUCKET_CAPACITY, 10),
    refillRatePerSec: toCount(process.env.WEBHOOK_REFILL_RATE_PER_SEC, 2),
    maxQueueDepth: toCount(process.env.WEBHOOK_MAX_QUEUE_DEPTH, 1000),
  },
};

export type RateLimitTier = keyof typeof rateLimitConfig;

/** Validated, parsed outbound webhook token-bucket configuration. */
export interface WebhookTokenBucketConfig {
  /** Maximum number of tokens a single provider bucket can hold. */
  capacity: number;
  /** Number of tokens added to each bucket per second. */
  refillRatePerSec: number;
  /**
   * Hard cap on the number of pending waiters queued per provider.
   * When the queue reaches this depth, new acquisitions are rejected
   * with a {@link import('../rateLimit').RateLimitQueueFullError}
   * so the caller can route the delivery to the DLQ instead of
   * accumulating unbounded memory.
   *
   * @default 1000
   */
  maxQueueDepth: number;
}

/**
 * Parse and validate outbound webhook token-bucket configuration.
 *
 * @throws {Error} If any value is non-numeric, non-positive, or would make
 * every delivery block forever.
 */
export function loadWebhookTokenBucketConfig(env: NodeJS.ProcessEnv = process.env): WebhookTokenBucketConfig {
  const rawCapacity = env.WEBHOOK_BUCKET_CAPACITY ?? '10';
  const rawRefill = env.WEBHOOK_REFILL_RATE_PER_SEC ?? '2';
  const rawMaxQueueDepth = env.WEBHOOK_MAX_QUEUE_DEPTH ?? '1000';

  const capacity = Number(rawCapacity);
  const refillRatePerSec = Number(rawRefill);
  const maxQueueDepth = Number(rawMaxQueueDepth);

  if (!Number.isFinite(capacity) || capacity <= 0) {
    throw new Error(
      `[rateLimit] Invalid WEBHOOK_BUCKET_CAPACITY="${rawCapacity}". ` +
        'Must be a finite positive number greater than zero.',
    );
  }

  if (!Number.isFinite(refillRatePerSec) || refillRatePerSec <= 0) {
    throw new Error(
      `[rateLimit] Invalid WEBHOOK_REFILL_RATE_PER_SEC="${rawRefill}". ` +
        'Must be a finite positive number greater than zero.',
    );
  }

  if (!Number.isFinite(maxQueueDepth) || maxQueueDepth <= 0 || !Number.isInteger(maxQueueDepth)) {
    throw new Error(
      `[rateLimit] Invalid WEBHOOK_MAX_QUEUE_DEPTH="${rawMaxQueueDepth}". ` +
        'Must be a finite positive integer greater than zero.',
    );
  }

  return { capacity, refillRatePerSec, maxQueueDepth };
}
