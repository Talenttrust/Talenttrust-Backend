const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);

/**
 * Default histogram bucket boundaries in seconds.
 *
 * These match the prom-client defaults and cover the SLO thresholds defined in
 * src/operations/service-objectives.ts:
 *   - healthCheck p95=50ms (0.05s ✓), p99=100ms (0.1s ✓)
 *   - contractsApi p95=200ms (between 0.1 and 0.25 ✓), p99=500ms (0.5s ✓)
 */
export const DEFAULT_HISTOGRAM_BUCKETS: readonly number[] = [
  0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5,
] as const;

export interface MetricsConfig {
  enabled: boolean;
  authToken?: string;
  /**
   * Custom histogram bucket boundaries (in seconds) for
   * `http_request_duration_seconds`. Values must be a non-empty array of
   * strictly increasing positive numbers. Falls back to
   * {@link DEFAULT_HISTOGRAM_BUCKETS} when not supplied.
   */
  histogramBuckets: readonly number[];
}

export interface ObservabilityConfig {
  port: number;
  serviceName: string;
  metrics: MetricsConfig;
}

/**
 * Validate that a candidate bucket array is suitable for a Prometheus
 * histogram:
 *   - Must be a non-empty array.
 *   - Every element must be a finite, positive number.
 *   - Elements must be strictly increasing.
 *
 * Returns the validated array on success, or `null` with a descriptive reason
 * when validation fails so callers can log and fall back gracefully.
 */
export function validateHistogramBuckets(
  buckets: unknown,
): { valid: true; buckets: number[] } | { valid: false; reason: string } {
  if (!Array.isArray(buckets)) {
    return { valid: false, reason: 'buckets must be an array' };
  }

  if (buckets.length === 0) {
    return { valid: false, reason: 'buckets array must not be empty' };
  }

  for (let i = 0; i < buckets.length; i++) {
    const v = buckets[i];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      return {
        valid: false,
        reason: `bucket at index ${i} is not a finite number (got ${JSON.stringify(v)})`,
      };
    }
    if (v <= 0) {
      return {
        valid: false,
        reason: `bucket at index ${i} must be positive (got ${v})`,
      };
    }
    if (i > 0 && v <= buckets[i - 1]) {
      return {
        valid: false,
        reason: `buckets must be strictly increasing: ${buckets[i - 1]} >= ${v} at index ${i}`,
      };
    }
  }

  return { valid: true, buckets: buckets as number[] };
}

/**
 * Parse the `METRICS_HISTOGRAM_BUCKETS` environment variable.
 *
 * The variable accepts a comma-separated list of positive finite numbers in
 * strictly increasing order (seconds), for example:
 *
 *   METRICS_HISTOGRAM_BUCKETS=0.005,0.01,0.05,0.1,0.5,1,5
 *
 * Returns the parsed array on success, or `null` when the variable is absent,
 * empty, or invalid. Callers should fall back to
 * {@link DEFAULT_HISTOGRAM_BUCKETS} when `null` is returned.
 */
export function parseHistogramBucketsEnv(
  value: string | undefined,
): number[] | null {
  if (!value || value.trim() === '') {
    return null;
  }

  const parsed = value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => Number(s));

  const result = validateHistogramBuckets(parsed);
  if (!result.valid) {
    return null;
  }

  return result.buckets;
}

/**
 * Parse runtime config in one place to keep app wiring deterministic and testable.
 */
export function readObservabilityConfig(
  env: NodeJS.ProcessEnv = process.env,
): ObservabilityConfig {
  const parsedBuckets = parseHistogramBucketsEnv(env.METRICS_HISTOGRAM_BUCKETS);

  return {
    port: readNumber(env.PORT, 3001),
    serviceName: env.SERVICE_NAME || 'talenttrust-backend',
    metrics: {
      enabled: readBoolean(env.METRICS_ENABLED, true),
      authToken: env.METRICS_AUTH_TOKEN,
      histogramBuckets: parsedBuckets ?? DEFAULT_HISTOGRAM_BUCKETS,
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
