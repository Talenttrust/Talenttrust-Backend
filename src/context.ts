/**
 * @module context
 * @description Request-scoped context propagation via AsyncLocalStorage.
 *
 * The middleware seeds a per-request context (request id, correlation id,
 * optional tenant/actor/trace ids) into {@link requestContextStorage} so that
 * asynchronous work spawned from a request handler — event ingestion,
 * webhook delivery, background processors — can recover the same tracing and
 * isolation fields without threading them through every call signature.
 *
 * Usage:
 * - `requestContextMiddleware` is mounted app-wide (after request id
 *   resolution) and runs each handler inside a fresh context.
 * - `getContext()` returns the current context (or `undefined` outside a
 *   request) — safe for callers that must work in both request and
 *   non-request contexts (e.g. queue processors).
 * - `runWithContext()` runs a function inside an explicit context, used by
 *   tests and by code that must re-establish context after async hops.
 *
 * @security
 *  - Context values come from validated request metadata (`res.locals` set by
 *    `requestIdMiddleware`), never from unvalidated caller input.
 *  - Context is scoped to the request lifetime; a new request always starts
 *    with a fresh store so no cross-request leakage is possible.
 */

import { AsyncLocalStorage } from 'async_hooks';
import type { NextFunction, Request, Response } from 'express';

/** Whitelisted fields carried in the request context. */
export interface RequestContext {
  requestId?: string;
  correlationId?: string;
  tenantId?: string;
  actorId?: string;
  traceId?: string;
}

/**
 * Async storage for the current request context. `getStore()` returns the
 * context bound to the current async execution chain, or `undefined` when no
 * context has been established (e.g. a background worker outside a request).
 */
export const requestContextStorage = new AsyncLocalStorage<RequestContext>();

/**
 * Return the context bound to the current async execution, or `undefined`
 * when the caller is not inside a request/context scope.
 */
export function getContext(): RequestContext | undefined {
  return requestContextStorage.getStore();
}

/**
 * Run `fn` inside the given context. Nested runs inherit the outer context
 * fields and override them with the provided values, so processors that need
 * to enrich (e.g. add `actorId`) can safely re-run with a merged envelope.
 */
export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return requestContextStorage.run(context, fn);
}

/**
 * Express middleware that seeds the per-request context from the validated
 * request metadata already attached to `res.locals` by `requestIdMiddleware`.
 *
 * Must be mounted after `requestIdMiddleware`; requests that bypass it (or
 * tests that mount handlers directly) simply run with an empty context.
 */
export function requestContextMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const context: RequestContext = {};
  const locals = res.locals as Record<string, unknown>;

  if (typeof locals['requestId'] === 'string') {
    context.requestId = locals['requestId'];
  }
  if (typeof locals['correlationId'] === 'string') {
    context.correlationId = locals['correlationId'];
  }
  if (typeof locals['tenantId'] === 'string') {
    context.tenantId = locals['tenantId'];
  }
  if (typeof locals['actorId'] === 'string') {
    context.actorId = locals['actorId'];
  }
  if (typeof locals['traceId'] === 'string') {
    context.traceId = locals['traceId'];
  }

  requestContextStorage.run(context, () => next());
}
