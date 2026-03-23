/**
 * @notice Runtime cache configuration.
 */
export interface CacheConfig {
  enabled: boolean;
  ttlSeconds: number;
  maxItems: number;
}

/**
 * @notice Load cache configuration from environment variables.
 * @param env Environment variable map.
 */
export function loadCacheConfig(env: NodeJS.ProcessEnv = process.env): CacheConfig {
  return {
    enabled: env.CACHE_ENABLED !== 'false',
    ttlSeconds: parsePositiveInteger(env.CACHE_TTL_SECONDS, 30, 'CACHE_TTL_SECONDS'),
    maxItems: parsePositiveInteger(env.CACHE_MAX_ITEMS, 100, 'CACHE_MAX_ITEMS'),
  };
}

/**
 * @notice Parse a positive integer config value or return a default.
 * @param rawValue Raw environment value.
 * @param fallback Default integer value.
 * @param name Variable name for error messages.
 */
export function parsePositiveInteger(
  rawValue: string | undefined,
  fallback: number,
  name: string,
): number {
  if (!rawValue) {
    return fallback;
  }

  const parsed = Number.parseInt(rawValue, 10);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return parsed;
}
