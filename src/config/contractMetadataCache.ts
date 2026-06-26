export interface ContractMetadataCacheConfig {
  ttlMs: number;
  swrMs: number;
  maxEntries: number;
}

const DEFAULT_CONTRACT_METADATA_CACHE_CONFIG: ContractMetadataCacheConfig = {
  ttlMs: 5_000,
  swrMs: 30_000,
  maxEntries: 500,
};

function parseNonNegativeIntegerEnv(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
    throw new Error(
      `Environment variable ${key} must be a non-negative integer, got: "${raw}"`,
    );
  }

  return parsed;
}

function parsePositiveIntegerEnv(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
): number {
  const value = parseNonNegativeIntegerEnv(env, key, fallback);
  if (value <= 0) {
    throw new Error(
      `Environment variable ${key} must be a positive integer, got: "${String(env[key])}"`,
    );
  }
  return value;
}

/**
 * Load the contract-metadata cache tuning knobs from the environment.
 *
 * The defaults are intentionally conservative: a short fresh window for
 * repeated hot reads, a longer SWR window to keep latency low during bursts,
 * and a bounded entry cap to keep the process-memory footprint predictable.
 */
export function loadContractMetadataCacheConfig(
  env: NodeJS.ProcessEnv = process.env,
): ContractMetadataCacheConfig {
  return {
    ttlMs: parseNonNegativeIntegerEnv(
      env,
      'CONTRACT_METADATA_CACHE_TTL_MS',
      DEFAULT_CONTRACT_METADATA_CACHE_CONFIG.ttlMs,
    ),
    swrMs: parseNonNegativeIntegerEnv(
      env,
      'CONTRACT_METADATA_CACHE_SWR_MS',
      DEFAULT_CONTRACT_METADATA_CACHE_CONFIG.swrMs,
    ),
    maxEntries: parsePositiveIntegerEnv(
      env,
      'CONTRACT_METADATA_CACHE_MAX_ENTRIES',
      DEFAULT_CONTRACT_METADATA_CACHE_CONFIG.maxEntries,
    ),
  };
}

export const contractMetadataCacheConfig = loadContractMetadataCacheConfig();
