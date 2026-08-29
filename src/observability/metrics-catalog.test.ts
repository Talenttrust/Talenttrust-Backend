/**
 * @file metrics-catalog.test.ts
 * @description Round-trip verification and SLO evaluation tests
 */

import { Registry } from 'prom-client';
import { CATALOG_METRIC_NAMES, MetricsService } from './metrics-service';
import {
  evaluateObjectives,
  readObservedMetrics,
  DefaultServiceObjectives,
} from '../operations/service-objectives';
import { EventEmitter } from 'events';
import { NextFunction, Request, Response } from 'express';

describe('Documentation round-trip verification', () => {
  it('all metrics in CATALOG_METRIC_NAMES are registered by MetricsService', async () => {
    const register = new Registry();
    const service = new MetricsService('test', register);

    const metricsText = await service.getMetrics();

    for (const name of CATALOG_METRIC_NAMES) {
      expect(metricsText).toContain(name);
    }
  });

  it('no undocumented metrics are registered (excluding default metrics)', async () => {
    const register = new Registry();
    new MetricsService('test', register);

    const json = await register.getMetricsAsJSON();
    const registered = json.map((m) => m.name);

    const undocumented = registered.filter(
      (name) =>
        !CATALOG_METRIC_NAMES.includes(name) && !name.startsWith('test_'),
    );

    expect(undocumented).toEqual([]);
  });

  it('all documented label names are observable in getMetricsAsJSON', async () => {
    const register = new Registry();
    const service = new MetricsService('test', register);

    // Record a sample HTTP request
    const response = new EventEmitter() as Response & EventEmitter;
    response.statusCode = 200;

    const req = {
      method: 'GET',
      baseUrl: '',
      route: { path: '/test' },
    } as unknown as Request;

    const next = jest.fn() as NextFunction;

    service.trackHttpRequest(req, response, next);
    response.emit('finish');

    const json = await register.getMetricsAsJSON();
    const httpCounter = json.find((m) => m.name === 'http_requests_total');

    expect(httpCounter).toBeDefined();
    const labels = (httpCounter!.values as any[])[0].labels;

    expect(labels).toHaveProperty('method');
    expect(labels).toHaveProperty('route');
    expect(labels).toHaveProperty('status_code');
    expect(labels).toHaveProperty('error_cause');
    expect(labels.error_cause).toBe('none');
  });
});

describe('evaluateObjectives - SLO compliance', () => {
  function recordRequestsWithSuccessRate(
    register: Registry,
    totalRequests: number,
    successRate: number,
  ) {
    const service = new MetricsService('test', register);

    const successCount = Math.floor(totalRequests * successRate);
    const failureCount = totalRequests - successCount;

    for (let i = 0; i < successCount; i += 1) {
      recordHttpRequest(service, register, 200);
    }

    for (let i = 0; i < failureCount; i += 1) {
      recordHttpRequest(service, register, 500);
    }
  }

  function recordHttpRequest(
    service: MetricsService,
    register: Registry,
    statusCode: number,
  ) {
    const response = new EventEmitter() as Response & EventEmitter;
    response.statusCode = statusCode;

    const req = {
      method: 'GET',
      baseUrl: '',
      route: { path: '/test' },
    } as unknown as Request;

    const next = jest.fn() as NextFunction;

    service.trackHttpRequest(req, response, next);
    response.emit('finish');
  }

  it('returns breached=true when success rate is below target', async () => {
    const register = new Registry();

    // Record 95% success rate (below 99.9% target for contractsApi)
    recordRequestsWithSuccessRate(register, 100, 0.95);

    const reports = await evaluateObjectives(register, DefaultServiceObjectives);

    const contractsApiReport = reports.find((r) => r.objectiveKey === 'contractsApi');
    expect(contractsApiReport).toBeDefined();
    expect(contractsApiReport!.breached).toBe(true);
    expect(contractsApiReport!.breaches.successRate).toBe(true);
  });

  it('returns breached=true when p95 latency exceeds target', async () => {
    const register = new Registry();
    const service = new MetricsService('test', register);

    // Record requests with high latency
    for (let i = 0; i < 100; i += 1) {
      const response = new EventEmitter() as Response & EventEmitter;
      response.statusCode = 200;

      const req = {
        method: 'GET',
        baseUrl: '',
        route: { path: '/test' },
      } as unknown as Request;

      const next = jest.fn() as NextFunction;

      // Mock high latency by manually observing duration
      service.trackHttpRequest(req, response, next);

      // Mock high latency by manually observing duration
      const histogram = (service as any).httpRequestDurationSeconds;
      histogram.observe(
        { method: 'GET', route: '/test', status_code: '200', error_cause: 'none' },
        0.3, // 300ms - exceeds healthCheck p95 target of 50ms
      );

      response.emit('finish');
    }

    const reports = await evaluateObjectives(register, DefaultServiceObjectives);

    const healthCheckReport = reports.find((r) => r.objectiveKey === 'healthCheck');
    expect(healthCheckReport).toBeDefined();
    expect(healthCheckReport!.breached).toBe(true);
    expect(healthCheckReport!.breaches.latencyP95).toBe(true);
  });

  it('returns breached=false when all metrics are within SLO', async () => {
    const register = new Registry();

    // Record 99.95% success rate (above 99.9% target)
    recordRequestsWithSuccessRate(register, 1000, 0.9995);

    const reports = await evaluateObjectives(register, DefaultServiceObjectives);

    const contractsApiReport = reports.find((r) => r.objectiveKey === 'contractsApi');
    expect(contractsApiReport).toBeDefined();
    expect(contractsApiReport!.breached).toBe(false);
  });
});

describe('readObservedMetrics', () => {
  it('returns null when registry contains no http metrics', async () => {
    const emptyRegister = new Registry();

    const result = await readObservedMetrics(emptyRegister);

    expect(result).toBeNull();
  });

  it('returns metrics snapshot when http metrics are present', async () => {
    const register = new Registry();
    const service = new MetricsService('test', register);

    // Record some requests
    recordHttpRequest(service, register, 200);
    recordHttpRequest(service, register, 200);

    const result = await readObservedMetrics(register);

    expect(result).not.toBeNull();
    expect(result).toHaveProperty('successRatePercent');
    expect(result).toHaveProperty('latencyP95Ms');
    expect(result).toHaveProperty('latencyP99Ms');
  });

  function recordHttpRequest(
    service: MetricsService,
    register: Registry,
    statusCode: number,
  ) {
    const response = new EventEmitter() as Response & EventEmitter;
    response.statusCode = statusCode;

    const req = {
      method: 'GET',
      baseUrl: '',
      route: { path: '/test' },
    } as unknown as Request;

    const next = jest.fn() as NextFunction;

    service.trackHttpRequest(req, response, next);
    response.emit('finish');
  }
});
