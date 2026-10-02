import { EventEmitter } from 'events';
import { NextFunction, Request, Response } from 'express';
import { Registry } from 'prom-client';

import { MetricsService } from './metrics-service';

function record(statusCode: number, routePath = '/login', errorCause?: string) {
  const registry = new Registry();
  const service = new MetricsService('test', registry);
  const response = new EventEmitter() as Response & EventEmitter;
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  response.statusCode = statusCode;
  response.locals = { log, ...(errorCause && { errorCause }) };
  const request = {
    method: 'POST',
    route: { path: routePath },
  } as unknown as Request;
  const next = jest.fn() as NextFunction;

  service.trackAuthRequest(request, response, next);
  expect(next).toHaveBeenCalledTimes(1);
  response.emit('finish');

  return { registry, service, log };
}

describe('auth observability', () => {
  it('records request status and duration and emits a structured success log', async () => {
    const { registry, log } = record(200);
    const metrics = await registry.getMetricsAsJSON();

    expect(metrics.find(metric => metric.name === 'auth_requests_total')?.values)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          labels: { operation: 'login', status_code: '200' },
          value: 1,
        }),
      ]));
    expect(metrics.find(metric => metric.name === 'auth_request_duration_seconds')?.values)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          labels: expect.objectContaining({ operation: 'login', status_code: '200' }),
        }),
      ]));
    expect(log.info).toHaveBeenCalledWith('auth_request', expect.objectContaining({
      method: 'POST',
      route: '/api/v1/auth/login',
      operation: 'login',
      statusCode: 200,
      outcome: 'success',
      durationMs: expect.any(Number),
    }));
  });

  it.each([
    [400, 'validation_error', 'validation_error'],
    [401, 'invalid_credentials', 'invalid_credentials'],
    [401, 'invalid_refresh_token', 'invalid_token'],
    [409, 'conflict', 'conflict'],
    [429, undefined, 'rate_limit'],
  ])('records status %i with bounded cause %s', async (statusCode, explicit, expected) => {
    const { service, log } = record(statusCode, '/login', explicit);

    expect(await service.getMetrics()).toContain(
      `auth_errors_total{operation="login",cause="${expected}"} 1`,
    );
    expect(log.warn).toHaveBeenCalledWith('auth_request', expect.objectContaining({
      statusCode,
      errorCause: expected,
      outcome: 'error',
    }));
  });

  it('records server errors and never adds request data or PII to logs', async () => {
    const { service, log } = record(500, '/register');

    expect(await service.getMetrics()).toContain(
      'auth_errors_total{operation="register",cause="server_error"} 1',
    );
    const fields = log.error.mock.calls[0][1];
    expect(fields).not.toHaveProperty('body');
    expect(fields).not.toHaveProperty('email');
    expect(fields).not.toHaveProperty('token');
  });

  it.each([
    ['/register', 'register'],
    ['/refresh', 'refresh'],
    ['/logout', 'logout'],
    ['/other', 'unknown'],
  ])('uses a bounded operation for %s', async (routePath, operation) => {
    const { registry } = record(200, routePath);
    const metric = (await registry.getMetricsAsJSON())
      .find(item => item.name === 'auth_requests_total');
    expect(metric?.values).toEqual(expect.arrayContaining([
      expect.objectContaining({ labels: { operation, status_code: '200' } }),
    ]));
  });
});
