import { parseBoolEnv } from './env';

export interface FeaturesConfig {
  disputesEnabled: boolean;
  webhooksEnabled: boolean;
}

/**
 * Invariants for deterministic feature-flag resolution:
 * - Flags are resolved once at module load from environment variables.
 * - Missing or malformed values fall back to the documented default.
 * - Resolution is pure and side-effect free, so repeated reads are stable.
 * - No sensitive environment values are logged or exposed.
 */
const FEATURE_DEFAULTS = {
  disputesEnabled: true,
  webhooksEnabled: true,
} as const;

function resolveFeatureFlag(
  name: string,
  defaultValue: boolean,
): boolean {
  try {
    return parseBoolEnv(name, defaultValue);
  } catch (err) {
    // Deterministic fallback: never let a malformed flag crash startup.
    // Log only the flag name and error class, never the raw value.
    const reason = err instanceof Error ? err.name : 'UnknownError';
    // eslint-disable-next-line no-console
    console.warn(
      `[features] Failed to resolve ${name}; using default (${defaultValue}). reason=${reason}`,
    );
    return defaultValue;
  }
}

export const features: FeaturesConfig = {
  disputesEnabled: resolveFeatureFlag(
    'DISPUTES_FEATURE_ENABLED',
    FEATURE_DEFAULTS.disputesEnabled,
  ),
  webhooksEnabled: resolveFeatureFlag(
    'WEBHOOKS_ENABLED',
    FEATURE_DEFAULTS.webhooksEnabled,
  ),
};
