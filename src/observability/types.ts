/**
 * Health states from best to worst.
 */
export type ServiceStatus = 'up' | 'degraded' | 'down';

export interface HealthSignals {
  eventLoopLagMs: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  heapUsedRatio: number;
}

export interface DependencyHealth {
  name: string;
  status: ServiceStatus;
  observedAt: string;
  details?: string;
}

export interface HealthReport {
  service: string;
  status: ServiceStatus;
  timestamp: string;
  uptimeSeconds: number;
  signals: HealthSignals;
  dependencies: DependencyHealth[];
}

export interface DependencyCheckResult {
  status: ServiceStatus;
  details?: string;
}

export interface DependencyChecker {
  name: string;
  check: () => Promise<DependencyCheckResult>;
}

