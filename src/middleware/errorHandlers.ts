import { NextFunction, Request, Response } from 'express';
import { AppError, mapErrorToPayload } from '../errors/appError';
import { containsUnsafeContent } from '../errors/safeErrors';
import { logger } from '../logger';

function isBodyParserSyntaxError(error: unknown): boolean {
  return error instanceof SyntaxError && 'status' in error;
}

/**
 * The CORS middleware rejects a disallowed origin by passing a plain Error
 * (`Not allowed by CORS policy`) to `next`. Surface that as a 403 rather than a
 * generic 500 so blocked cross-origin requests get an accurate status.
 */
function isCorsPolicyError(error: unknown): boolean {
  return error instanceof Error && error.message === 'Not allowed by CORS policy';
}

function redactedErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return typeof error === 'string' && !containsUnsafeContent(error) ? error : '[REDACTED]';
  }

  return containsUnsafeContent(error.message) ? '[REDACTED]' : error.message;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/**
 * Handles unknown routes with a structured 404 response.
 */
export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(new AppError(404, 'not_found', 'The requested resource was not found'));
}

/**
 * Maps all errors to a consistent API envelope and status code.
 *
 * @remarks This middleware must be registered last. It preserves internal
 * diagnostics in redacted structured logs while serializing every client
 * response through `mapErrorToPayload`.
 */
export function errorHandler(error: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (res.headersSent) {
    return;
  }

  if ((req as any).streamError) {
    error = (req as any).streamError;
  }

  const requestId = typeof res.locals.requestId === 'string' ? res.locals.requestId : 'unknown';
  const correlationId =
    typeof res.locals.correlationId === 'string' ? res.locals.correlationId : undefined;

  const errorForPolicy = isBodyParserSyntaxError(error)
    ? new AppError(400, 'invalid_json', 'Malformed JSON payload')
    : isCorsPolicyError(error)
      ? new AppError(403, 'forbidden', 'Origin not allowed by CORS policy')
      : error;
  const mapped = mapErrorToPayload(errorForPolicy, requestId);

  const log = res.locals.log && typeof res.locals.log.error === 'function'
    ? res.locals.log
    : logger;

  log.error('API request failed', {
    err: {
      type: errorName(error),
      message: redactedErrorMessage(error),
    },
    method: req.method,
    path: req.path,
    statusCode: mapped.statusCode,
    errorCode: mapped.payload.error.code,
    requestId,
    ...(correlationId !== undefined && { correlationId }),
  });

  res.status(mapped.statusCode).json(mapped.payload);
}
