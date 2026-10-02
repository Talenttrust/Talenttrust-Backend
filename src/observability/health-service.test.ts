import {
  defaultThresholds,
  healthReportToHttpStatus,
  HealthService,
  RuntimeSignalProviders,
} from './health-service';
import { DependencyChecker } from './types';

function createProviders(overrides: Partial<RuntimeSignalProviders> = {}): RuntimeSignalProviders {
  return {
    now: () => new Date('2026-03-24T00:00:00.000Z'),
    uptimeSeconds: () => 42,
    eventLoopLagMs: () => 25,
    memoryUsage: () => ({
      rss: 10,
      heapTotal: 100,
      heapUsed: 45,
      external: 1,
      arrayBuffers: 1,
    }),
    ...overrides,
  };
}

describe('HealthService', () => {
  it('returns degraded when event loop lag crosses degraded threshold', async () => {
    const service = new HealthService(
      'talenttrust-backend',
      [],
      createProviders({
        eventLoopLagMs: () => defaultThresholds.degradedEventLoopLagMs,
      }),
    );

    const report = await service.getReport();

    expect(report.status).toBe('degraded');
    expect(report.signals.eventLoopLagMs).toBe(defaultThresholds.degradedEventLoopLagMs);
  });

  it('returns down when memory usage crosses down threshold', async () => {
    const service = new HealthService(
      'talenttrust-backend',
      [],
      createProviders({
        memoryUsage: () => ({
          rss: 10,
          heapTotal: 100,
          heapUsed: 95,
          external: 1,
          arrayBuffers: 1,
        }),
      }),
    );

    const report = await service.getReport();

    expect(report.status).toBe('down');
    expect(report.signals.heapUsedRatio).toBe(0.95);
  });

  it('marks dependency as down when checker throws and keeps error detail', async () => {
    const failingDependency: DependencyChecker = {
      name: 'database',
      check: async () => {
        throw new Error('dial timeout');
      },
    };

    const service = new HealthService(
      'talenttrust-backend',
      [failingDependency],
      createProviders(),
    );

    const report = await service.getReport();

    expect(report.status).toBe('down');
    expect(report.dependencies).toHaveLength(1);
    expect(report.dependencies[0].name).toBe('database');
    expect(report.dependencies[0].status).toBe('down');
    expect(report.dependencies[0].details).toContain('dial timeout');
  });

  it('closes provider resources on close()', () => {
    const close = jest.fn();
    const service = new HealthService('talenttrust-backend', [], createProviders({ close }));

    service.close();

    expect(close).toHaveBeenCalledTimes(1);
  });

  it('returns down when event loop lag crosses down threshold', async () => {
    const service = new HealthService(
      'talenttrust-backend',
      [],
      createProviders({
        eventLoopLagMs: () => defaultThresholds.downEventLoopLagMs,
      }),
    );

    const report = await service.getReport();

    expect(report.status).toBe('down');
  });

  it('returns degraded when memory usage crosses degraded threshold', async () => {
    const service = new HealthService(
      'talenttrust-backend',
      [],
      createProviders({
        memoryUsage: () => ({
          rss: 10,
          heapTotal: 100,
          heapUsed: 86,
          external: 1,
          arrayBuffers: 1,
        }),
      }),
    );

    const report = await service.getReport();

    expect(report.status).toBe('degraded');
  });

  it('returns up when all signals are healthy', async () => {
    const service = new HealthService('talenttrust-backend', [], createProviders());

    const report = await service.getReport();

    expect(report.status).toBe('up');
  });

  it('marks dependency as up when checker returns healthy', async () => {
    const healthyDependency: DependencyChecker = {
      name: 'database',
      check: async () => ({ status: 'up', details: 'connected' }),
    };

    const service = new HealthService('talenttrust-backend', [healthyDependency], createProviders());

    const report = await service.getReport();

    expect(report.dependencies[0].status).toBe('up');
    expect(report.dependencies[0].details).toBe('connected');
  });

  it('marks dependency as down with generic message on non-Error rejection', async () => {
    const failingDependency: DependencyChecker = {
      name: 'database',
      check: async () => { throw 'timeout'; },
    };

    const service = new HealthService('talenttrust-backend', [failingDependency], createProviders());

    const report = await service.getReport();

    expect(report.dependencies[0].status).toBe('down');
    expect(report.dependencies[0].details).toBe('Dependency check failed');
  });

  it('uses default dependencies and providers when none are supplied', async () => {
    const service = new HealthService('talenttrust-backend');

    const report = await service.getReport();

    expect(report.service).toBe('talenttrust-backend');
    expect(report.status).toBeDefined();
    expect(report.signals.eventLoopLagMs).toBeGreaterThanOrEqual(0);
    expect(report.signals.heapTotalBytes).toBeGreaterThan(0);
    expect(report.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('handles heapTotal of zero', async () => {
    const service = new HealthService(
      'talenttrust-backend',
      [],
      createProviders({
        memoryUsage: () => ({
          rss: 10,
          heapTotal: 0,
          heapUsed: 0,
          external: 0,
          arrayBuffers: 0,
        }),
      }),
    );

    const report = await service.getReport();

    expect(report.signals.heapUsedRatio).toBe(0);
    expect(report.status).toBe('up');
  });

  it('closes default provider resources', () => {
    const service = new HealthService('talenttrust-backend', []);

    service.close();
  });

  it('healthReportToHttpStatus returns 200 for up', () => {
    expect(healthReportToHttpStatus('up')).toBe(200);
  });

  it('healthReportToHttpStatus returns 200 for degraded', () => {
    expect(healthReportToHttpStatus('degraded')).toBe(200);
  });

  it('healthReportToHttpStatus returns 503 for down', () => {
    expect(healthReportToHttpStatus('down')).toBe(503);
  });
});

