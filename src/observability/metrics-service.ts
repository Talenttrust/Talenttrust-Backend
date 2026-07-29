import { NextFunction, Request, Response } from 'express';
import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
} from 'prom-client';

import { logger } from '../logger';
import { ServiceStatus } from './types';
import {
  assertDlqDepth,
  assertDisputesErrorCause,
  assertServiceStatus,
  assertWebhookOutcome,
  assertContractsRequestMetric,
  assertReputationRequestMetric,
  ContractsErrorCause,
  ContractsRequestMetric,
  ContractsRequestStatus,
  DisputesErrorCause,
  ReputationRequestMetric,
  WebhookOutcome as ValidatedWebhookOutcome,
} from './metrics-validation';
import { DEFAULT_HISTOGRAM_BUCKETS, validateHistogramBuckets } from './observability-config';
import { Logger, logger as rootLogger } from '../logger';

export type {
  ContractsErrorCause,
  ContractsRequestMetric,
  ContractsRequestStatus,
} from './metrics-validation';

/**
 * Re-exported from metrics-validation to preserve existing import paths.
 * The canonical definition lives in metrics-validation.ts where all metric
 * input types are colocated.
 */
export type WebhookOutcome = ValidatedWebhookOutcome;

/**
 * Canonical list of metric family names documented in docs/observability.md.
 * This constant enables round-trip verification: tests assert that the set of
 * metrics registered by MetricsService matches this list exactly.
 *
 * Note: auth_cache_hits_total and auth_cache_misses_total are registered by
 * AuthCache (not MetricsService) and are documented separately.
 */
export const CATALOG_METRIC_NAMES: readonly string[] = [
  'http_requests_total',
  'http_request_duration_seconds',
  'api_keys_requests_total',
  'api_keys_request_duration_seconds',
  'api_keys_errors_total',
  'auth_requests_total',
  'auth_request_duration_seconds',
  'auth_errors_total',
  'reputation_requests_total',
  'reputation_request_duration_seconds',
  'reputation_errors_total',
  'service_health_status',
  'webhook_deliveries_total',
  'webhook_dlq_depth',
  'webhook_rate_limit_tokens',
  'webhook_rate_limit_queue_depth',
  'milestone_operations_total',
  'milestone_operation_duration_seconds',
  'disputes_requests_total',
  'disputes_request_duration_seconds',
  'contracts_requests_total',
  'contracts_request_duration_seconds',
] as const;

export const REPUTATION_OPERATIONS = ['get_profile', 'create_rating'] as const;
export type ReputationOperation = (typeof REPUTATION_OPERATIONS)[number];

export const REPUTATION_STATUSES = ['success', 'client_error', 'server_error'] as const;
export type ReputationRequestStatus = (typeof REPUTATION_STATUSES)[number];

export const REPUTATION_ERROR_CAUSES = [
  'none',
  'bad_request',
  'authentication',
  'authorization',
  'not_found',
  'conflict',
  'validation',
  'rate_limit',
  'client_error',
  'internal_error',
] as const;
export type ReputationErrorCause = (typeof REPUTATION_ERROR_CAUSES)[number];

export interface ReputationRequestMetric {
  operation: ReputationOperation;
  status: ReputationRequestStatus;
  statusCode: number;
  errorCause: ReputationErrorCause;
  durationSeconds: number;
}

/** The type of milestone operation being instrumented. */
export type MilestoneOperation = 'create' | 'update' | 'read';

/**
 * The outcome category of a milestone operation.
 *
 * - success: the operation completed with a 2xx response
 * - client_error: the operation was rejected due to bad input (4xx)
 * - server_error: an unexpected error occurred (5xx)
 */
export type MilestoneOperationStatus = 'success' | 'client_error' | 'server_error';

export interface MetricsServiceLike {
  contentType: string;
  trackHttpRequest: (req: Request, res: Response, next: NextFunction) => void;
  trackApiKeysRequest: (req: Request, res: Response, next: NextFunction) => void;
  trackAuthRequest: (req: Request, res: Response, next: NextFunction) => void;
  getMetrics: () => Promise<string>;
  recordReputationRequest: (metric: ReputationRequestMetric) => void;
  recordHealthStatus: (status: ServiceStatus) => void;
  recordWebhookDelivery: (outcome: WebhookOutcome) => void;
  setWebhookDlqDepth: (depth: number) => void;
  recordDisputesRequest: (input: DisputesRequestMetricInput) => void;
  startRateLimitMetricsSampling?: (limiter: any, intervalMs?: number) => void;
  stopRateLimitMetricsSampling?: () => void;
  recordMilestoneOperation: (
    operation: MilestoneOperation,
    status: MilestoneOperationStatus,
    durationSeconds: number,
    errorCause?: string,
  ) => void;
  recordContractsRequest: (metric: ContractsRequestMetric) => void;
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
  /**
   * Custom histogram bucket boundaries (in seconds) for
   * `http_request_duration_seconds`. Must be a non-empty array of strictly
   * increasing positive numbers. Falls back to {@link DEFAULT_HISTOGRAM_BUCKETS}
   * when absent or invalid.
   */
  histogramBuckets?: number[];
}

/**
 * Manages Prometheus metrics registration and request instrumentation.
 */
export class MetricsService implements MetricsServiceLike {
  readonly contentType: string;

  private readonly register: Registry;

  private readonly httpRequestsTotal: Counter;

  private readonly httpRequestDurationSeconds: Histogram;

  private readonly reputationRequestsTotal: Counter;

  private readonly reputationRequestDurationSeconds: Histogram;

  private readonly reputationErrorsTotal: Counter;

  private readonly apiKeysRequestsTotal: Counter;

  private readonly apiKeysRequestDurationSeconds: Histogram;

  private readonly apiKeysErrorsTotal: Counter;

  private readonly authRequestsTotal: Counter;

  private readonly authRequestDurationSeconds: Histogram;

  private readonly authErrorsTotal: Counter;

  private readonly serviceHealthStatus: Gauge;

  private readonly webhookDeliveriesTotal: Counter;

  private readonly webhookDlqDepth: Gauge;

  private readonly webhookRateLimitTokens: Gauge;

  private readonly webhookRateLimitQueueDepth: Gauge;

  private readonly milestoneOperationsTotal: Counter;

  private readonly milestoneOperationDurationSeconds: Histogram;

  private readonly disputesRequestsTotal: Counter;

  private readonly disputesRequestDurationSeconds: Histogram;

  private readonly contractsRequestsTotal: Counter;

  private readonly contractsRequestDurationSeconds: Histogram;

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

    // Resolve histogram buckets: validate caller-supplied values and fall back
    // to defaults when absent or invalid, so misconfiguration is non-fatal.
    const resolvedBuckets = resolveHistogramBuckets(options.histogramBuckets);

    collectDefaultMetrics({
      register: this.register,
      prefix: `${sanitizeMetricPrefix(serviceName)}_`,
    });

    this.httpRequestsTotal = new Counter({
      name: 'http_requests_total',
      help: 'Total number of HTTP requests.',
      labelNames: ['method', 'route', 'status_code', 'error_cause'],
      registers: [this.register],
    });

    this.httpRequestDurationSeconds = new Histogram({
      name: 'http_request_duration_seconds',
      help: 'Duration of HTTP requests in seconds.',
      labelNames: ['method', 'route', 'status_code', 'error_cause'],
      buckets: resolvedBuckets,
      registers: [this.register],
    });

    this.reputationRequestsTotal = new Counter({
      name: 'reputation_requests_total',
      help: 'Total reputation endpoint requests by operation, status, and error cause.',
      labelNames: ['operation', 'status', 'status_code', 'error_cause'],
      registers: [this.register],
    });

    this.reputationRequestDurationSeconds = new Histogram({
      name: 'reputation_request_duration_seconds',
      help: 'Duration of reputation endpoint requests in seconds.',
      labelNames: ['operation', 'status', 'status_code', 'error_cause'],
      buckets: resolvedBuckets,
      registers: [this.register],
    });

    this.reputationErrorsTotal = new Counter({
      name: 'reputation_errors_total',
      help: 'Total reputation endpoint errors by operation and error cause.',
      labelNames: ['operation', 'error_cause'],
      registers: [this.register],
    });

    this.apiKeysRequestsTotal = new Counter({
      name: 'api_keys_requests_total',
      help: 'Total number of API key management requests.',
      labelNames: ['operation', 'status_code'],
      registers: [this.register],
    });

    this.apiKeysRequestDurationSeconds = new Histogram({
      name: 'api_keys_request_duration_seconds',
      help: 'Duration of API key management requests in seconds.',
      labelNames: ['operation', 'status_code'],
      buckets: resolvedBuckets,
      registers: [this.register],
    });

    this.apiKeysErrorsTotal = new Counter({
      name: 'api_keys_errors_total',
      help: 'Total number of API key management request errors by cause.',
      labelNames: ['operation', 'cause'],
      registers: [this.register],
    });

    this.authRequestsTotal = new Counter({
      name: 'auth_requests_total',
      help: 'Total number of authentication requests.',
      labelNames: ['operation', 'status_code'],
      registers: [this.register],
    });

    this.authRequestDurationSeconds = new Histogram({
      name: 'auth_request_duration_seconds',
      help: 'Duration of authentication requests in seconds.',
      labelNames: ['operation', 'status_code'],
      buckets: resolvedBuckets,
      registers: [this.register],
    });

    this.authErrorsTotal = new Counter({
      name: 'auth_errors_total',
      help: 'Total number of authentication request errors by cause.',
      labelNames: ['operation', 'cause'],
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

    this.milestoneOperationsTotal = new Counter({
      name: 'milestone_operations_total',
      help: 'Total number of milestone operations by type, status, and error cause.',
      labelNames: ['operation', 'status', 'error_cause'],
      registers: [this.register],
    });

    this.milestoneOperationDurationSeconds = new Histogram({
      name: 'milestone_operation_duration_seconds',
      help: 'Duration of milestone operations in seconds, labelled by operation type and status.',
      labelNames: ['operation', 'status'],
      buckets: resolvedBuckets,
      registers: [this.register],
    });

    this.disputesRequestsTotal = new Counter({
      name: 'disputes_requests_total',
      help: 'Total number of disputes endpoint requests.',
      labelNames: ['method', 'route', 'status_code', 'error_cause'],
      registers: [this.register],
    });

    this.disputesRequestDurationSeconds = new Histogram({
      name: 'disputes_request_duration_seconds',
      help: 'Duration of disputes endpoint requests in seconds.',
      labelNames: ['method', 'route', 'status_code', 'error_cause'],
      buckets: resolvedBuckets,
      registers: [this.register],
    });

    this.contractsRequestsTotal = new Counter({
      name: 'contracts_requests_total',
      help: 'Total number of contracts requests by method, route, status, status_code, and error_cause.',
      labelNames: ['method', 'route', 'status', 'status_code', 'error_cause'],
      registers: [this.register],
    });

    this.contractsRequestDurationSeconds = new Histogram({
      name: 'contracts_request_duration_seconds',
      help: 'Duration of contracts requests in seconds.',
      labelNames: ['method', 'route', 'status', 'status_code', 'error_cause'],
      buckets: resolvedBuckets,
      registers: [this.register],
    });
  }

  trackHttpRequest(req: Request, res: Response, next: NextFunction): void {
    const start = process.hrtime.bigint();

    res.on('finish', () => {
      const durationNs = process.hrtime.bigint() - start;
      const duration = Number(durationNs) / 1_000_000_000;
      const durationMs = Number(durationNs) / 1_000_000;
      const route = this.boundRouteLabel(extractRoute(req));
      const errorCause = resolveErrorCause(res);
      const labels = {
        method: req.method,
        route,
        status_code: String(res.statusCode),
        error_cause: errorCause,
      };

      this.httpRequestsTotal.inc(labels);
      this.httpRequestDurationSeconds.observe(labels, duration);

      const locals = res.locals ?? {};
      const requestId = typeof locals.requestId === 'string' ? locals.requestId : undefined;
      const correlationId =
        typeof locals.correlationId === 'string' ? locals.correlationId : undefined;

      logger.info('http request metric', {
        metric: 'http_request',
        method: req.method,
        route,
        statusCode: res.statusCode,
        errorCause,
        durationMs: parseFloat(durationMs.toFixed(3)),
        ...(requestId !== undefined && { requestId }),
        ...(correlationId !== undefined && { correlationId }),
      });
    });

    next();
  }

  trackApiKeysRequest(req: Request, res: Response, next: NextFunction): void {
    const start = process.hrtime.bigint();

    res.on('finish', () => {
      const durationSeconds = Number(process.hrtime.bigint() - start) / 1_000_000_000;
      const statusCode = res.statusCode;
      const operation = apiKeysOperation(req.method, req.route?.path);
      const labels = { operation, status_code: String(statusCode) };
      const errorCause = apiKeysErrorCause(statusCode);

      this.apiKeysRequestsTotal.inc(labels);
      this.apiKeysRequestDurationSeconds.observe(labels, durationSeconds);
      if (errorCause !== null) {
        this.apiKeysErrorsTotal.inc({ operation, cause: errorCause });
      }

      const log = (res.locals['log'] as Logger | undefined) ?? rootLogger;
      const logFields = {
        method: req.method,
        route: apiKeysRouteTemplate(req.route?.path),
        operation,
        statusCode,
        durationMs: Number((durationSeconds * 1000).toFixed(3)),
        outcome: statusCode < 400 ? 'success' : 'error',
        ...(errorCause !== null && { errorCause }),
      };

      if (statusCode >= 500) {
        log.error('api_keys_request', logFields);
      } else if (statusCode >= 400) {
        log.warn('api_keys_request', logFields);
      } else {
        log.info('api_keys_request', logFields);
      }
    });

    next();
  }

  trackAuthRequest(req: Request, res: Response, next: NextFunction): void {
    const start = process.hrtime.bigint();

    res.on('finish', () => {
      const durationSeconds = Number(process.hrtime.bigint() - start) / 1_000_000_000;
      const statusCode = res.statusCode;
      const operation = authOperation(req.method, req.route?.path);
      const labels = { operation, status_code: String(statusCode) };
      const errorCause = authErrorCause(statusCode, res);

      this.authRequestsTotal.inc(labels);
      this.authRequestDurationSeconds.observe(labels, durationSeconds);
      if (errorCause !== null) {
        this.authErrorsTotal.inc({ operation, cause: errorCause });
      }

      const log = (res.locals['log'] as Logger | undefined) ?? rootLogger;
      const logFields = {
        method: req.method,
        route: authRouteTemplate(req.route?.path),
        operation,
        statusCode,
        durationMs: Number((durationSeconds * 1000).toFixed(3)),
        outcome: statusCode < 400 ? 'success' : 'error',
        ...(errorCause !== null && { errorCause }),
      };

      if (statusCode >= 500) {
        log.error('auth_request', logFields);
      } else if (statusCode >= 400) {
        log.warn('auth_request', logFields);
      } else {
        log.info('auth_request', logFields);
      }
    });

    next();
  }

  recordHealthStatus(status: ServiceStatus): void {
    // Runtime guard: reject unknown status strings that bypass TypeScript types
    // (e.g. from JSON-deserialized or cross-process call sites).
    const validated = assertServiceStatus(status);
    this.serviceHealthStatus.set(
      { service: this.serviceName },
      HEALTH_STATUS_VALUE[validated],
    );
  }

  recordWebhookDelivery(outcome: WebhookOutcome): void {
    // Runtime guard: reject unknown outcome strings.
    const validated = assertWebhookOutcome(outcome);
    this.webhookDeliveriesTotal.inc({ outcome: validated });
  }

  setWebhookDlqDepth(depth: number): void {
    // Runtime guard: reject NaN, ±Infinity, negative values, and unreasonably
    // large values that would indicate a bug or injection attempt.
    const validated = assertDlqDepth(depth);
    this.webhookDlqDepth.set(validated);
  }

  /**
   * Record a disputes API request observation (counter + duration histogram).
   * Labels are bounded: route must be an Express template, error_cause a finite enum.
   */
  recordDisputesRequest(input: DisputesRequestMetricInput): void {
    const errorCause = assertDisputesErrorCause(input.errorCause);
    const duration =
      Number.isFinite(input.durationSeconds) && input.durationSeconds >= 0
        ? input.durationSeconds
        : 0;
    const labels = {
      method: input.method,
      route: this.boundRouteLabel(input.route || UNMATCHED_ROUTE_LABEL),
      status_code: String(input.statusCode),
      error_cause: errorCause,
    };

    this.disputesRequestsTotal.inc(labels);
    this.disputesRequestDurationSeconds.observe(labels, duration);
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

  /**
   * Record a completed milestone operation.
   *
   * @param operation - The type of operation: create, update, or read.
   * @param status    - Outcome category: success, client_error, or server_error.
   * @param durationSeconds - Wall-clock time in seconds.
   * @param errorCause - Optional machine-readable cause label (e.g. "not_found",
   *   "contract_bounds_error") for failed operations.  Defaults to the empty
   *   string for success outcomes.  Never include PII.
   */
  recordMilestoneOperation(
    operation: MilestoneOperation,
    status: MilestoneOperationStatus,
    durationSeconds: number,
    errorCause: string = '',
  ): void {
    this.milestoneOperationsTotal.inc({ operation, status, error_cause: errorCause });
    this.milestoneOperationDurationSeconds.observe({ operation, status }, durationSeconds);
  }

  recordContractsRequest(metric: ContractsRequestMetric): void {
    const validated = assertContractsRequestMetric(metric);
    const labels = {
      method: validated.method,
      route: this.boundRouteLabel(validated.route),
      status: validated.status,
      status_code: String(validated.statusCode),
      error_cause: validated.errorCause,
    };

    this.contractsRequestsTotal.inc(labels);
    this.contractsRequestDurationSeconds.observe(labels, validated.durationSeconds);
  }

  getMetrics(): Promise<string> {
    return this.register.metrics();
  }

  recordReputationRequest(metric: ReputationRequestMetric): void {
    assertReputationRequestMetric(metric);

    const labels = {
      operation: metric.operation,
      status: metric.status,
      status_code: String(metric.statusCode),
      error_cause: metric.errorCause,
    };

    this.reputationRequestsTotal.inc(labels);
    this.reputationRequestDurationSeconds.observe(labels, metric.durationSeconds);

    if (metric.errorCause !== 'none') {
      this.reputationErrorsTotal.inc({
        operation: metric.operation,
        error_cause: metric.errorCause,
      });
    }
  }

  private boundRouteLabel(route: string): string {
    // Never collapse unmatched routes — they are not user-controlled and must
    // always be tracked separately so operators can monitor 404 rates.
    if (route === UNMATCHED_ROUTE_LABEL) {
      return route;
    }

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

type ApiKeysErrorCause =
  | 'validation_error'
  | 'authentication_error'
  | 'authorization_error'
  | 'not_found'
  | 'client_error'
  | 'server_error';

function apiKeysErrorCause(statusCode: number): ApiKeysErrorCause | null {
  if (statusCode < 400) return null;
  if (statusCode === 400 || statusCode === 422) return 'validation_error';
  if (statusCode === 401) return 'authentication_error';
  if (statusCode === 403) return 'authorization_error';
  if (statusCode === 404) return 'not_found';
  if (statusCode < 500) return 'client_error';
  return 'server_error';
}

function apiKeysOperation(method: string, routePath: unknown): string {
  const route = typeof routePath === 'string' ? routePath : '';
  if (method === 'POST' && route === '/api-keys') return 'create';
  if (method === 'GET' && route === '/api-keys') return 'list';
  if (method === 'GET' && route === '/api-keys/:id') return 'get';
  if (method === 'POST' && route === '/api-keys/:id/rotate') return 'rotate';
  if (method === 'DELETE' && route === '/api-keys/:id') return 'deactivate';
  return 'unknown';
}

function apiKeysRouteTemplate(routePath: unknown): string {
  return typeof routePath === 'string' ? `/api/v1${routePath}` : '/api/v1/api-keys';
}

type AuthErrorCause =
  | 'validation_error'
  | 'invalid_credentials'
  | 'invalid_token'
  | 'conflict'
  | 'rate_limit'
  | 'client_error'
  | 'server_error';

function authErrorCause(statusCode: number, res: Response): AuthErrorCause | null {
  if (statusCode < 400) return null;

  const explicit = res.locals?.['errorCause'];
  if (explicit === 'validation_error') return 'validation_error';
  if (explicit === 'invalid_credentials') return 'invalid_credentials';
  if (explicit === 'invalid_refresh_token' || explicit === 'unauthorized') return 'invalid_token';
  if (explicit === 'conflict') return 'conflict';

  if (statusCode === 400 || statusCode === 422) return 'validation_error';
  if (statusCode === 401 || statusCode === 403) return 'invalid_token';
  if (statusCode === 409) return 'conflict';
  if (statusCode === 429) return 'rate_limit';
  if (statusCode < 500) return 'client_error';
  return 'server_error';
}

function authOperation(method: string, routePath: unknown): string {
  const route = typeof routePath === 'string' ? routePath : '';
  if (method !== 'POST') return 'unknown';
  if (route === '/login') return 'login';
  if (route === '/register') return 'register';
  if (route === '/refresh') return 'refresh';
  if (route === '/logout') return 'logout';
  return 'unknown';
}

function authRouteTemplate(routePath: unknown): string {
  const route = typeof routePath === 'string' ? routePath : '';
  return ['/login', '/register', '/refresh', '/logout'].includes(route)
    ? `/api/v1/auth${route}`
    : '/api/v1/auth';
}

/**
 * Validate the caller-supplied bucket array and return it if valid.
 * Falls back to {@link DEFAULT_HISTOGRAM_BUCKETS} when the input is absent or
 * fails validation, ensuring that misconfiguration is non-fatal and existing
 * dashboards keep working.
 */
function resolveHistogramBuckets(buckets: number[] | undefined): number[] {
  if (buckets === undefined) {
    return [...DEFAULT_HISTOGRAM_BUCKETS];
  }

  const result = validateHistogramBuckets(buckets);
  if (!result.valid) {
    console.warn(
      `[MetricsService] Invalid histogramBuckets option (${(result as any).reason}); falling back to defaults.`,
    );
    return [...DEFAULT_HISTOGRAM_BUCKETS];
  }

  return result.buckets;
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

function resolveErrorCause(res: Response): string {
  const locals = res.locals ?? {};
  const explicit = locals['errorCause'];
  if (typeof explicit === 'string' && explicit.length > 0) {
    return explicit;
  }

  const code = res.statusCode;
  if (code < 400) {
    return 'none';
  }
  if (code < 500) {
    return 'client_error';
  }
  return 'server_error';
}

function assertReputationRequestMetric(metric: ReputationRequestMetric): void {
  if (!REPUTATION_OPERATIONS.includes(metric.operation)) {
    throw new Error('Invalid reputation operation');
  }

  if (!REPUTATION_STATUSES.includes(metric.status)) {
    throw new Error('Invalid reputation request status');
  }

  if (!REPUTATION_ERROR_CAUSES.includes(metric.errorCause)) {
    throw new Error('Invalid reputation error cause');
  }

  if (!Number.isInteger(metric.statusCode) || metric.statusCode < 100 || metric.statusCode > 599) {
    throw new Error('Invalid reputation status code');
  }

  if (!Number.isFinite(metric.durationSeconds) || metric.durationSeconds < 0) {
    throw new Error('Invalid reputation request duration');
  }
}


