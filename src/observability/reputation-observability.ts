import { NextFunction, Request, Response } from 'express';
import { Logger, logger as rootLogger } from '../logger';
import {
  MetricsServiceLike,
  ReputationErrorCause,
  ReputationOperation,
  ReputationRequestMetric,
  ReputationRequestStatus,
} from './metrics-service';

export interface ReputationObservabilityOptions {
  metricsService?: Pick<MetricsServiceLike, 'recordReputationRequest'>;
  log?: Pick<Logger, 'info' | 'warn' | 'error'>;
}

export interface ReputationResponseClassification {
  status: ReputationRequestStatus;
  errorCause: ReputationErrorCause;
}

const OPERATION_BY_METHOD: Partial<Record<string, ReputationOperation>> = {
  GET: 'get_profile',
  PUT: 'create_rating',
};

/**
 * Instruments reputation requests without using request-controlled values as
 * metric labels or log fields. Authentication and validation are intentionally
 * observed because the middleware runs before the router's auth guard.
 */
export function createReputationObservabilityMiddleware(
  options: ReputationObservabilityOptions = {},
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const operation = OPERATION_BY_METHOD[req.method];
    if (!operation) {
      next();
      return;
    }

    const start = process.hrtime.bigint();

    res.once('finish', () => {
      const durationSeconds = Number(process.hrtime.bigint() - start) / 1_000_000_000;
      const classification = classifyReputationResponse(res.statusCode);
      const metric: ReputationRequestMetric = {
        operation,
        status: classification.status,
        statusCode: res.statusCode,
        errorCause: classification.errorCause,
        durationSeconds,
      };

      const log = resolveLogger(res, options.log);
      const logFields = {
        method: req.method,
        operation,
        status: classification.status,
        statusCode: res.statusCode,
        errorCause: classification.errorCause,
        durationMs: Number((durationSeconds * 1000).toFixed(3)),
      };

      if (options.metricsService) {
        try {
          options.metricsService.recordReputationRequest(metric);
        } catch {
          // Telemetry must never change the completed endpoint response.
          log.error('reputation_metrics_recording_failed', {
            operation,
            status: classification.status,
            statusCode: res.statusCode,
          });
        }
      }

      if (classification.status === 'server_error') {
        log.error('reputation_request', logFields);
      } else if (classification.status === 'client_error') {
        log.warn('reputation_request', logFields);
      } else {
        log.info('reputation_request', logFields);
      }
    });

    next();
  };
}

export function classifyReputationResponse(
  statusCode: number,
): ReputationResponseClassification {
  if (statusCode >= 500) {
    return { status: 'server_error', errorCause: 'internal_error' };
  }

  if (statusCode < 400) {
    return { status: 'success', errorCause: 'none' };
  }

  const causeByStatus: Record<number, ReputationErrorCause> = {
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

function resolveLogger(
  res: Response,
  fallback?: Pick<Logger, 'info' | 'warn' | 'error'>,
): Pick<Logger, 'info' | 'warn' | 'error'> {
  const requestLogger = res.locals['log'] as Pick<Logger, 'info' | 'warn' | 'error'> | undefined;
  return requestLogger ?? fallback ?? rootLogger;
}
