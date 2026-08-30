/**
 * @module context
 * @description Request-scoped context propagation for asynchronous processors.
 *
 * The request context envelope carries traceability and authorization fields
 * (request id, tenant, actor) across asynchronous boundaries such as queue
 * jobs and webhook deliveries. It is populated by {@link requestContextMiddleware}
 * and read back with {@link getContext}.
 *
 * @security
 *   - Only whitelisted, non-empty string fields are propagated (mirrors
 *     `src/api/jobs.ts` sanitization and the DLQ context contract).
 *   - Values are bounded in length and control characters are rejected to
 *     prevent header injection.
 */

import { randomUUID } from 'crypto';
import { AsyncLocalStorage } from 'async_hooks';
import { NextFunction, Request, Response } from 'express';

/** A validated context envelope propagated through asynchronous processors. */
export interface RequestContextEnvelope {
  requestId?: string;
  correlationId?: string;
  tenantId?: string;
  actorId?: string;
  traceId?: string;
}

const MAX_CONTEXT_FIELD_LENGTH = 128;

function sanitizeContextValue(value: unknown): string | undefined {
  const raw = Array.isArray(value) ? value.find((v): v is string => typeof v === 'string') : value;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_CONTEXT_FIELD_LENGTH) return undefined;
  // Prevent header injection and other control-character issues.
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return undefined;
  return trimmed;
}

/**
 * AsyncLocalStorage instance carrying the request-scoped context envelope.
 */
export const requestContextStorage = new AsyncLocalStorage<RequestContextEnvelope>();

/**
 * Returns the current request context, or undefined when called outside an
 * active request scope.
 */
export function getContext(): RequestContextEnvelope | undefined {
  return requestContextStorage.getStore();
}

/**
 * Express middleware that seeds the request context from incoming headers and
 * `res.locals` (populated by `requestIdMiddleware`), then runs the rest of the
 * chain inside the AsyncLocalStorage scope.
 */
export function requestContextMiddleware(req: Request, res: Response, next: NextFunction): void {
  const requestId =
    sanitizeContextValue(req.headers['x-request-id']) ??
    sanitizeContextValue(res.locals?.requestId) ??
    randomUUID();
  const correlationId = sanitizeContextValue(req.headers['x-correlation-id']);
  const tenantId =
    sanitizeContextValue(req.headers['x-tenant-id']) ??
    sanitizeContextValue((req as { tenantId?: unknown }).tenantId);
  const actorId = sanitizeContextValue((req as { user?: { id?: unknown } }).user?.id);

  const context: RequestContextEnvelope = { requestId };
  if (correlationId) context.correlationId = correlationId;
  if (tenantId) context.tenantId = tenantId;
  if (actorId) context.actorId = actorId;

  requestContextStorage.run(context, () => next());
}
