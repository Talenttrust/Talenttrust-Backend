/**
 * @title Rate Limiting Configuration
 * @notice Env-driven config for tiered rate limits on sensitive endpoints.
 *
 * ## Environment Variables
 *
 * | Variable                  | Default    | Description                              |
 * |---------------------------|------------|------------------------------------------|
 * | RL_STANDARD_MAX           | 600        | Max requests per window (standard tier)  |
 * | RL_SENSITIVE_MAX          | 300        | Max requests per window (sensitive tier)  |
 * | RL_STRICT_MAX             | 180        | Max requests per window (strict tier)    |
 * | RL_STANDARD_WINDOW_MS     | 60000      | Window duration in ms (standard)         |
 * | RL_SENSITIVE_WINDOW_MS    | 60000      | Window duration in ms (sensitive)         |
 * | RL_STRICT_WINDOW_MS       | 60000      | Window duration in ms (strict)           |
 * | RL_ABUSE_THRESHOLD        | 5/3        | Violations before hard block             |
 * | RL_BLOCK_WINDOW_MS        | 300000     | Violation observation window             |
 * | RL_BLOCK_DURATION_MS      | 600000     | Initial block duration                   |
 * | RL_MAX_BLOCK_MS           | 86400000   | Maximum block duration (24h)             |
 *
 * ## Tier Descriptions
 *
 * **Standard (600 req/min):** Authenticated read-heavy endpoints. Allows safe
 * bursts of ~10 req/s for legitimate users while preventing coordinated abuse.
 *
 * **Sensitive (300 req/min):** Write operations (POST/PUT/DELETE). Reduces to
 * ~5 req/s to deter automated attacks while allowing legitimate batch operations.
 *
 * **Strict (180 req/min):** Auth endpoints, job creation. ~3 req/s prevents
 * credential stuffing and brute-force attacks.
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

import { RateLimiterConfig } from '../middleware/rateLimiter';
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
   * Strict tier: auth/login endpoints, job creation.
   * Very strict (~3 req/s) to prevent credential stuffing.
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
};

export type RateLimitTier = keyof typeof rateLimitConfig;
