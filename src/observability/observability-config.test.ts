import {
  DEFAULT_HISTOGRAM_BUCKETS,
  parseHistogramBucketsEnv,
  readObservabilityConfig,
  validateHistogramBuckets,
} from './observability-config';

describe('readObservabilityConfig', () => {
  it('uses secure and production-safe defaults', () => {
    const config = readObservabilityConfig({});

    expect(config.port).toBe(3001);
    expect(config.serviceName).toBe('talenttrust-backend');
    expect(config.metrics.enabled).toBe(true);
    expect(config.metrics.authToken).toBeUndefined();
  });

  it('parses booleans and numbers from env', () => {
    const config = readObservabilityConfig({
      PORT: '8080',
      SERVICE_NAME: 'backend-api',
      METRICS_ENABLED: 'false',
      METRICS_AUTH_TOKEN: 'abc123',
    });

    expect(config.port).toBe(8080);
    expect(config.serviceName).toBe('backend-api');
    expect(config.metrics.enabled).toBe(false);
    expect(config.metrics.authToken).toBe('abc123');
  });

  it('defaults histogramBuckets to DEFAULT_HISTOGRAM_BUCKETS when env is absent', () => {
    const config = readObservabilityConfig({});
    expect(config.metrics.histogramBuckets).toEqual(DEFAULT_HISTOGRAM_BUCKETS);
  });

  it('parses a valid METRICS_HISTOGRAM_BUCKETS env variable', () => {
    const config = readObservabilityConfig({
      METRICS_HISTOGRAM_BUCKETS: '0.01,0.05,0.1,0.5,1',
    });
    expect(config.metrics.histogramBuckets).toEqual([0.01, 0.05, 0.1, 0.5, 1]);
  });

  it('falls back to defaults when METRICS_HISTOGRAM_BUCKETS is invalid', () => {
    const config = readObservabilityConfig({
      METRICS_HISTOGRAM_BUCKETS: 'not,numbers,here',
    });
    expect(config.metrics.histogramBuckets).toEqual(DEFAULT_HISTOGRAM_BUCKETS);
  });

  it('falls back to defaults when METRICS_HISTOGRAM_BUCKETS is empty string', () => {
    const config = readObservabilityConfig({ METRICS_HISTOGRAM_BUCKETS: '' });
    expect(config.metrics.histogramBuckets).toEqual(DEFAULT_HISTOGRAM_BUCKETS);
  });

  it('falls back to defaults when METRICS_HISTOGRAM_BUCKETS has non-increasing values', () => {
    const config = readObservabilityConfig({
      METRICS_HISTOGRAM_BUCKETS: '0.5,0.1,1',
    });
    expect(config.metrics.histogramBuckets).toEqual(DEFAULT_HISTOGRAM_BUCKETS);
  });
});

describe('DEFAULT_HISTOGRAM_BUCKETS', () => {
  it('is a non-empty array', () => {
    expect(DEFAULT_HISTOGRAM_BUCKETS.length).toBeGreaterThan(0);
  });

  it('is strictly increasing', () => {
    for (let i = 1; i < DEFAULT_HISTOGRAM_BUCKETS.length; i++) {
      expect(DEFAULT_HISTOGRAM_BUCKETS[i]).toBeGreaterThan(DEFAULT_HISTOGRAM_BUCKETS[i - 1]);
    }
  });

  it('all values are positive', () => {
    for (const b of DEFAULT_HISTOGRAM_BUCKETS) {
      expect(b).toBeGreaterThan(0);
    }
  });

  it('covers SLO thresholds: healthCheck p95=50ms (0.05s) and p99=100ms (0.1s)', () => {
    const buckets = DEFAULT_HISTOGRAM_BUCKETS as readonly number[];
    expect(buckets).toContain(0.05);
    expect(buckets).toContain(0.1);
  });

  it('covers SLO thresholds: contractsApi p99=500ms (0.5s)', () => {
    expect(DEFAULT_HISTOGRAM_BUCKETS).toContain(0.5);
  });

  it('covers contractsApi p95=200ms — a bucket boundary exists between 100ms and 250ms', () => {
    // 200ms = 0.2s falls between 0.1 and 0.25 in the default buckets,
    // which is sufficient for linear interpolation by the SLO evaluator.
    const buckets = [...DEFAULT_HISTOGRAM_BUCKETS];
    const lowerBound = buckets.filter((b) => b <= 0.2);
    const upperBound = buckets.filter((b) => b >= 0.2);
    expect(lowerBound.length).toBeGreaterThan(0);
    expect(upperBound.length).toBeGreaterThan(0);
  });
});

describe('validateHistogramBuckets', () => {
  it('accepts a valid strictly-increasing positive array', () => {
    const result = validateHistogramBuckets([0.01, 0.05, 0.1, 0.5, 1]);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.buckets).toEqual([0.01, 0.05, 0.1, 0.5, 1]);
    }
  });

  it('rejects non-array input', () => {
    const result = validateHistogramBuckets('not-an-array');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toMatch(/array/i);
    }
  });

  it('rejects empty array', () => {
    const result = validateHistogramBuckets([]);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toMatch(/empty/i);
    }
  });

  it('rejects array with non-finite values (NaN)', () => {
    const result = validateHistogramBuckets([0.1, NaN, 0.5]);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toMatch(/finite/i);
    }
  });

  it('rejects array with Infinity', () => {
    const result = validateHistogramBuckets([0.1, Infinity]);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toMatch(/finite/i);
    }
  });

  it('rejects array with negative values', () => {
    const result = validateHistogramBuckets([-0.1, 0.5, 1]);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toMatch(/positive/i);
    }
  });

  it('rejects array with zero values', () => {
    const result = validateHistogramBuckets([0, 0.5, 1]);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toMatch(/positive/i);
    }
  });

  it('rejects array with duplicate values (not strictly increasing)', () => {
    const result = validateHistogramBuckets([0.1, 0.1, 0.5]);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toMatch(/strictly increasing/i);
    }
  });

  it('rejects array with decreasing values', () => {
    const result = validateHistogramBuckets([0.5, 0.1, 1]);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toMatch(/strictly increasing/i);
    }
  });

  it('rejects array with non-number elements (string)', () => {
    const result = validateHistogramBuckets([0.1, '0.5', 1]);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toMatch(/finite/i);
    }
  });

  it('accepts single-element array', () => {
    const result = validateHistogramBuckets([0.5]);
    expect(result.valid).toBe(true);
  });

  it('accepts very small positive values', () => {
    const result = validateHistogramBuckets([0.001, 0.005, 0.01]);
    expect(result.valid).toBe(true);
  });
});

describe('parseHistogramBucketsEnv', () => {
  it('returns null when value is undefined', () => {
    expect(parseHistogramBucketsEnv(undefined)).toBeNull();
  });

  it('returns null when value is empty string', () => {
    expect(parseHistogramBucketsEnv('')).toBeNull();
  });

  it('returns null when value is whitespace only', () => {
    expect(parseHistogramBucketsEnv('   ')).toBeNull();
  });

  it('parses a valid comma-separated bucket string', () => {
    expect(parseHistogramBucketsEnv('0.005,0.01,0.05,0.1,0.5,1')).toEqual([
      0.005, 0.01, 0.05, 0.1, 0.5, 1,
    ]);
  });

  it('trims whitespace around values', () => {
    expect(parseHistogramBucketsEnv(' 0.1 , 0.5 , 1.0 ')).toEqual([0.1, 0.5, 1.0]);
  });

  it('returns null for non-numeric values', () => {
    expect(parseHistogramBucketsEnv('0.1,abc,1')).toBeNull();
  });

  it('returns null for non-increasing values', () => {
    expect(parseHistogramBucketsEnv('1,0.5,0.1')).toBeNull();
  });

  it('returns null for a single invalid bucket (negative)', () => {
    expect(parseHistogramBucketsEnv('-0.1,0.5,1')).toBeNull();
  });

  it('returns null when all values are the same (not strictly increasing)', () => {
    expect(parseHistogramBucketsEnv('0.5,0.5,0.5')).toBeNull();
  });

  it('parses a single-element bucket list', () => {
    expect(parseHistogramBucketsEnv('0.5')).toEqual([0.5]);
  });

  it('handles trailing comma gracefully', () => {
    // The trailing comma produces an empty string that is filtered out,
    // leaving a valid array.
    expect(parseHistogramBucketsEnv('0.1,0.5,1,')).toEqual([0.1, 0.5, 1]);
  });
});
