/**
 * @module audit/middleware
 * @description Express middleware for automatic audit logging of HTTP requests.
 *
 * Attaches a per-request audit helper to `res.locals.audit` so route handlers
 * can emit structured audit events without importing the service directly.
 *
 * When `AUDIT_ENABLED=false` the middleware attaches a no-op helper so that
 * callers compiled against `res.locals.audit.log(...)` continue to work
 * without error — they simply produce no stored entry.
 *
 * Security notes:
 * - IP addresses are extracted from X-Forwarded-For only when the app is
 *   behind a trusted proxy. Set `app.set('trust proxy', true)` accordingly.
 * - Correlation IDs from X-Correlation-ID headers are passed through as-is;
 *   validate/sanitise them if they are user-controlled.
 */

import type { Request, Response, NextFunction } from 'express';
import { auditService } from './service';
import type { AuditEntry, CreateAuditEntryInput } from './types';
import { validateEnv } from '../config/env.schema';

/** Helper attached to res.locals for route-level audit logging. */
export interface RequestAuditHelper {
  /**
   * Emits an audit event scoped to the current HTTP request.
   *
   * The middleware automatically injects `ipAddress` (from `req.ip` or the
   * raw socket) and `correlationId` (from the `X-Correlation-ID` header) so
   * callers do not need to supply those fields manually.
   *
   * When `AUDIT_ENABLED=false` this is a **no-op**: it returns a stub
   * `AuditEntry` with empty `id`/`hash` fields and does **not** write
   * anything to the underlying store.
   *
   * @param input - Audit event details, excluding `ipAddress` and
   *   `correlationId` (injected from the request context).
   * @returns The persisted {@link AuditEntry}, or a stub entry when the
   *   feature flag is off.
   */
  log(input: Omit<CreateAuditEntryInput, 'ipAddress' | 'correlationId'>): AuditEntry;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Locals {
      audit: RequestAuditHelper;
    }
  }
}

/**
 * Attaches `res.locals.audit` to every request.
 * Mount this before your route handlers.
 *
 * When `AUDIT_ENABLED=false` (runtime env), the attached helper is a no-op:
 * it returns a stub `AuditEntry` without writing anything to the store.
 *
 * @example
 * ```ts
 * app.use(auditMiddleware);
 * app.post('/api/v1/contracts', (req, res) => {
 *   res.locals.audit.log({ action: 'CONTRACT_CREATED', ... });
 *   res.json({ ... });
 * });
 * ```
 */
export function auditMiddleware(req: Request, res: Response, next: NextFunction): void {
  const env = validateEnv();

  if (!env.AUDIT_ENABLED) {
    // Feature flag off — attach a no-op helper so route code compiles and
    // runs without branching on the flag themselves.
    res.locals.audit = {
      log(_input: Omit<CreateAuditEntryInput, 'ipAddress' | 'correlationId'>): AuditEntry {
        return {
          id: '',
          timestamp: new Date().toISOString(),
          hash: '',
          previousHash: '',
          action: _input.action,
          severity: _input.severity,
          actor: _input.actor,
          resource: _input.resource,
          resourceId: _input.resourceId,
          metadata: _input.metadata,
        };
      },
    } satisfies RequestAuditHelper;
    next();
    return;
  }

  const ipAddress = (req.ip ?? req.socket?.remoteAddress) as string | undefined;
  const correlationId = req.headers['x-correlation-id'] as string | undefined;

  res.locals.audit = {
    log(input: Omit<CreateAuditEntryInput, 'ipAddress' | 'correlationId'>): AuditEntry {
      return auditService.log({ ...input, ipAddress, correlationId });
    },
  } satisfies RequestAuditHelper;

  next();
}
