const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);

export interface MetricsConfig {
  enabled: boolean;
  authToken?: string;
}

export interface ObservabilityConfig {
  port: number;
  serviceName: string;
  metrics: MetricsConfig;
}

/**
 * Parse runtime config in one place to keep app wiring deterministic and testable.
 */
export function readObservabilityConfig(
  env: NodeJS.ProcessEnv = process.env,
): ObservabilityConfig {
  return {
    port: readNumber(env.PORT, 3001),
    serviceName: env.SERVICE_NAME || 'talenttrust-backend',
    metrics: {
      enabled: readBoolean(env.METRICS_ENABLED, true),
      authToken: env.METRICS_AUTH_TOKEN,
    },
  };
}

function readBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) {
    return fallback;
  }

  return TRUE_VALUES.has(value.toLowerCase());
}

function readNumber(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

