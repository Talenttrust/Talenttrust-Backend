/**
 * @module context
 * @description Request-scoped context propagation via AsyncLocalStorage.
 *
 * Provides a module-level `requestContextStorage` that middleware and services
 * can run work inside, and a `getContext()` accessor to read the current
 * request-scoped values from anywhere in that call chain (including async
 * functions that no longer have the Express `req`/`res` available, such as
 * background job processors and event-ingestion workers).
 *
 * This intentionally mirrors `src/middleware/requestContext.ts`, which already
 * tracks `requestId`/`correlationId` for HTTP middleware. This module is a
 * wider, open-shaped store so services can enrich it with additional fields
 * (e.g. `actorId`) without coupling to Express.
 *
 * @security
 *  - Values live only for the duration of the `run()` callback; nothing is
 *    persisted globally, so context cannot leak across unrelated requests.
 *
 * @compatibility
 *  - `getContext()` MUST return `undefined` (never throw, never a fresh empty
 *    object) when called outside an active `run()` scope. Callers rely on this
 *    to distinguish "no request context" from "context present but empty".
 *  - The store is returned by reference, not copied. Mutating the returned
 *    object mutates the active context; this is intentional and preserved.
 *  - `requestContextStorage` is exported as a stable singleton so middleware
 *    and services share one store instance across module reloads.
 */

import { AsyncLocalStorage } from 'async_hooks';
import type { Request, Response, NextFunction } from 'express';
import { requestContextStore } from './middleware/requestContext';

/**
 * Arbitrary request-scoped metadata carried through an async call chain.
 * Standard entries are `requestId`, `correlationId`, and `actorId`, but the
 * shape is intentionally open so consumers can attach their own fields.
 */
export type RequestContext = Record<string, unknown>;

/**
 * AsyncLocalStorage instance storing the current request-scoped context.
 * Use {@link requestContextStorage.run} to establish a context, then call
 * {@link getContext} inside the callback (or any awaited continuation).
 */
export const requestContextStorage = new AsyncLocalStorage<RequestContext>();

/**
 * Read the current request-scoped context.
 *
 * @returns The active context, or `undefined` when called outside of a
 *          `requestContextStorage.run()` callback.
 */
export function getContext(): RequestContext | undefined {
  // Contract: returns the live store by reference, or `undefined` when no
  // context is active. Never throws and never fabricates a default object.
  return requestContextStorage.getStore();
}

/**
 * Express middleware that seeds the AsyncLocalStorage context with the
 * requestId and correlationId from the request headers / res.locals.
 *
 * Re-exported here so `app.ts` can import it from `./context` without
 * importing from the middleware sub-folder directly.
 */
export function requestContextMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const existing = requestContextStore.getStore();
  const enriched: RequestContext = {
    ...(existing ?? {}),
    requestId: res.locals.requestId ?? req.headers['x-request-id'],
    correlationId: res.locals.correlationId ?? req.headers['x-correlation-id'],
  };
  requestContextStorage.run(enriched, () => next());
}