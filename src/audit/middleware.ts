/**
 * @module audit/middleware
 * @description Express middleware for automatic audit logging of HTTP requests.
 *
 * Attaches a per-request audit helper to `res.locals.audit` so route handlers
 * can emit structured audit events without importing the service directly.
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

/** Helper attached to res.locals for route-level audit logging. */
export interface RequestAuditHelper {
  /**
   * Emits an audit event scoped to the current HTTP request.
   * Automatically injects ipAddress and correlationId from the request.
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
  const ipAddress = (req.ip ?? req.socket?.remoteAddress) as string | undefined;
  const correlationId = req.headers['x-correlation-id'] as string | undefined;

  res.locals.audit = {
    log(input: Omit<CreateAuditEntryInput, 'ipAddress' | 'correlationId'>): AuditEntry {
      return auditService.log({ ...input, ipAddress, correlationId });
    },
  } satisfies RequestAuditHelper;

  next();
}
