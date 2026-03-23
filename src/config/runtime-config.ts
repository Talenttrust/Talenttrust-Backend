export const SERVICE_NAME = 'talenttrust-backend';

export const FEATURE_ENV_KEYS = {
  contractsApiEnabled: 'FEATURE_CONTRACTS_API_ENABLED',
  runtimeConfigEndpointEnabled: 'FEATURE_RUNTIME_CONFIG_ENDPOINT_ENABLED',
} as const;

const DEFAULT_PORT = 3001;
const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);

/**
 * @notice Boolean feature flags that control rollout of higher-risk API capabilities.
 * @dev Flags are parsed once at boot so misconfiguration fails closed before traffic is served.
 */
export interface FeatureFlags {
  contractsApiEnabled: boolean;
  runtimeConfigEndpointEnabled: boolean;
}

/**
 * @notice Safe, validated runtime configuration for the backend process.
 * @dev Only non-sensitive values should be exposed outside process boundaries.
 */
export interface RuntimeConfig {
  port: number;
  features: FeatureFlags;
}

/**
 * @notice Parse a boolean environment variable using a small, explicit allowlist.
 * @param rawValue Raw environment variable value.
 * @param envKey Environment variable name for error reporting.
 * @param defaultValue Value used when the variable is unset.
 * @returns A validated boolean value.
 * @throws When the variable is set to an unsupported value.
 */
export function parseBooleanEnv(
  rawValue: string | undefined,
  envKey: string,
  defaultValue: boolean,
): boolean {
  if (rawValue === undefined) {
    return defaultValue;
  }

  const normalizedValue = rawValue.trim().toLowerCase();

  if (TRUE_VALUES.has(normalizedValue)) {
    return true;
  }

  if (FALSE_VALUES.has(normalizedValue)) {
    return false;
  }

  throw new Error(
    `Invalid boolean value for ${envKey}: "${rawValue}". Use one of ${[
      ...TRUE_VALUES,
      ...FALSE_VALUES,
    ].join(', ')}.`,
  );
}

function parsePort(rawValue: string | undefined): number {
  if (rawValue === undefined) {
    return DEFAULT_PORT;
  }

  const parsedPort = Number(rawValue);

  if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
    throw new Error(`Invalid PORT value "${rawValue}". Use an integer between 1 and 65535.`);
  }

  return parsedPort;
}

/**
 * @notice Load and validate backend runtime configuration from environment variables.
 * @param env Environment source, defaulting to process.env.
 * @returns A fully validated runtime config object.
 */
export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  return {
    port: parsePort(env.PORT),
    features: {
      contractsApiEnabled: parseBooleanEnv(
        env[FEATURE_ENV_KEYS.contractsApiEnabled],
        FEATURE_ENV_KEYS.contractsApiEnabled,
        true,
      ),
      runtimeConfigEndpointEnabled: parseBooleanEnv(
        env[FEATURE_ENV_KEYS.runtimeConfigEndpointEnabled],
        FEATURE_ENV_KEYS.runtimeConfigEndpointEnabled,
        false,
      ),
    },
  };
}

/**
 * @notice Build a public-safe view of runtime feature state for diagnostics.
 * @dev Sensitive values such as raw env vars and network settings are intentionally excluded.
 */
export function getPublicRuntimeConfig(config: RuntimeConfig): Pick<RuntimeConfig, 'features'> {
  return {
    features: {
      ...config.features,
    },
  };
}
