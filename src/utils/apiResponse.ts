
import { Response } from 'express';

/**
 * Standard success envelope shape
 */
export interface SuccessEnvelope<T> {
  status: 'success';
  data: T;
  meta?: Record<string, unknown>;
  requestId: string;
  correlationId?: string;
}

/**
 * Standard error envelope shape
 */
export interface ErrorEnvelope {
  status: 'error';
  error: {
    code: string;
    message: string;
    requestId: string;
    correlationId?: string;
  };
}

/**
 * Extracts requestId from res.locals with a fallback.
 */
function getRequestId(res: Response): string {
  return typeof res.locals.requestId === 'string'
    ? res.locals.requestId
    : 'unknown';
}

/**
 * Extracts correlationId from res.locals when present.
 * Returns undefined when not set so the key is omitted from the envelope.
 */
function getCorrelationId(res: Response): string | undefined {
  return typeof res.locals.correlationId === 'string'
    ? res.locals.correlationId
    : undefined;
}

/**
 * @notice Sends a standard success response envelope.
 * @param res - Express Response object
 * @param data - Response payload
 * @param meta - Optional pagination or extra metadata
 * @param status - HTTP status code (default 200)
 */
export function ok<T>(
  res: Response,
  data: T,
  meta?: Record<string, unknown>,
  status = 200,
): void {
  const correlationId = getCorrelationId(res);
  const envelope: SuccessEnvelope<T> = {
    status: 'success',
    data,
    requestId: getRequestId(res),
    ...(correlationId !== undefined && { correlationId }),
  };

  if (meta !== undefined) {
    envelope.meta = meta;
  }

  res.status(status).json(envelope);
}

/**
 * @notice Sends a standard error response envelope.
 * @param res - Express Response object
 * @param code - Machine-readable error code
 * @param message - Human-readable error message
 * @param status - HTTP status code (default 400)
 */
export function fail(
  res: Response,
  code: string,
  message: string,
  status = 400,
): void {
  const correlationId = getCorrelationId(res);
  const envelope: ErrorEnvelope = {
    status: 'error',
    error: {
      code,
      message,
      requestId: getRequestId(res),
      ...(correlationId !== undefined && { correlationId }),
    },
  };

  res.status(status).json(envelope);
}
