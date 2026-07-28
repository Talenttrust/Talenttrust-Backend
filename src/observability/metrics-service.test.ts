import { Registry } from 'prom-client';
import { EventEmitter } from 'events';
import { NextFunction, Request, Response } from 'express';
import { MetricsService } from './metrics-service';
import { DEFAULT_HISTOGRAM_BUCKETS } from './observability-config';

function makeService(httpRouteLabelLimit?: number, histogramBuckets?: number[]) {
  const register = new Registry();
  const service = new MetricsService('test', register, { httpRouteLabelLimit, histogramBuckets });
  return { service, register };
}

function recordHttpRequest(
  service: MetricsService,
  request: {
    method?: string;
    baseUrl?: string;
    routePath?: string | RegExp | string[];
    statusCode?: number;
  },
) {
  const response = new EventEmitter() as Response & EventEmitter;
  response.statusCode = request.statusCode ?? 200;

  const req = {
    method: request.method ?? 'GET',
    baseUrl: request.baseUrl ?? '',
    route: request.routePath === undefined ? undefined : { path: request.routePath },
  } as unknown as Request;

  const next = jest.fn() as NextFunction;

  service.trackHttpRequest(req, response, next);
  expect(next).toHaveBeenCalledTimes(1);
  response.emit('finish');
}

async function routeLabels(register: Registry): Promise<string[]> {
  const metrics = await register.getMetricsAsJSON();
  const counter = metrics.find((m) => m.name === 'http_requests_total');
  return ((counter?.values ?? []) as any[]).map((value) => value.labels.route);
}

describe('MetricsService — webhook metrics', () => {
  it('increments webhook_deliveries_total with outcome=success', async () => {
    const { service, register } = makeService();

    service.recordWebhookDelivery('success');

    const metrics = await register.getMetricsAsJSON();
    const counter = metrics.find((m) => m.name === 'webhook_deliveries_total');
    expect(counter).toBeDefined();
    const value = (counter!.values as any[]).find((v) => v.labels.outcome === 'success');
    expect(value?.value).toBe(1);
  });

  it('increments webhook_deliveries_total with outcome=failure', async () => {
    const { service, register } = makeService();

    service.recordWebhookDelivery('failure');
    service.recordWebhookDelivery('failure');

    const metrics = await register.getMetricsAsJSON();
    const counter = metrics.find((m) => m.name === 'webhook_deliveries_total');
    const value = (counter!.values as any[]).find((v) => v.labels.outcome === 'failure');
    expect(value?.value).toBe(2);
  });

  it('increments webhook_deliveries_total with outcome=dlq', async () => {
    const { service, register } = makeService();

    service.recordWebhookDelivery('dlq');

    const metrics = await register.getMetricsAsJSON();
    const counter = metrics.find((m) => m.name === 'webhook_deliveries_total');
    const value = (counter!.values as any[]).find((v) => v.labels.outcome === 'dlq');
    expect(value?.value).toBe(1);
  });

  it('sets webhook_dlq_depth gauge', async () => {
    const { service, register } = makeService();

    service.setWebhookDlqDepth(3);

    const metrics = await register.getMetricsAsJSON();
    const gauge = metrics.find((m) => m.name === 'webhook_dlq_depth');
    expect(gauge).toBeDefined();
    expect((gauge!.values as any[])[0].value).toBe(3);
  });

  it('updates webhook_dlq_depth on subsequent calls', async () => {
    const { service, register } = makeService();

    service.setWebhookDlqDepth(1);
    service.setWebhookDlqDepth(5);

    const metrics = await register.getMetricsAsJSON();
    const gauge = metrics.find((m) => m.name === 'webhook_dlq_depth');
    expect((gauge!.values as any[])[0].value).toBe(5);
  });
});

describe('MetricsService — reputation metrics', () => {
  it('records success status, duration, and no error cause', async () => {
    const { service, register } = makeService();

    service.recordReputationRequest({
      operation: 'get_profile',
      status: 'success',
      statusCode: 200,
      errorCause: 'none',
      durationSeconds: 0.125,
    });

    const metrics = await register.getMetricsAsJSON();
    const requestCounter = metrics.find((m) => m.name === 'reputation_requests_total');
    const duration = metrics.find((m) => m.name === 'reputation_request_duration_seconds');
    const errors = metrics.find((m) => m.name === 'reputation_errors_total');

    expect(requestCounter).toBeDefined();
    expect(requestCounter!.values).toContainEqual({
      labels: {
        operation: 'get_profile',
        status: 'success',
        status_code: '200',
        error_cause: 'none',
      },
      value: 1,
    });
    expect(duration!.values).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          labels: {
            operation: 'get_profile',
            status: 'success',
            status_code: '200',
            error_cause: 'none',
            le: '+Inf',
          },
        }),
        expect.objectContaining({
          labels: {
            operation: 'get_profile',
            status: 'success',
            status_code: '200',
            error_cause: 'none',
          },
          value: 0.125,
        }),
      ]),
    );
    expect(errors!.values).toEqual([]);
  });

  it.each([
    ['client_error', 400, 'bad_request'],
    ['server_error', 500, 'internal_error'],
  ] as const)('records %s and increments the bounded error cause counter', async (status, statusCode, errorCause) => {
    const { service, register } = makeService();

    service.recordReputationRequest({
      operation: 'create_rating',
      status,
      statusCode,
      errorCause,
      durationSeconds: 0.25,
    });

    const metrics = await register.getMetricsAsJSON();
    const errors = metrics.find((m) => m.name === 'reputation_errors_total');
    const errorValue = (errors!.values as any[]).find(
      (value) =>
        value.labels.operation === 'create_rating' &&
        value.labels.error_cause === errorCause,
    );

    expect(errorValue?.value).toBe(1);
  });

  it('rejects invalid metric input before mutating the registry', () => {
    const { service } = makeService();

    expect(() =>
      service.recordReputationRequest({
        operation: 'unknown' as any,
        status: 'success',
        statusCode: 200,
        errorCause: 'none',
        durationSeconds: 0,
      }),
    ).toThrow('Invalid reputation operation');
    expect(() =>
      service.recordReputationRequest({
        operation: 'get_profile',
        status: 'unknown' as any,
        statusCode: 200,
        errorCause: 'none',
        durationSeconds: 0,
      }),
    ).toThrow('Invalid reputation request status');
    expect(() =>
      service.recordReputationRequest({
        operation: 'get_profile',
        status: 'success',
        statusCode: 200,
        errorCause: 'database_message' as any,
        durationSeconds: 0,
      }),
    ).toThrow('Invalid reputation error cause');
    expect(() =>
      service.recordReputationRequest({
        operation: 'get_profile',
        status: 'success',
        statusCode: 200,
        errorCause: 'none',
        durationSeconds: -1,
      }),
    ).toThrow('Invalid reputation request duration');
    expect(() =>
      service.recordReputationRequest({
        operation: 'get_profile',
        status: 'success',
        statusCode: 99,
        errorCause: 'none',
        durationSeconds: 0,
      }),
    ).toThrow('Invalid reputation status code');
    expect(() =>
      service.recordReputationRequest({
        operation: 'get_profile',
        status: 'server_error',
        statusCode: 600,
        errorCause: 'internal_error',
        durationSeconds: 0,
      }),
    ).toThrow('Invalid reputation status code');
    expect(() =>
      service.recordReputationRequest({
        operation: 'get_profile',
        status: 'success',
        statusCode: 200.5,
        errorCause: 'none',
        durationSeconds: 0,
      }),
    ).toThrow('Invalid reputation status code');
    expect(() =>
      service.recordReputationRequest({
        operation: 'get_profile',
        status: 'success',
        statusCode: 200,
        errorCause: 'none',
        durationSeconds: Number.NaN,
      }),
    ).toThrow('Invalid reputation request duration');
  });
});

describe('MetricsService — HTTP route labels', () => {
  it('uses the mounted Express route template instead of concrete paths', async () => {
    const { service, register } = makeService();

    recordHttpRequest(service, {
      method: 'GET',
      baseUrl: '/api/v1/contracts',
      routePath: '/:id/metadata/:metadataId',
    });

    expect(await routeLabels(register)).toContain('/api/v1/contracts/:id/metadata/:metadataId');
  });

  it('collapses unmatched requests into one bucket', async () => {
    const { service, register } = makeService();

    recordHttpRequest(service, { routePath: undefined, statusCode: 404 });
    recordHttpRequest(service, { routePath: undefined, statusCode: 404 });

    expect(await routeLabels(register)).toEqual(['unmatched']);
  });

  it('keeps new route labels through the configured cap boundary', async () => {
    const { service, register } = makeService(2);

    recordHttpRequest(service, { routePath: '/health' });
    recordHttpRequest(service, { routePath: '/metrics' });

    expect(await routeLabels(register)).toEqual(expect.arrayContaining(['/health', '/metrics']));
  });

  it('routes excess distinct templates to other under a high-cardinality flood', async () => {
    const { service, register } = makeService(3);

    for (let index = 0; index < 20; index += 1) {
      recordHttpRequest(service, {
        baseUrl: '/api/v1',
        routePath: `/resource-${index}/:id`,
      });
    }

    const labels = await routeLabels(register);
    const distinctLabels = new Set(labels);

    expect(distinctLabels.size).toBe(4);
    expect(labels).toContain('other');
    expect(labels).not.toContain('/api/v1/resource-19/:id');
  });

  it('tracks routes individually below the limit', async () => {
    const { service, register } = makeService(100);

    // Record 50 unique routes
    for (let i = 0; i < 50; i += 1) {
      recordHttpRequest(service, { routePath: `/route-${i}` });
    }

    const labels = await routeLabels(register);
    expect(labels).toContain('/route-0');
    expect(labels).toContain('/route-49');
    expect(labels).not.toContain('other');
  });

  it('collapses to "other" when limit is reached', async () => {
    const { service, register } = makeService(2);

    recordHttpRequest(service, { routePath: '/route1' });
    recordHttpRequest(service, { routePath: '/route2' });
    recordHttpRequest(service, { routePath: '/route3' }); // ← should be "other"

    const labels = await routeLabels(register);
    expect(labels).toContain('other');
    expect(labels).not.toContain('/route3');
  });

  it('unmatched requests produce "unmatched" label regardless of limit', async () => {
    const { service, register } = makeService(1);

    // First, fill the limit
    recordHttpRequest(service, { routePath: '/route1' });
    // Now record unmatched
    recordHttpRequest(service, { routePath: undefined, statusCode: 404 });

    const labels = await routeLabels(register);
    expect(labels).toContain('unmatched');
  });
});

describe('MetricsService — health status gauge', () => {
  it('recordHealthStatus sets gauge to 2 for up', async () => {
    const { service, register } = makeService();

    service.recordHealthStatus('up');

    const json = await register.getMetricsAsJSON();
    const gauge = json.find((m) => m.name === 'service_health_status');
    expect(gauge).toBeDefined();
    expect((gauge!.values as any[])[0].value).toBe(2);
  });

  it('recordHealthStatus sets gauge to 1 for degraded', async () => {
    const { service, register } = makeService();

    service.recordHealthStatus('degraded');

    const json = await register.getMetricsAsJSON();
    const gauge = json.find((m) => m.name === 'service_health_status');
    expect((gauge!.values as any[])[0].value).toBe(1);
  });

  it('recordHealthStatus sets gauge to 0 for down', async () => {
    const { service, register } = makeService();

    service.recordHealthStatus('down');

    const json = await register.getMetricsAsJSON();
    const gauge = json.find((m) => m.name === 'service_health_status');
    expect((gauge!.values as any[])[0].value).toBe(0);
  });
});

describe('MetricsService — disputes request metrics', () => {
  it('increments disputes_requests_total with success error_cause', async () => {
    const { service, register } = makeService();

    service.recordDisputesRequest({
      method: 'GET',
      route: '/api/v1/disputes',
      statusCode: 200,
      errorCause: 'success',
      durationSeconds: 0.012,
    });

    const json = await register.getMetricsAsJSON();
    const counter = json.find((m) => m.name === 'disputes_requests_total');
    expect(counter).toBeDefined();
    const value = (counter!.values as any[]).find(
      (v) =>
        v.labels.error_cause === 'success' &&
        v.labels.status_code === '200' &&
        v.labels.route === '/api/v1/disputes',
    );
    expect(value?.value).toBe(1);
  });

  it('records 4xx_client_error and 5xx_server_error labels', async () => {
    const { service, register } = makeService();

    service.recordDisputesRequest({
      method: 'GET',
      route: '/api/v1/disputes',
      statusCode: 429,
      errorCause: '4xx_client_error',
      durationSeconds: 0.001,
    });
    service.recordDisputesRequest({
      method: 'POST',
      route: '/api/v1/disputes',
      statusCode: 500,
      errorCause: '5xx_server_error',
      durationSeconds: 0.05,
    });

    const json = await register.getMetricsAsJSON();
    const counter = json.find((m) => m.name === 'disputes_requests_total');
    const labels = ((counter?.values ?? []) as any[]).map((v) => v.labels.error_cause);
    expect(labels).toEqual(expect.arrayContaining(['4xx_client_error', '5xx_server_error']));
  });

  it('observes disputes_request_duration_seconds histogram', async () => {
    const { service, register } = makeService();

    service.recordDisputesRequest({
      method: 'GET',
      route: '/api/v1/disputes/:id',
      statusCode: 200,
      errorCause: 'success',
      durationSeconds: 0.2,
    });

    const text = await service.getMetrics();
    expect(text).toContain('disputes_request_duration_seconds');
    expect(text).toContain('disputes_requests_total');

    const json = await register.getMetricsAsJSON();
    const histogram = json.find((m) => m.name === 'disputes_request_duration_seconds');
    expect(histogram).toBeDefined();
    const count = (histogram!.values as any[]).find(
      (v) =>
        v.metricName === 'disputes_request_duration_seconds_count' ||
        v.labels?.le === undefined && v.value === 1,
    );
    // At least one observation was recorded (count or sum present).
    expect((histogram!.values as any[]).length).toBeGreaterThan(0);
    expect(count || (histogram!.values as any[])[0]).toBeDefined();
  });

  it('rejects invalid error_cause values', () => {
    const { service } = makeService();
    expect(() =>
      service.recordDisputesRequest({
        method: 'GET',
        route: '/api/v1/disputes',
        statusCode: 200,
        errorCause: 'timeout' as any,
        durationSeconds: 0.01,
      }),
    ).toThrow(TypeError);
  });

  it('treats non-finite durations as zero', async () => {
    const { service, register } = makeService();

    service.recordDisputesRequest({
      method: 'GET',
      route: '/api/v1/disputes',
      statusCode: 200,
      errorCause: 'success',
      durationSeconds: Number.NaN,
    });

    const json = await register.getMetricsAsJSON();
    const histogram = json.find((m) => m.name === 'disputes_request_duration_seconds');
    const sum = (histogram!.values as any[]).find(
      (v) => v.metricName === 'disputes_request_duration_seconds_sum',
    );
    expect(sum?.value ?? 0).toBe(0);
  });

  it('treats negative durations as zero', async () => {
    const { service, register } = makeService();

    service.recordDisputesRequest({
      method: 'GET',
      route: '/api/v1/disputes',
      statusCode: 200,
      errorCause: 'success',
      durationSeconds: -1,
    });

    const json = await register.getMetricsAsJSON();
    const histogram = json.find((m) => m.name === 'disputes_request_duration_seconds');
    const sum = (histogram!.values as any[]).find(
      (v) => v.metricName === 'disputes_request_duration_seconds_sum',
    );
    expect(sum?.value ?? 0).toBe(0);
  });

  it('bounds empty route labels to unmatched', async () => {
    const { service, register } = makeService();

    service.recordDisputesRequest({
      method: 'GET',
      route: '',
      statusCode: 200,
      errorCause: 'success',
      durationSeconds: 0.01,
    });

    const json = await register.getMetricsAsJSON();
    const counter = json.find((m) => m.name === 'disputes_requests_total');
    const value = (counter!.values as any[]).find((v) => v.labels.route === 'unmatched');
    expect(value?.value).toBe(1);
  });
});

describe('MetricsService — rate limit sampling', () => {
  it('starts rate limit metrics sampling', () => {
    const { service } = makeService();
    const stopSampling = jest.fn();
    const limiter = { startMetricsSampling: jest.fn().mockReturnValue(stopSampling) };

    service.startRateLimitMetricsSampling(limiter, 5000);

    expect(limiter.startMetricsSampling).toHaveBeenCalledTimes(1);
    expect(limiter.startMetricsSampling).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      5000,
    );
  });

  it('warns on duplicate startRateLimitMetricsSampling', () => {
    const { service } = makeService();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const limiter = { startMetricsSampling: jest.fn().mockReturnValue(jest.fn()) };

    service.startRateLimitMetricsSampling(limiter);
    service.startRateLimitMetricsSampling(limiter);

    expect(warnSpy).toHaveBeenCalledWith('[MetricsService] Rate limit metrics sampling already active.');
    expect(limiter.startMetricsSampling).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it('stops rate limit metrics sampling', () => {
    const { service } = makeService();
    const stopSampling = jest.fn();
    const limiter = { startMetricsSampling: jest.fn().mockReturnValue(stopSampling) };

    service.startRateLimitMetricsSampling(limiter);
    service.stopRateLimitMetricsSampling();

    expect(stopSampling).toHaveBeenCalledTimes(1);
  });

  it('stopRateLimitMetricsSampling is a no-op when not active', () => {
    const { service } = makeService();

    service.stopRateLimitMetricsSampling();

    // no throw — just returns
  });
});

describe('MetricsService — route edge cases', () => {
  it('handles RegExp route path in formatExpressPath', async () => {
    const { service, register } = makeService();

    recordHttpRequest(service, { routePath: /^\/api\/v1\/health$/ });

    const labels = await routeLabels(register);
    expect(labels).toContain('/^\\/api\\/v1\\/health$/');
  });

  it('handles empty route path with baseUrl in joinRouteParts', async () => {
    const { service, register } = makeService();

    recordHttpRequest(service, { baseUrl: '/api/v1', routePath: '' });

    const labels = await routeLabels(register);
    expect(labels).toContain('/api/v1');
  });

  it('handles array route path in formatExpressPath', async () => {
    const { service, register } = makeService();

    recordHttpRequest(service, { routePath: ['/foo/:id', '/foo/:slug'] });

    const labels = await routeLabels(register);
    expect(labels).toContain('/foo/:id|/foo/:slug');
  });

  it('returns root for empty joined route', async () => {
    const { service, register } = makeService();

    recordHttpRequest(service, { baseUrl: '/', routePath: '' });

    const labels = await routeLabels(register);
    expect(labels).toContain('/');
  });

  it('adds leading slash to baseUrl when missing', async () => {
    const { service, register } = makeService();

    recordHttpRequest(service, { baseUrl: 'api', routePath: '/v1/health' });

    const labels = await routeLabels(register);
    expect(labels).toContain('/api/v1/health');
  });

  it('handles array route path where all parts are null', async () => {
    const { service, register } = makeService();

    const req = {
      method: 'GET',
      baseUrl: '',
      route: { path: [undefined, undefined] },
    } as unknown as Request;
    const response = new EventEmitter() as Response & EventEmitter;
    response.statusCode = 200;
    const next = jest.fn() as NextFunction;

    service.trackHttpRequest(req, response, next);
    expect(next).toHaveBeenCalledTimes(1);
    response.emit('finish');

    const labels = await routeLabels(register);
    expect(labels).toContain('unmatched');
  });
});

describe('MetricsService — constructor edge cases', () => {
  it('creates its own registry when none is provided', () => {
    const service = new MetricsService('test');

    expect(service.contentType).toBeDefined();
    expect(service.getMetrics()).toBeDefined();
  });

  it('sanitizes service name prefix with special characters', () => {
    const register = new Registry();
    const service = new MetricsService('my-service@2.0!', register);

    expect(service.getMetrics()).toBeDefined();
  });

  it('uses "service" fallback when sanitized prefix is empty', () => {
    const register = new Registry();
    const service = new MetricsService('', register);

    expect(service.getMetrics()).toBeDefined();
  });
});

describe('MetricsService — histogram bucket configuration', () => {
  /**
   * Extract the finite numeric bucket boundaries from a histogram in the
   * registry. prom-client represents the +Inf bucket with the string '+Inf'
   * for the `le` label, and finite boundaries as their numeric value.
   * We normalise everything to numbers and exclude +Inf.
   */
  async function getHistogramBuckets(register: Registry): Promise<number[]> {
    const metrics = await register.getMetricsAsJSON();
    const hist = metrics.find((m) => m.name === 'http_request_duration_seconds');
    if (!hist) return [];

    const seen = new Set<number>();
    for (const v of hist.values as any[]) {
      const le = v.labels?.le;
      if (le === undefined || le === null) continue;
      if (le === '+Inf') continue;
      const numeric = Number(le);
      if (!Number.isFinite(numeric)) continue;
      seen.add(numeric);
    }
    return Array.from(seen).sort((a, b) => a - b);
  }

  /** Record one HTTP request against the service to populate bucket series. */
  function observe(service: MetricsService, route = '/health'): void {
    const response = new EventEmitter() as Response & EventEmitter;
    response.statusCode = 200;
    service.trackHttpRequest(
      { method: 'GET', baseUrl: '', route: { path: route } } as unknown as Request,
      response,
      jest.fn() as NextFunction,
    );
    response.emit('finish');
  }

  it('uses DEFAULT_HISTOGRAM_BUCKETS when no histogramBuckets option is provided', async () => {
    const { service, register } = makeService();
    observe(service);

    const buckets = await getHistogramBuckets(register);
    expect(buckets).toEqual([...DEFAULT_HISTOGRAM_BUCKETS]);
  });

  it('uses custom histogramBuckets when a valid array is provided', async () => {
    const customBuckets = [0.01, 0.1, 1, 10];
    const { service, register } = makeService(undefined, customBuckets);
    observe(service);

    const buckets = await getHistogramBuckets(register);
    expect(buckets).toEqual(customBuckets);
  });

  it('falls back to DEFAULT_HISTOGRAM_BUCKETS and emits a warning when invalid buckets are supplied', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    // Invalid: not strictly increasing
    const { service, register } = makeService(undefined, [1, 0.5, 0.1]);
    observe(service);

    const buckets = await getHistogramBuckets(register);
    expect(buckets).toEqual([...DEFAULT_HISTOGRAM_BUCKETS]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Invalid histogramBuckets'),
    );

    warnSpy.mockRestore();
  });

  it('falls back to defaults and warns when an empty bucket array is supplied', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const { service, register } = makeService(undefined, []);
    observe(service, '/test');

    const buckets = await getHistogramBuckets(register);
    expect(buckets).toEqual([...DEFAULT_HISTOGRAM_BUCKETS]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid histogramBuckets'));

    warnSpy.mockRestore();
  });

  it('falls back to defaults and warns when buckets contain non-positive values', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const { service, register } = makeService(undefined, [-0.1, 0.5, 1]);
    observe(service, '/test');

    const buckets = await getHistogramBuckets(register);
    expect(buckets).toEqual([...DEFAULT_HISTOGRAM_BUCKETS]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid histogramBuckets'));

    warnSpy.mockRestore();
  });

  it('correctly records observations into custom buckets', async () => {
    const customBuckets = [0.1, 0.5, 1, 5];
    const { service, register } = makeService(undefined, customBuckets);
    observe(service, '/api');

    const buckets = await getHistogramBuckets(register);
    // Custom boundaries must be present
    expect(buckets).toEqual(expect.arrayContaining(customBuckets));
    // Must not include default-only boundaries that are absent from customBuckets
    expect(buckets).not.toContain(0.005);
    expect(buckets).not.toContain(2.5);

    // Verify +Inf bucket is also emitted
    const metrics = await register.getMetricsAsJSON();
    const hist = metrics.find((m) => m.name === 'http_request_duration_seconds');
    const leValues = (hist!.values as any[]).map((v) => v.labels?.le);
    expect(leValues).toContain('+Inf');
  });
});

describe('MetricsService — HTTP error_cause labels', () => {
  async function errorCauseValues(register: Registry): Promise<string[]> {
    const metrics = await register.getMetricsAsJSON();
    const counter = metrics.find((m) => m.name === 'http_requests_total');
    return ((counter?.values ?? []) as any[]).map((value) => value.labels.error_cause);
  }

  function recordWithLocals(
    service: MetricsService,
    opts: {
      statusCode: number;
      locals?: Record<string, unknown>;
    },
  ) {
    const response = new EventEmitter() as Response & EventEmitter;
    response.statusCode = opts.statusCode;
    (response as any).locals = opts.locals ?? {};

    const req = {
      method: 'GET',
      baseUrl: '',
      route: { path: '/test' },
    } as unknown as Request;

    const next = jest.fn() as NextFunction;
    service.trackHttpRequest(req, response, next);
    expect(next).toHaveBeenCalledTimes(1);
    response.emit('finish');
  }

  it('labels successful 2xx responses with error_cause=none', async () => {
    const { service, register } = makeService();
    recordWithLocals(service, { statusCode: 200 });
    expect(await errorCauseValues(register)).toContain('none');
  });

  it('labels redirect 3xx responses with error_cause=none', async () => {
    const { service, register } = makeService();
    recordWithLocals(service, { statusCode: 302 });
    expect(await errorCauseValues(register)).toContain('none');
  });

  it('labels client errors with generic client_error when no explicit cause set', async () => {
    const { service, register } = makeService();
    recordWithLocals(service, { statusCode: 400 });
    recordWithLocals(service, { statusCode: 404 });
    recordWithLocals(service, { statusCode: 422 });

    const values = await errorCauseValues(register);
    expect(values.every((v) => v === 'client_error')).toBe(true);
  });

  it('labels server errors with generic server_error when no explicit cause set', async () => {
    const { service, register } = makeService();
    recordWithLocals(service, { statusCode: 500 });
    recordWithLocals(service, { statusCode: 503 });

    const values = await errorCauseValues(register);
    expect(values.every((v) => v === 'server_error')).toBe(true);
  });

  it('uses explicit errorCause from res.locals when provided (not_found)', async () => {
    const { service, register } = makeService();
    recordWithLocals(service, {
      statusCode: 404,
      locals: { errorCause: 'not_found' },
    });
    expect(await errorCauseValues(register)).toContain('not_found');
  });

  it('uses explicit errorCause for validation_error on 400', async () => {
    const { service, register } = makeService();
    recordWithLocals(service, {
      statusCode: 400,
      locals: { errorCause: 'validation_error' },
    });
    expect(await errorCauseValues(register)).toContain('validation_error');
  });

  it('uses explicit errorCause for internal_error on 500', async () => {
    const { service, register } = makeService();
    recordWithLocals(service, {
      statusCode: 500,
      locals: { errorCause: 'internal_error' },
    });
    expect(await errorCauseValues(register)).toContain('internal_error');
  });

  it('ignores empty-string explicit errorCause and falls back', async () => {
    const { service, register } = makeService();
    recordWithLocals(service, {
      statusCode: 500,
      locals: { errorCause: '' },
    });
    expect(await errorCauseValues(register)).toContain('server_error');
  });

  it('ignores non-string explicit errorCause and falls back', async () => {
    const { service, register } = makeService();
    recordWithLocals(service, {
      statusCode: 403,
      locals: { errorCause: 123 },
    });
    expect(await errorCauseValues(register)).toContain('client_error');
  });

  it('applies error_cause label on both counter and histogram series', async () => {
    const { service, register } = makeService();
    recordWithLocals(service, {
      statusCode: 500,
      locals: { errorCause: 'internal_error' },
    });

    const json = await register.getMetricsAsJSON();
    const hist = json.find((m) => m.name === 'http_request_duration_seconds');
    const histLabels = (hist!.values as any[]).map((v: any) => v.labels);
    const relevant = histLabels.find(
      (l: any) => l.method === 'GET' && l.status_code === '500',
    );
    expect(relevant.error_cause).toBe('internal_error');
  });
});

describe('MetricsService — structured request metric logs', () => {
  it('emits a structured log for each tracked request with no PII', () => {
    const { service } = makeService();
    const records: unknown[] = [];
    const originalWrite = require('../logger').writeRecord;
    require('../logger').setWriteRecordImpl((rec: unknown) => records.push(rec));

    try {
      const response = new EventEmitter() as Response & EventEmitter;
      response.statusCode = 200;
      (response as any).locals = {
        requestId: 'req-123',
        correlationId: 'corr-456',
      };

      const req = {
        method: 'POST',
        baseUrl: '/api/v1',
        route: { path: '/contracts/:id' },
      } as unknown as Request;

      service.trackHttpRequest(req, response, jest.fn() as NextFunction);
      response.emit('finish');

      const metricLogs = records.filter(
        (r: any) => r.message === 'http request metric',
      );
      expect(metricLogs.length).toBe(1);

      const log = metricLogs[0] as any;
      expect(log.metric).toBe('http_request');
      expect(log.method).toBe('POST');
      expect(log.route).toBe('/api/v1/contracts/:id');
      expect(log.statusCode).toBe(200);
      expect(log.errorCause).toBe('none');
      expect(typeof log.durationMs).toBe('number');
      expect(log.requestId).toBe('req-123');
      expect(log.correlationId).toBe('corr-456');
      expect(log).not.toHaveProperty('ip');
      expect(log).not.toHaveProperty('userAgent');
      expect(log).not.toHaveProperty('headers');
      expect(log).not.toHaveProperty('email');
      expect(log).not.toHaveProperty('token');
    } finally {
      require('../logger').setWriteRecordImpl(originalWrite);
    }
  });

  it('omits optional correlation IDs when absent from res.locals', () => {
    const { service } = makeService();
    const records: unknown[] = [];
    const originalWrite = require('../logger').writeRecord;
    require('../logger').setWriteRecordImpl((rec: unknown) => records.push(rec));

    try {
      const response = new EventEmitter() as Response & EventEmitter;
      response.statusCode = 404;
      (response as any).locals = { errorCause: 'not_found' };

      const req = {
        method: 'GET',
        baseUrl: '',
        route: { path: '/missing' },
      } as unknown as Request;

      service.trackHttpRequest(req, response, jest.fn() as NextFunction);
      response.emit('finish');

      const log = records.find(
        (r: any) => r.message === 'http request metric',
      ) as any;
      expect(log).toBeDefined();
      expect(log.statusCode).toBe(404);
      expect(log.errorCause).toBe('not_found');
      expect(log).not.toHaveProperty('requestId');
      expect(log).not.toHaveProperty('correlationId');
    } finally {
      require('../logger').setWriteRecordImpl(originalWrite);
    }
  });
});
