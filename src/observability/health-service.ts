import { monitorEventLoopDelay } from 'perf_hooks';

import {
  DependencyChecker,
  DependencyHealth,
  HealthReport,
  ServiceStatus,
} from './types';

const STATUS_ORDER: Record<ServiceStatus, number> = {
  up: 0,
  degraded: 1,
  down: 2,
};

export interface RuntimeSignalProviders {
  now: () => Date;
  uptimeSeconds: () => number;
  eventLoopLagMs: () => number;
  memoryUsage: () => NodeJS.MemoryUsage;
  close?: () => void;
}

export interface HealthServiceLike {
  getReport: () => Promise<HealthReport>;
  close?: () => void;
}

export interface HealthThresholds {
  degradedEventLoopLagMs: number;
  downEventLoopLagMs: number;
  degradedHeapUsedRatio: number;
  downHeapUsedRatio: number;
}

export const defaultThresholds: HealthThresholds = {
  degradedEventLoopLagMs: 250,
  downEventLoopLagMs: 1000,
  degradedHeapUsedRatio: 0.85,
  downHeapUsedRatio: 0.95,
};

/**
 * Computes service-level health from local runtime signals and dependency checks.
 */
export class HealthService implements HealthServiceLike {
  constructor(
    private readonly serviceName: string,
    private readonly dependencyCheckers: DependencyChecker[] = [],
    private readonly providers: RuntimeSignalProviders = createDefaultProviders(),
    private readonly thresholds: HealthThresholds = defaultThresholds,
  ) {}

  async getReport(): Promise<HealthReport> {
    const now = this.providers.now();
    const memory = this.providers.memoryUsage();
    const eventLoopLagMs = this.providers.eventLoopLagMs();
    const heapUsedRatio = memory.heapTotal > 0 ? memory.heapUsed / memory.heapTotal : 0;
    const dependencyResults = await Promise.all(
      this.dependencyCheckers.map((checker) => evaluateDependency(checker, now.toISOString())),
    );

    const signalStatuses: ServiceStatus[] = [
      evaluateEventLoopStatus(eventLoopLagMs, this.thresholds),
      evaluateHeapStatus(heapUsedRatio, this.thresholds),
    ];

    const status = mergeStatuses(
      signalStatuses.concat(dependencyResults.map((dependency) => dependency.status)),
    );

    return {
      service: this.serviceName,
      status,
      timestamp: now.toISOString(),
      uptimeSeconds: this.providers.uptimeSeconds(),
      signals: {
        eventLoopLagMs,
        heapUsedBytes: memory.heapUsed,
        heapTotalBytes: memory.heapTotal,
        heapUsedRatio,
      },
      dependencies: dependencyResults,
    };
  }

  close(): void {
    this.providers.close?.();
  }
}

function createDefaultProviders(): RuntimeSignalProviders {
  const loopLagMonitor = monitorEventLoopDelay({ resolution: 20 });
  loopLagMonitor.enable();

  return {
    now: () => new Date(),
    uptimeSeconds: () => process.uptime(),
    eventLoopLagMs: () => {
      const lagMs = Number(loopLagMonitor.mean) / 1_000_000;
      return Number.isFinite(lagMs) ? lagMs : 0;
    },
    memoryUsage: () => process.memoryUsage(),
    close: () => loopLagMonitor.disable(),
  };
}

async function evaluateDependency(
  checker: DependencyChecker,
  observedAt: string,
): Promise<DependencyHealth> {
  try {
    const result = await checker.check();
    return {
      name: checker.name,
      status: result.status,
      details: result.details,
      observedAt,
    };
  } catch (error) {
    return {
      name: checker.name,
      status: 'down',
      details:
        error instanceof Error
          ? `Dependency check failed: ${error.message}`
          : 'Dependency check failed',
      observedAt,
    };
  }
}

function evaluateEventLoopStatus(
  eventLoopLagMs: number,
  thresholds: HealthThresholds,
): ServiceStatus {
  if (eventLoopLagMs >= thresholds.downEventLoopLagMs) {
    return 'down';
  }

  if (eventLoopLagMs >= thresholds.degradedEventLoopLagMs) {
    return 'degraded';
  }

  return 'up';
}

function evaluateHeapStatus(
  heapUsedRatio: number,
  thresholds: HealthThresholds,
): ServiceStatus {
  if (heapUsedRatio >= thresholds.downHeapUsedRatio) {
    return 'down';
  }

  if (heapUsedRatio >= thresholds.degradedHeapUsedRatio) {
    return 'degraded';
  }

  return 'up';
}

function mergeStatuses(statuses: ServiceStatus[]): ServiceStatus {
  if (statuses.length === 0) {
    return 'up';
  }

  return statuses.reduce((current, next) =>
    STATUS_ORDER[next] > STATUS_ORDER[current] ? next : current,
  );
}

export function healthReportToHttpStatus(status: ServiceStatus): number {
  return status === 'down' ? 503 : 200;
}




