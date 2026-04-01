import { NextFunction, Request, Response } from 'express';
import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
} from 'prom-client';

import { ServiceStatus } from './types';

export interface MetricsServiceLike {
  contentType: string;
  trackHttpRequest: (req: Request, res: Response, next: NextFunction) => void;
  getMetrics: () => Promise<string>;
  recordHealthStatus: (status: ServiceStatus) => void;
}

const HEALTH_STATUS_VALUE: Record<ServiceStatus, number> = {
  up: 2,
  degraded: 1,
  down: 0,
};

/**
 * Manages Prometheus metrics registration and request instrumentation.
 */
export class MetricsService implements MetricsServiceLike {
  readonly contentType: string;

  private readonly register: Registry;

  private readonly httpRequestsTotal: Counter;

  private readonly httpRequestDurationSeconds: Histogram;

  private readonly serviceHealthStatus: Gauge;

  constructor(private readonly serviceName: string, register?: Registry) {
    this.register = register ?? new Registry();
    collectDefaultMetrics({
      register: this.register,
      prefix: `${sanitizeMetricPrefix(serviceName)}_`,
    });

    this.httpRequestsTotal = new Counter({
      name: 'http_requests_total',
      help: 'Total number of HTTP requests.',
      labelNames: ['method', 'route', 'status_code'],
      registers: [this.register],
    });

    this.httpRequestDurationSeconds = new Histogram({
      name: 'http_request_duration_seconds',
      help: 'Duration of HTTP requests in seconds.',
      labelNames: ['method', 'route', 'status_code'],
      buckets: [0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [this.register],
    });

    this.serviceHealthStatus = new Gauge({
      name: 'service_health_status',
      help: 'Current service health status. up=2, degraded=1, down=0.',
      labelNames: ['service'],
      registers: [this.register],
    });

    this.serviceHealthStatus.set({ service: this.serviceName }, HEALTH_STATUS_VALUE.up);
    this.contentType = this.register.contentType;
  }

  trackHttpRequest(req: Request, res: Response, next: NextFunction): void {
    const start = process.hrtime.bigint();

    res.on('finish', () => {
      const duration = Number(process.hrtime.bigint() - start) / 1_000_000_000;
      const route = extractRoute(req);
      const labels = {
        method: req.method,
        route,
        status_code: String(res.statusCode),
      };

      this.httpRequestsTotal.inc(labels);
      this.httpRequestDurationSeconds.observe(labels, duration);
    });

    next();
  }

  recordHealthStatus(status: ServiceStatus): void {
    this.serviceHealthStatus.set(
      { service: this.serviceName },
      HEALTH_STATUS_VALUE[status],
    );
  }

  getMetrics(): Promise<string> {
    return this.register.metrics();
  }
}

function sanitizeMetricPrefix(input: string): string {
  const sanitized = input.replace(/[^a-zA-Z0-9_:]/g, '_');
  return sanitized.length > 0 ? sanitized : 'service';
}

function extractRoute(req: Request): string {
  if (req.route?.path) {
    return String(req.route.path);
  }

  return 'unmatched';
}


