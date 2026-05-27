/**
 * @module audit/protectedEndpointMiddleware
 * @description Express middleware that automatically emits a structured audit
 * entry for every request handled by an auth-protected route.
 *
 * ## How it works
 *
 * The middleware registers a `res.on('finish')` listener before calling
 * `next()`. This guarantees that the audit entry is written **after** the
 * full middleware chain (including authentication) has run, so the final
 * HTTP status code and the resolved `req.user` identity are both available.
 *
 * Mount this middleware **before** `authenticateMiddleware` / `requireAuth`
 * on any router or route group that requires authentication.
 *
 * ## Action mapping
 *
 * | Condition                     | AuditAction          | Severity  |
 * |-------------------------------|----------------------|-----------|
 * | Status 401 (unauthenticated)  | `AUTH_FAILED`        | `WARNING` |
 * | Status 403 (unauthorised)     | `AUTH_FAILED`        | `WARNING` |
 * | GET / HEAD + 2xx/3xx          | `ENDPOINT_ACCESS`    | `INFO`    |
 * | POST / PUT / PATCH / DELETE   | `ENDPOINT_MUTATION`  | `INFO`    |
 * | Any method + 4xx/5xx (other)  | method-derived above | `WARNING` |
 *
 * ## Redaction
 *
 * All request headers and body fields are passed through the deterministic
 * redaction rules defined in `./redact` before being written to the store.
 * The `Authorization` header value is **never** persisted.
 *
 * ## Traceability
 *
 * The `requestId` set by `requestIdMiddleware` (stored in
 * `res.locals.requestId`) is used as the `correlationId` on every entry,
 * enabling end-to-end request tracing across logs.
 *
 * @security
 * - Audit failures are silently swallowed (with a console.error) so that a
 *   logging fault never breaks the primary request path.
 * - No raw bearer tokens, passwords, or PII reach the audit store.
 *
 * @example
 * ```ts
 * import { protectedEndpointAuditMiddleware } from './audit/protectedEndpointMiddleware';
 * import { authenticateMiddleware } from './auth/authenticate';
 *
 * router.use(protectedEndpointAuditMiddleware);
 * router.use(authenticateMiddleware);
 * router.get('/contracts', handler);
 * ```
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { AuditAction, AuditSeverity } from './types';
import type { AuthenticatedRequest } from '../auth/authenticate';
import { buildAuditMetadata } from './redact';
import { auditService, AuditService } from './service';

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Map HTTP method + final status code to an AuditAction.
 * Auth failures take priority over the HTTP verb.
 */
function deriveAction(method: string, statusCode: number): AuditAction {
  if (statusCode === 401 || statusCode === 403) {
    return 'AUTH_FAILED';
  }
  const verb = method.toUpperCase();
  return verb === 'GET' || verb === 'HEAD' ? 'ENDPOINT_ACCESS' : 'ENDPOINT_MUTATION';
}

/**
 * Choose the appropriate severity for an audit entry.
 * Auth failures and unexpected errors are WARNING; routine access is INFO.
 */
function deriveSeverity(action: AuditAction, statusCode: number): AuditSeverity {
  if (action === 'AUTH_FAILED') return 'WARNING';
  if (statusCode >= 400) return 'WARNING';
  return 'INFO';
}

/**
 * Extract the resource type from a URL path.
 * Parses the first named segment after the versioned API prefix.
 *
 * @example
 * '/api/v1/contracts/abc'   → 'contracts'
 * '/api/v1/reputation/u1'  → 'reputation'
 * '/other'                 → 'endpoint'
 */
function deriveResource(path: string): string {
  const match = /^\/api\/v\d+\/([^/?#]+)/i.exec(path);
  return match?.[1] ?? 'endpoint';
}

/**
 * Extract the primary resource ID from a URL path.
 * Returns the path segment immediately after the resource type, if present.
 *
 * @example
 * '/api/v1/contracts/abc123/metadata'  → 'abc123'
 * '/api/v1/contracts'                  → ''
 */
function deriveResourceId(path: string): string {
  const match = /^\/api\/v\d+\/[^/?#]+\/([^/?#]+)/i.exec(path);
  return match?.[1] ?? '';
}

// ─── Middleware factory ───────────────────────────────────────────────────────

/**
 * Factory that returns a `protectedEndpointAuditMiddleware` bound to the
 * provided `AuditService` instance. Useful for injecting isolated services
 * in tests without touching the module-level singleton.
 *
 * @param service - AuditService instance to write entries to (defaults to
 *                  the application singleton).
 */
export function createProtectedEndpointAuditMiddleware(
  service: AuditService = auditService,
): RequestHandler {
  return function protectedEndpointAuditMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    res.on('finish', () => {
      try {
        // req.user is populated by authenticateMiddleware after this runs
        const actor =
          (req as AuthenticatedRequest).user?.userId ?? 'anonymous';

        const action = deriveAction(req.method, res.statusCode);
        const severity = deriveSeverity(action, res.statusCode);
        const resource = deriveResource(req.path);
        const resourceId = deriveResourceId(req.path);
        const requestId = res.locals['requestId'] as string | undefined;
        const ipAddress =
          (req.ip ?? req.socket?.remoteAddress) as string | undefined;

        const metadata = buildAuditMetadata(
          req.method,
          req.path,
          req.headers as Record<string, string | string[] | undefined>,
          req.body,
          req.query as Record<string, unknown>,
          res.statusCode,
          requestId,
        );

        service.log({
          action,
          severity,
          actor,
          resource,
          resourceId,
          metadata,
          ipAddress,
          correlationId: requestId,
        });
      } catch (err) {
        // Audit failures must never disrupt the request lifecycle.
        console.error('[protectedEndpointAuditMiddleware] Failed to write audit entry:', err);
      }
    });

    next();
  };
}

/**
 * Ready-to-use middleware instance backed by the application-level singleton
 * `AuditService`. Import and mount this on any protected router.
 */
export const protectedEndpointAuditMiddleware =
  createProtectedEndpointAuditMiddleware();
