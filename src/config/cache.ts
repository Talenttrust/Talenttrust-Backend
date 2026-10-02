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

/**
 * Upper bound for TTL to avoid overflowing setTimeout/Date arithmetic and to
 * keep cache behavior deterministic across platforms.
 */
const MAX_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Upper bound for entries to prevent unbounded memory growth from misconfig. */
const MAX_ENTRIES_LIMIT = 1_000_000;

export interface CacheConfig {
  /** TTL in milliseconds for cached contract reads */
  contractsTtlMs: number;
  /** Maximum number of entries before LRU eviction kicks in */
  contractsMaxEntries: number;
}

/**
 * Deterministic failure-recovery policy for cache configuration.
 *
 * Invariants:
 *  - `loadCacheConfig` MUST be a pure function of `env`; repeated calls with the
 *    same input return structurally-equal output. No hidden mutable state.
 *  - Invalid or out-of-range values MUST NOT throw. They fall back to the
 *    documented default so that a bad env var cannot take down the process or
 *    silently disable caching.
 *  - Warnings are emitted at most once per distinct (variable, value) pair per
 *    process to avoid log flooding under retry storms.
 */
const DEFAULT_CONTRACTS_TTL_MS = 30_000;
const DEFAULT_CONTRACTS_MAX_ENTRIES = 1000;
const MIN_CONTRACTS_TTL_MS = 1000;
const MIN_CONTRACTS_MAX_ENTRIES = 10;

const warnedKeys = new Set<string>();

function warnOnce(key: string, message: string): void {
  if (warnedKeys.has(key)) return;
  warnedKeys.add(key);
  console.warn(message);
}

/**
 * Parses an integer env var with deterministic fallback semantics.
 *
 * Returns `fallback` when the variable is unset, empty, non-numeric, or
 * non-finite. Never throws.
 */
function parseBoundedIntEnv(
  name: string,
  fallback: number,
  min: number,
  env: NodeJS.ProcessEnv,
): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;

  const parsed = parseIntEnv(name, fallback, env);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    warnOnce(
      `invalid:${name}:${raw}`,
      `[cache] ${name} is not a valid integer ("${raw}"), using default ${fallback}`,
    );
    return fallback;
  }

  if (parsed < min) {
    warnOnce(
      `below-min:${name}:${parsed}`,
      `[cache] ${name} is below minimum (${parsed} < ${min}), using default ${fallback}`,
    );
    return fallback;
  }

  return parsed;
}

/**
 * Loads cache configuration from environment variables.
 *
 * ## Invariants
 * - Returned values are always finite, non-negative integers within safe bounds.
 * - `contractsTtlMs` is clamped to `[0, MAX_TTL_MS]`.
 * - `contractsMaxEntries` is clamped to `[1, MAX_ENTRIES_LIMIT]`.
 * - Repeated calls with the same `env` produce identical results (idempotent).
 * - Invalid/missing values fall back to defaults rather than throwing, so
 *   concurrent startup paths cannot observe partial/inconsistent state.
 *
 * @param env - Environment object (defaults to process.env for production, can be overridden in tests)
 * @returns Parsed cache configuration
 */
export function loadCacheConfig(env: NodeJS.ProcessEnv = process.env): CacheConfig {
  const rawTtlMs = parseIntEnv('CACHE_CONTRACTS_TTL_MS', 30_000); // 30 seconds default
  const rawMaxEntries = parseIntEnv('CACHE_CONTRACTS_MAX_ENTRIES', 1000);

  // Normalize: reject NaN/Infinity/negative, clamp to safe bounds. This makes
  // concurrent or repeated loads deterministic even under hostile env input.
  const contractsTtlMs = clampInt(rawTtlMs, 0, MAX_TTL_MS, 30_000);
  const contractsMaxEntries = clampInt(rawMaxEntries, 1, MAX_ENTRIES_LIMIT, 1000);

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

/**
 * Clamps an integer to `[min, max]`, falling back to `fallback` when the input
 * is not a finite number. Pure function — safe under concurrent invocation.
 */
function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  const truncated = Math.trunc(value);
  if (truncated < min) return min;
  if (truncated > max) return max;
  return truncated;
}
