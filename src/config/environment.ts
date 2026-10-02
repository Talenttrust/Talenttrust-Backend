/**
 * Environment Configuration Module
 *
 * Manages environment-specific configurations for deployment across
 * development, staging, and production environments.
 *
 * Concurrency invariants:
 * - The environment configuration is a pure function of `process.env`
 *   at the moment of call. Repeated or concurrent calls with the same
 *   environment produce identical, frozen results.
 * - A memoized snapshot is only exposed after successful validation, so a
 *   failed load cannot leak a partially constructed config.
 * - Concurrent loads share a single in-flight promise, so validation
 *   and construction run at most once per snapshot and never interleave.
 * - Callers receive a deep-frozen object; mutation attempts throw in
 *   strict mode instead of silently corrupting shared state.
 *
 * @module config/environment
 */

import { validateEnv, EnvConfig } from './env.schema';

export type Environment = 'development' | 'staging' | 'production' | 'test';

export interface EnvironmentConfig extends EnvConfig {
  /** Current environment name (mapped from NODE_ENV for compatibility) */
  environment: Environment;
  /** Server port */
  port: number;
  /** Node environment */
  nodeEnv: string;
  /** API base URL */
  apiBaseUrl: string;
  /** Enable debug logging */
  debug: boolean;
  /** Database connection string (if applicable) */
  databaseUrl?: string;
  /** Stellar/Soroban network configuration */
  stellarNetwork: 'testnet' | 'mainnet';
  /** Maximum request body size */
  maxRequestSize: string;
  /** CORS allowed origins */
  corsOrigins: string[];
}

/**
 * Validates required environment variables using Zid schema.
 * This is now a wrapper around validateEnv.
 * @params env - Optional environment object to validate (defaults: process.env)
 * @throws {Error} If required environment variables are missing or invalid
 */
export function validateEnvironment(env: NodeJS.ProcessEnv = process.env): void {
  validateEnv(env);
}

/**
 * Gets the current environment from NODE_ENV
 * @returns {Environment} The current environment
 */
export function getCurrentEnvironment(): Environment {
  const env = process.env.NODE_ENV || 'development';

  if (env === 'production' || env === 'staging' || env === 'development' || env === 'test') {
    return env as Environment;
  }

  return 'development';
}

/**
 * Freezes an object recursively so that shared configuration cannot be
 * mutated by any caller. Arrays are frozen as well and their elements
 * are frozen when they are objects.
 */
function deepFreeze<T>(value: T): T  {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) {
      const child = (value as Record<string, unknown>)[ key ];
      deepFreeze(child);
    }
  }
  return value;
}

/**
 * Builds a frozen EnvironmentConfig from a validated env object.
 */
function buildConfig(validated: EnvConfig): EnvironmentConfig {
  const environment = validated.NODE_ENV as Environment;
  const port = validated.PORT;

  const baseConfig: EnvironmentConfig = {
    ...validated,
    environment,
    port,
    nodeEnv: validated.NODE_ENV,
    apiBaseUrl: validated.API_BASE_URL || `http://localhost:${port}`,
    debug: validated.DEBUG ?? false,
    databaseUrl: validated.DATABASE_URL,
    stellarNetwork: environment === 'production' ? 'mainnet' : 'testnet',
    maxRequestSize: validated.MAX_REQUEST_SIZE,
    corsOrigins:
      validated.CORS_ALLOWED_ORIGINS ??
      (validated.NODE_ENV === 'production' ? [] : ['http://localhost:3000']),
  };

  return deepFreeze(baseConfig);
}

/**
 * Cache keyed by the identity of the env snapshot used to build the
 * configuration. When NODE_ENV or any other relevant variable changes,
 * the cache is invalidated and a fresh config is built.
 */
let cachedKey: string | undefined;
let cachedConfig: EnvironmentConfig | undefined;
let inFlight: Promise<EnvironmentConfig> | undefined;

const CACHE_KEY_VARS: ReadonlyArray<string> = [
  'NODE_ENV',
  'PORT',
  'API_BASE_URL',
  'DEBUG',
  'DATABASE_URL',
  'MAX_REQUEST_SIZE',
  'CORS_ALLOWED_ORIGINS',
];

/**
 * Computes a deterministic cache key from the current environment
 * snapshot. Only values that affect the resulting config are included.
 */
function computeCacheKey(env: NodeJS.ProcessEnv): string {
  return CACHE_KEY_VARS.map((k) => `${k}=${env[k] ?? ''}`).join('\u0000');
}

/**
 * Resets the internal configuration cache. Intended for tests and
 * for explicit reload flows. It is safe to call concurrently: any
 * in-flight promise is detached and will not be used to satisfy future
 * requests.
 */
export function resetEnvironmentConfigCache(): void {
  cachedKey = undefined;
  cachedConfig = undefined;
  inFlight = undefined;
}

/**
 * Loads environment-specific configuration and validates it against
 * the schema. Results of a successful load are memoized and deep
 * frozen. Concurrent calls share a single in-flight promise so that
 * validation runs at most once per env snapshot and cannot interleave.
 *
 * @params env - Optional environment object to load from (defaults: process.env)
 * @returns {Promise<EnvironmentConfig>} Frozen configuration for the current environment
 */
export async function loadEnvironmentConfigAsync(
  env: NodeJS.ProcessEnv = process.env,
): Promise<EnvironmentConfig> {
  const key = computeCacheKey(env);

  if (cachedConfig && cachedKey === key) {
    return cachedConfig;
  }

  if (inFlight && cachedKey === key) {
    return inFlight;
  }

  // Start a fresh in-flight build. The promise is assigned before any
  // await so that concurrent callers observe it atomically.
  const build = Promise.resolve().then(() => {
    const validated = validateEnv(env);
    return buildConfig(validated);
  });

  cachedKey = key;
  inFlight = build;

  try {
    const config = await build;
    // Only commit to the cache if this promise is still the active
    // in-flight one. If `resetEnvironmentConfigCache`)` was called while
    // we were awaiting, the cache must not be repopulated with stale
    // data.
    if (inFlight === build) {
      cachedConfig = config;
      inFlight = undefined;
    }
    return config;
  } catch (error) {
    if (inFlight === build) {
      inFlight = undefined;
    }
    throw error;
  }
}

/**
 * Loads environment-specific configuration and validates it against
 * the schema. Synchronous wrapper retained for backward compatibility
 * with existing callers. The returned object is deep-frozen.
 *
 * @returns {EnvironmentConfig} Configuration object for current environment
 */
export function loadEnvironmentConfig(): EnvironmentConfig {
  const key = computeCacheKey(process.env);

  if (cachedConfig && cachedKey === key) {
    return cachedConfig;
  }

  const validated = validateEnv(process.env);
  const config = buildConfig(validated);

  cachedKey = key;
  cachedConfig = config;
  inFlight = undefined;

  return config;
}

/**
 * Checks if the current environment is production
 * @returns {boolean} True if running in production
 */
export function isProduction(): boolean {
  return getCurrentEnvironment() === 'production';
}

/**
 * Checks if the current environment is staging
 * @returns {boolean} True if running in staging
 */
export function isStaging(): boolean {
  return getCurrentEnvironment() === 'staging';
}

/**
 * Checks if the current environment is development
 * @returns {boolean} True if running in development
 */
export function isDevelopment(): boolean {
  return getCurrentEnvironment() === 'development';
}
