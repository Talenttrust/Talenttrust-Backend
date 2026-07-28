/**
 * @title Response Caching Configuration
 * @notice Env-driven config for contracts read endpoint caching.
 *
 * ## Environment Variables
 *
 * | Variable                      | Default    | Description                              |
 * |-------------------------------|------------|------------------------------------------|
 * | CACHE_CONTRACTS_TTL_MS        | 30000      | TTL for cached contract reads (30s)      |
 * | CACHE_CONTRACTS_MAX_ENTRIES   | 1000       | Max entries before LRU eviction (1000)   |
 *
 * ## Design
 *
 * - **Bounded LRU cache**: Entries are evicted by least-recently-used order once
 *   the max-entry bound is exceeded. This prevents unbounded memory growth under
 *   high filter cardinality (many distinct list queries).
 *
 * - **Config-driven TTL**: TTL values are loaded from environment variables at
 *   startup with sensible defaults. Allows cache behavior to be tuned without
 *   code changes.
 *
 * - **Cache keys encode filter/sort/pagination params**: Two different queries
 *   that would return different data use different keys. Prevents stale-data
 *   collisions.
 *
 * - **Metrics integration**: Uses existing Prometheus registry to track hit/miss
 *   counts (via MetricsService.recordCacheHit/Miss).
 *
 * ## Production Recommendations
 *
 * 1. Monitor cache metrics to tune TTL vs memory usage:
 *    - High hit rate + memory growing unbounded → increase TTL, lower bound
 *    - Low hit rate + fast eviction → decrease TTL, increase bound
 *
 * 2. For multi-instance deployments without shared cache, each instance maintains
 *    its own cache. Consider Redis-backed caching if shared state is needed.
 *
 * 3. Cache invalidation is always synchronous and happens before the write
 *    response is sent, ensuring no stale reads immediately after a write.
 *
 * @security
 *  - Cache keys do not contain sensitive data (only UUIDs, pagination params).
 *  - Cached responses go through the same authorization middleware as uncached
 *    reads, so a cached response is never served to an unauthorized user.
 *  - Invalidation is conservative: when in doubt, we invalidate more broadly
 *    rather than risk serving stale data.
 */

import { parseIntEnv } from './env';

export interface CacheConfig {
  /** TTL in milliseconds for cached contract reads */
  contractsTtlMs: number;
  /** Maximum number of entries before LRU eviction kicks in */
  contractsMaxEntries: number;
}

/**
 * Loads cache configuration from environment variables.
 *
 * @param env - Environment object (defaults to process.env for production, can be overridden in tests)
 * @returns Parsed cache configuration
 */
export function loadCacheConfig(env: NodeJS.ProcessEnv = process.env): CacheConfig {
  const contractsTtlMs = parseIntEnv('CACHE_CONTRACTS_TTL_MS', 30_000); // 30 seconds default
  const contractsMaxEntries = parseIntEnv('CACHE_CONTRACTS_MAX_ENTRIES', 1000);

  if (contractsTtlMs < 1000) {
    console.warn(
      `[cache] CACHE_CONTRACTS_TTL_MS is very short (${contractsTtlMs}ms), ` +
        `consider increasing to reduce cache overhead`,
    );
  }

  if (contractsMaxEntries < 10) {
    console.warn(
      `[cache] CACHE_CONTRACTS_MAX_ENTRIES is very low (${contractsMaxEntries}), ` +
        `consider increasing to reduce eviction rate`,
    );
  }

  return {
    contractsTtlMs,
    contractsMaxEntries,
  };
}
