import { NextFunction, Request, Response } from 'express';
import { Logger, logger as rootLogger } from '../logger';
import {
  ContractsErrorCause,
  ContractsRequestMetric,
  ContractsRequestStatus,
  MetricsServiceLike,
} from './metrics-service';

export interface ContractsObservabilityOptions {
  metricsService?: Pick<MetricsServiceLike, 'recordContractsRequest'>;
  log?: Pick<Logger, 'info' | 'warn' | 'error'>;
}

export interface ContractsResponseClassification {
  status: ContractsRequestStatus;
  errorCause: ContractsErrorCause;
}

/**
 * Creates observability middleware for contracts routes.
 * Emits request duration, status, and error-cause metrics plus structured logs (without PII).
 */
export function createContractsObservabilityMiddleware(
  options: ContractsObservabilityOptions = {},
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const start = process.hrtime.bigint();

    res.once('finish', () => {
      const durationSeconds = Number(process.hrtime.bigint() - start) / 1_000_000_000;
      const classification = classifyContractsResponse(res.statusCode);
      const route = extractContractsRoute(req);

      const metric: ContractsRequestMetric = {
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

      if (options.metricsService?.recordContractsRequest) {
        try {
          options.metricsService.recordContractsRequest(metric);
        } catch {
          log.error('contracts_metrics_recording_failed', {
            method: req.method,
            route,
            statusCode: res.statusCode,
          });
        }
      }

      if (classification.status === 'server_error') {
        log.error('contracts_request', logFields);
      } else if (classification.status === 'client_error') {
        log.warn('contracts_request', logFields);
      } else {
        log.info('contracts_request', logFields);
      }
    });

    next();
  };
}

/**
 * Maps HTTP status code to bounded status and errorCause labels.
 */
export function classifyContractsResponse(
  statusCode: number,
): ContractsResponseClassification {
  if (statusCode >= 500) {
    return { status: 'server_error', errorCause: 'internal_error' };
  }

  if (statusCode < 400) {
    return { status: 'success', errorCause: 'none' };
  }

  const causeByStatus: Record<number, ContractsErrorCause> = {
    400: 'bad_request',
    401: 'authentication',
    403: 'authorization',
    404: 'not_found',
    409: 'conflict',
    422: 'contract_bounds_error',
    429: 'rate_limit',
  };

  return {
    status: 'client_error',
    errorCause: causeByStatus[statusCode] ?? 'client_error',
  };
}

function extractContractsRoute(req: Request): string {
  if (req.route?.path) {
    const routePath = String(req.route.path);
    if (routePath.startsWith('/api/v1/contracts')) {
      return routePath;
    }
    const baseUrl = req.baseUrl || '/api/v1/contracts';
    return routePath === '/' ? baseUrl : `${baseUrl}${routePath.startsWith('/') ? routePath : '/' + routePath}`;
  }
  return req.baseUrl || req.path || '/api/v1/contracts';
}

function resolveLogger(
  res: Response,
  fallback?: Pick<Logger, 'info' | 'warn' | 'error'>,
): Pick<Logger, 'info' | 'warn' | 'error'> {
  const requestLogger = res.locals?.['log'] as Pick<Logger, 'info' | 'warn' | 'error'> | undefined;
  return requestLogger ?? fallback ?? rootLogger;
}
