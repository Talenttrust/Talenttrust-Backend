import { randomUUID } from 'crypto';
import { NextFunction, Request, Response } from 'express';
import { AsyncLocalStorage } from 'async_hooks';
import { sanitizeCorrelationId } from '../utils/correlationId';

export interface RequestContextInfo {
  requestId: string;
  correlationId?: string;
}

/**
 * AsyncLocalStorage instance to store request-scoped context such as requestId and correlationId.
 */
export const requestContextStore = new AsyncLocalStorage<RequestContextInfo>();

/**
 * Accesses the current request-scoped context from the AsyncLocalStorage store.
 * Returns undefined if called outside of an active request execution context.
 *
 * @returns The current RequestContextInfo or undefined if no context is active.
 */
export function getRequestContext(): RequestContextInfo | undefined {
  return requestContextStore.getStore();
}

/**
 * Adds and returns a request correlation ID for observability and error tracing,
 * and runs downstream middleware and route handlers inside an AsyncLocalStorage context.
 */
export function requestContext(req: Request, res: Response, next: NextFunction): void {
  const requestId = sanitizeCorrelationId(req.header('x-request-id')) ?? randomUUID();
  const correlationId = sanitizeCorrelationId(req.header('x-correlation-id'));

  res.locals.requestId = requestId;
  res.setHeader('x-request-id', requestId);
  if (correlationId) {
    res.locals.correlationId = correlationId;
    res.setHeader('x-correlation-id', correlationId);
  }

  requestContextStore.run({ requestId, correlationId }, () => {
    next();
  });
}
