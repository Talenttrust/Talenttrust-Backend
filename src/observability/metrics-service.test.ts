import { Registry } from 'prom-client';
import { EventEmitter } from 'events';
import { NextFunction, Request, Response } from 'express';
import { MetricsService } from './metrics-service';

function makeService(httpRouteLabelLimit?: number) {
  const register = new Registry();
  const service = new MetricsService('test', register, { httpRouteLabelLimit });
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
