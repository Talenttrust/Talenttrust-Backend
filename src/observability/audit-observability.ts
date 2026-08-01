import { NextFunction, Request, Response } from 'express';
import { Logger, logger as rootLogger } from '../logger';
import {
  AuditErrorCause,
  AuditRequestMetric,
  AuditRequestStatus,
  MetricsServiceLike,
} from './metrics-service';
import { getMetricsService } from './registry';

export interface AuditObservabilityOptions {
  metricsService?: Pick<MetricsServiceLike, 'recordAuditRequest'>;
  log?: Pick<Logger, 'info' | 'warn' | 'error'>;
}

export interface AuditResponseClassification {
  status: AuditRequestStatus;
  errorCause: AuditErrorCause;
}

/**
 * Creates observability middleware for audit routes.
 * Emits request duration, status, and error-cause metrics plus structured logs (without PII).
 */
export function createAuditObservabilityMiddleware(
  options: AuditObservabilityOptions = {},
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const start = process.hrtime.bigint();

    res.once('finish', () => {
      const durationSeconds = Number(process.hrtime.bigint() - start) / 1_000_000_000;
      const classification = classifyAuditResponse(res.statusCode);
      const route = extractAuditRoute(req);

      const metric: AuditRequestMetric = {
        method: req.method,
        route,
        status: classification.status,
        statusCode: res.statusCode,
        errorCause: classification.errorCause,
        durationSeconds,
      };

      const log = resolveLogger(res, options.log);
      const locals = res.locals ?? {};
      const requestId = typeof locals.requestId === 'string' ? locals.requestId : undefined;
      const correlationId =
        typeof locals.correlationId === 'string' ? locals.correlationId : undefined;

      const logFields = {
        method: req.method,
        route,
        status: classification.status,
        statusCode: res.statusCode,
        errorCause: classification.errorCause,
        durationMs: Number((durationSeconds * 1000).toFixed(3)),
        ...(requestId !== undefined && { requestId }),
        ...(correlationId !== undefined && { correlationId }),
      };

      const ms = options.metricsService ?? getMetricsService();
      if (ms?.recordAuditRequest) {
        try {
          ms.recordAuditRequest(metric);
        } catch {
          log.error('audit_metrics_recording_failed', {
            method: req.method,
            route,
            statusCode: res.statusCode,
          });
        }
      }

      if (classification.status === 'server_error') {
        log.error('audit_request', logFields);
      } else if (classification.status === 'client_error') {
        log.warn('audit_request', logFields);
      } else {
        log.info('audit_request', logFields);
      }
    });

    next();
  };
}

/**
 * Maps HTTP status code to bounded status and errorCause labels.
 */
export function classifyAuditResponse(
  statusCode: number,
): AuditResponseClassification {
  if (statusCode >= 500) {
    return { status: 'server_error', errorCause: 'internal_error' };
  }

  if (statusCode < 400) {
    return { status: 'success', errorCause: 'none' };
  }

  const causeByStatus: Record<number, AuditErrorCause> = {
    400: 'bad_request',
    401: 'authentication',
    403: 'authorization',
    404: 'not_found',
    409: 'conflict',
    422: 'validation',
    429: 'rate_limit',
  };

  return {
    status: 'client_error',
    errorCause: causeByStatus[statusCode] ?? 'client_error',
  };
}

function extractAuditRoute(req: Request): string {
  if (req.route?.path) {
    const routePath = String(req.route.path);
    if (routePath.startsWith('/api/v1/audit')) {
      return routePath;
    }
    const baseUrl = req.baseUrl || '/api/v1/audit';
    return routePath === '/' ? baseUrl : `${baseUrl}${routePath.startsWith('/') ? routePath : '/' + routePath}`;
  }
  return req.baseUrl || req.path || '/api/v1/audit';
}

function resolveLogger(
  res: Response,
  fallback?: Pick<Logger, 'info' | 'warn' | 'error'>,
): Pick<Logger, 'info' | 'warn' | 'error'> {
  const requestLogger = res.locals?.['log'] as Pick<Logger, 'info' | 'warn' | 'error'> | undefined;
  return requestLogger ?? fallback ?? rootLogger;
}
