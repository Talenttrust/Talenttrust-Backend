import { NextFunction, Request, Response } from 'express';
import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
} from 'prom-client';

import { ServiceStatus } from './types';

export type WebhookOutcome = 'success' | 'failure' | 'dlq';

/**
 * Canonical list of metric family names documented in docs/observability.md.
 * This constant enables round-trip verification: tests assert that the set of
 * metrics registered by MetricsService matches this list exactly.
 */
export const CATALOG_METRIC_NAMES: readonly string[] = [
  'http_requests_total',
  'http_request_duration_seconds',
  'service_health_status',
  'webhook_deliveries_total',
  'webhook_dlq_depth',
  'webhook_rate_limit_tokens',
  'webhook_rate_limit_queue_depth',
] as const;

export interface MetricsServiceLike {
  contentType: string;
  trackHttpRequest: (req: Request, res: Response, next: NextFunction) => void;
  getMetrics: () => Promise<string>;
  recordHealthStatus: (status: ServiceStatus) => void;
  recordWebhookDelivery: (outcome: WebhookOutcome) => void;
  setWebhookDlqDepth: (depth: number) => void;
  startRateLimitMetricsSampling?: (limiter: any, intervalMs?: number) => void;
  stopRateLimitMetricsSampling?: () => void;
}

const HEALTH_STATUS_VALUE: Record<ServiceStatus, number> = {
  up: 2,
  degraded: 1,
  down: 0,
};

const DEFAULT_HTTP_ROUTE_LABEL_LIMIT = 100;
const OTHER_ROUTE_LABEL = 'other';
const UNMATCHED_ROUTE_LABEL = 'unmatched';

export interface MetricsServiceOptions {
  httpRouteLabelLimit?: number;
}

/**
 * Manages Prometheus metrics registration and request instrumentation.
 */
export class MetricsService implements MetricsServiceLike {
  readonly contentType: string;

  private readonly register: Registry;

  private readonly httpRequestsTotal: Counter;

  private readonly httpRequestDurationSeconds: Histogram;

  private readonly serviceHealthStatus: Gauge;

  private readonly webhookDeliveriesTotal: Counter;

  private readonly webhookDlqDepth: Gauge;

  private readonly webhookRateLimitTokens: Gauge;

  private readonly webhookRateLimitQueueDepth: Gauge;

  private readonly httpRouteLabelLimit: number;

  private readonly observedHttpRouteLabels = new Set<string>();

  private rateLimitStopSampling: (() => void) | null = null;

  constructor(
    private readonly serviceName: string,
    register?: Registry,
    options: MetricsServiceOptions = {},
  ) {
    this.register = register ?? new Registry();
    this.httpRouteLabelLimit = options.httpRouteLabelLimit ?? DEFAULT_HTTP_ROUTE_LABEL_LIMIT;
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

    this.webhookDeliveriesTotal = new Counter({
      name: 'webhook_deliveries_total',
      help: 'Total webhook delivery attempts by outcome.',
      labelNames: ['outcome'],
      registers: [this.register],
    });

    this.webhookDlqDepth = new Gauge({
      name: 'webhook_dlq_depth',
      help: 'Current number of entries in the webhook dead-letter queue.',
      registers: [this.register],
    });

    this.webhookRateLimitTokens = new Gauge({
      name: 'webhook_rate_limit_tokens',
      help: 'Current token count per provider in the rate-limiter bucket.',
      labelNames: ['provider_id'],
      registers: [this.register],
    });

    this.webhookRateLimitQueueDepth = new Gauge({
      name: 'webhook_rate_limit_queue_depth',
      help: 'Current queue depth (number of waiting deliveries) per provider in the rate-limiter.',
      labelNames: ['provider_id'],
      registers: [this.register],
    });
  }

  trackHttpRequest(req: Request, res: Response, next: NextFunction): void {
    const start = process.hrtime.bigint();

    res.on('finish', () => {
      const duration = Number(process.hrtime.bigint() - start) / 1_000_000_000;
      const route = this.boundRouteLabel(extractRoute(req));
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

  recordWebhookDelivery(outcome: WebhookOutcome): void {
    this.webhookDeliveriesTotal.inc({ outcome });
  }

  setWebhookDlqDepth(depth: number): void {
    this.webhookDlqDepth.set(depth);
  }

  startRateLimitMetricsSampling(limiter: any, intervalMs: number = 10000): void {
    if (this.rateLimitStopSampling !== null) {
      console.warn('[MetricsService] Rate limit metrics sampling already active.');
      return;
    }

    this.rateLimitStopSampling = limiter.startMetricsSampling(
      this.webhookRateLimitTokens,
      this.webhookRateLimitQueueDepth,
      intervalMs,
    );
  }

  stopRateLimitMetricsSampling(): void {
    if (this.rateLimitStopSampling !== null) {
      this.rateLimitStopSampling();
      this.rateLimitStopSampling = null;
    }
  }

  getMetrics(): Promise<string> {
    return this.register.metrics();
  }

  private boundRouteLabel(route: string): string {
    if (this.observedHttpRouteLabels.has(route)) {
      return route;
    }

    if (this.observedHttpRouteLabels.size < this.httpRouteLabelLimit) {
      this.observedHttpRouteLabels.add(route);
      return route;
    }

    return OTHER_ROUTE_LABEL;
  }
}

function sanitizeMetricPrefix(input: string): string {
  const sanitized = input.replace(/[^a-zA-Z0-9_:]/g, '_');
  return sanitized.length > 0 ? sanitized : 'service';
}

/**
 * Returns a bounded, non-user-controlled route label for HTTP metrics.
 *
 * Express exposes the matched route template at `req.route.path`; joining it
 * with the static mount point in `req.baseUrl` preserves useful labels such as
 * `/api/v1/contracts/:id` without using concrete request paths that may contain
 * attacker-controlled identifiers. Requests that never match a route collapse
 * into one shared bucket.
 */
function extractRoute(req: Request): string {
  const routePath = formatExpressPath(req.route?.path);
  if (routePath === null) {
    return UNMATCHED_ROUTE_LABEL;
  }

  const baseUrl = normalizeRoutePart(req.baseUrl);
  const route = joinRouteParts(baseUrl, routePath);
  return route.length > 0 ? route : '/';
}

function formatExpressPath(path: unknown): string | null {
  if (typeof path === 'string') {
    return normalizeRoutePart(path);
  }

  if (path instanceof RegExp) {
    return path.toString();
  }

  if (Array.isArray(path)) {
    const parts = path.map(formatExpressPath).filter((part): part is string => part !== null);
    return parts.length > 0 ? parts.join('|') : null;
  }

  return null;
}

function normalizeRoutePart(part: string | undefined): string {
  if (!part || part === '/') {
    return '';
  }

  return part.startsWith('/') ? part : `/${part}`;
}

function joinRouteParts(baseUrl: string, routePath: string): string {
  if (!baseUrl) {
    return routePath;
  }

  if (!routePath) {
    return baseUrl;
  }

  return `${baseUrl}${routePath}`;
}


