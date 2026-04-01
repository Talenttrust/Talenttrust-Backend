/**
 * @module middleware/requestId
 * @description Express middleware that attaches a unique request ID and an
 * optional caller-supplied correlation ID to every incoming HTTP request.
 *
 * Request ID lifecycle
 * --------------------
 * 1. If the client sends `X-Request-Id`, that value is reused (after
 *    validation) so upstream proxies can propagate their own IDs.
 * 2. Otherwise a new UUID v4 is generated server-side.
 * 3. The resolved ID is written back on the response as `X-Request-Id`.
 *
 * Correlation ID lifecycle
 * ------------------------
 * 1. If the client sends `X-Correlation-Id`, that value is forwarded as-is
 *    (after validation) to allow distributed-trace stitching.
 * 2. The resolved ID (or undefined) is written back on the response as
 *    `X-Correlation-Id` when present.
 *
 * Security note: incoming header values are validated against a strict
 * allowlist pattern (UUID v4 or alphanumeric+hyphen, max 128 chars) to
 * prevent header-injection attacks.
 *
 * The middleware also attaches a request-scoped child logger to `res.locals`
 * so that route handlers can log with full correlation context without
 * importing the logger directly.
 */

import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { logger } from '../logger';

/** Header names used for propagation. */
export const REQUEST_ID_HEADER = 'x-request-id';
export const CORRELATION_ID_HEADER = 'x-correlation-id';

/**
 * Allowlist pattern for externally supplied IDs.
 * Accepts UUID v4 format OR alphanumeric strings with hyphens/underscores
 * up to 128 characters.
 */
const SAFE_ID_PATTERN = /^[a-zA-Z0-9\-_]{1,128}$/;

/**
 * Validate an externally supplied ID string.
 * Returns the value unchanged if valid, otherwise returns undefined.
 */
export function validateExternalId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return SAFE_ID_PATTERN.test(value) ? value : undefined;
}

/**
 * Express middleware: attach requestId + correlationId to every request.
 *
 * After this middleware runs:
 *   - `res.locals.requestId`    – string UUID
 *   - `res.locals.correlationId` – string | undefined
 *   - `res.locals.log`          – child Logger bound to those IDs
 */
export function requestIdMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  // Resolve request ID
  const incomingRequestId = validateExternalId(req.headers[REQUEST_ID_HEADER]);
  const requestId = incomingRequestId ?? randomUUID();

  // Resolve correlation ID
  const correlationId = validateExternalId(
    req.headers[CORRELATION_ID_HEADER],
  );

  // Attach to response locals for downstream use
  res.locals['requestId'] = requestId;
  res.locals['correlationId'] = correlationId;

  // Propagate IDs back to the caller
  res.setHeader(REQUEST_ID_HEADER, requestId);
  if (correlationId !== undefined) {
    res.setHeader(CORRELATION_ID_HEADER, correlationId);
  }

  // Bind a request-scoped child logger
  res.locals['log'] = logger.child({
    requestId,
    ...(correlationId !== undefined && { correlationId }),
  });

  next();
}
