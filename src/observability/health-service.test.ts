import {
  defaultThresholds,
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
});

