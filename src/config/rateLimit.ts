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
 * | RL_AUDIT_MAX               | 300        | Max requests per window (audit tier)     |
 * | RL_AUDIT_WINDOW_MS         | 60000      | Window duration in ms (audit)            |
 * | RL_AUDIT_ABUSE_THRESHOLD   | 5          | Violations before hard block (audit)     |
 * | RL_AUDIT_INTEGRITY_MAX     | 10         | Max requests per window (audit integrity)|
 * | RL_AUDIT_INTEGRITY_WINDOW_MS | 60000    | Window duration in ms (audit integrity)  |
 * | RL_HEALTH_MAX              | 60         | Max requests per window (health tier)    |
 * | RL_HEALTH_WINDOW_MS        | 60000      | Window duration in ms (health)           |
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
export const apiKeysRateLimitStore = new RateLimitStore({ sweepIntervalMs: 60_000 });

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
   * Audit bulk tier: `POST /api/v1/audit/bulk` batch writes.
   * Kept tighter than the general `audit`/write-request limit because each
   * request can append up to `MAX_BULK_AUDIT_ITEMS` entries to the hash
   * chain (sequential appends), not just one — similar rationale to
   * `auditExport` being its own tier rather than reusing `audit`.
   */
  auditBulk: {
    maxRequests: toCount(process.env.RL_AUDIT_BULK_MAX, 30),
    windowMs: toMs(process.env.RL_AUDIT_BULK_WINDOW_MS, 60_000),
    abuseThreshold: toCount(process.env.RL_AUDIT_BULK_ABUSE_THRESHOLD, 5),
    blockWindowMs: toMs(process.env.RL_AUDIT_BULK_BLOCK_WINDOW_MS, 300_000),
    blockDurationMs: toMs(process.env.RL_AUDIT_BULK_BLOCK_DURATION_MS, 600_000),
    maxBlockDurationMs: toMs(process.env.RL_AUDIT_BULK_MAX_BLOCK_MS, 86_400_000),
    sendHeaders: true,
    ...sharedStore,
  } satisfies RateLimiterConfig,

  /**
   * Audit tier: general query/read endpoints on the audit log
   * (`GET /api/v1/audit`, `GET /api/v1/audit/:id`), issue #746.
   *
   * These are authenticated admin/auditor-only endpoints, so the pool of
   * legitimate callers is small and well-known; the default is deliberately
   * looser than `auditExport` (no file generation per request) but its own
   * tunable tier rather than reusing `standard`, so ops can dial it in
   * independently of the general authenticated-endpoint limit.
   */
  audit: {
    maxRequests: toCount(process.env.RL_AUDIT_MAX, 300),
    windowMs: toMs(process.env.RL_AUDIT_WINDOW_MS, 60_000),
    abuseThreshold: toCount(process.env.RL_AUDIT_ABUSE_THRESHOLD, 5),
    blockWindowMs: toMs(process.env.RL_AUDIT_BLOCK_WINDOW_MS, 300_000),
    blockDurationMs: toMs(process.env.RL_AUDIT_BLOCK_DURATION_MS, 600_000),
    maxBlockDurationMs: toMs(process.env.RL_AUDIT_MAX_BLOCK_MS, 86_400_000),
    sendHeaders: true,
    ...sharedStore,
  } satisfies RateLimiterConfig,

  /**
   * Audit integrity tier: `GET /api/v1/audit/integrity`, issue #746.
   *
   * Verifying the tamper-evident hash chain walks the entire audit log, so
   * this is the most expensive read the audit router exposes — router.ts's
   * own doc comment flags it as needing rate limiting to prevent DoS on
   * large logs. Kept much tighter than the general `audit` tier for that
   * reason, closer in spirit to `auditExport`.
   */
  auditIntegrity: {
    maxRequests: toCount(process.env.RL_AUDIT_INTEGRITY_MAX, 10),
    windowMs: toMs(process.env.RL_AUDIT_INTEGRITY_WINDOW_MS, 60_000),
    abuseThreshold: toCount(process.env.RL_AUDIT_INTEGRITY_ABUSE_THRESHOLD, 3),
    blockWindowMs: toMs(process.env.RL_AUDIT_INTEGRITY_BLOCK_WINDOW_MS, 300_000),
    blockDurationMs: toMs(process.env.RL_AUDIT_INTEGRITY_BLOCK_DURATION_MS, 600_000),
    maxBlockDurationMs: toMs(process.env.RL_AUDIT_INTEGRITY_MAX_BLOCK_MS, 86_400_000),
    sendHeaders: true,
    ...sharedStore,
  } satisfies RateLimiterConfig,

  /**
   * Milestones tier: contract/milestone CRUD operations.
   * Per-client rate limiting using API key if available, otherwise IP.
   * Default: 60 requests per minute (~1 req/s).
   */
  milestones: {
    maxRequests: toCount(process.env.RL_MILESTONES_MAX, 60),
    windowMs: toMs(process.env.RL_MILESTONES_WINDOW_MS, 60_000),
    abuseThreshold: toCount(process.env.RL_ABUSE_THRESHOLD, 5),
    blockWindowMs: toMs(process.env.RL_BLOCK_WINDOW_MS, 300_000),
    blockDurationMs: toMs(process.env.RL_BLOCK_DURATION_MS, 600_000),
    maxBlockDurationMs: toMs(process.env.RL_MAX_BLOCK_MS, 86_400_000),
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
   * Health tier: /health/*, /health/live, /health/ready, /health/router.
   *
   * These endpoints are hit by load-balancers, orchestrators, and monitoring
   * agents. The default of 60 req/min gives a scrape-every-second poller
   * comfortable headroom while making a flood-level DDoS attack noticeably
   * expensive. The key is derived from X-API-Key when present (for service
   * clients) and falls back to IP.
   *
   * Tuning knobs:
   *   RL_HEALTH_MAX        — max requests per window (default 60)
   *   RL_HEALTH_WINDOW_MS  — window size in ms (default 60 000)
   */
  health: {
    maxRequests: toCount(process.env.RL_HEALTH_MAX, 60),
    windowMs: toMs(process.env.RL_HEALTH_WINDOW_MS, 60_000),
    abuseThreshold: toCount(process.env.RL_HEALTH_ABUSE_THRESHOLD, 10),
    blockWindowMs: toMs(process.env.RL_BLOCK_WINDOW_MS, 300_000),
    blockDurationMs: toMs(process.env.RL_BLOCK_DURATION_MS, 600_000),
    maxBlockDurationMs: toMs(process.env.RL_MAX_BLOCK_MS, 86_400_000),
    sendHeaders: true,
    ...sharedStore,
  } satisfies RateLimiterConfig,

  /**
   * Reputation tier: rate limits on reputation queries and mutations.
   */
  reputation: {
    maxRequests: toCount(process.env.RL_REPUTATION_MAX, 100),
    windowMs: toMs(process.env.RL_REPUTATION_WINDOW_MS, 60_000),
    abuseThreshold: toCount(process.env.RL_REPUTATION_ABUSE_THRESHOLD, 5),
    blockWindowMs: toMs(process.env.RL_BLOCK_WINDOW_MS, 300_000),
    blockDurationMs: toMs(process.env.RL_BLOCK_DURATION_MS, 600_000),
    maxBlockDurationMs: toMs(process.env.RL_MAX_BLOCK_MS, 86_400_000),
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
