/**
 * @module audit/router
 * @description REST endpoints for querying the audit log.
 *
 * Routes:
 *   GET  /api/v1/audit          - Query audit entries with optional filters
 *   GET  /api/v1/audit/:id      - Retrieve a single entry by ID
 *   GET  /api/v1/audit/integrity - Verify the hash chain integrity
 *
 * Security notes:
 * - In production these routes MUST be protected by authentication and
 *   role-based authorisation (admin/auditor roles only).
 * - Query parameters are validated and clamped to prevent abuse.
 * - The integrity endpoint should be rate-limited to prevent DoS on large logs.
 */

import { Router, Request, Response } from 'express';
import { auditService } from './service';
import type { AuditAction, AuditQuery, AuditSeverity } from './types';

export const auditRouter = Router();

const VALID_ACTIONS = new Set<AuditAction>([
  'CONTRACT_CREATED', 'CONTRACT_UPDATED', 'CONTRACT_CANCELLED', 'CONTRACT_COMPLETED',
  'PAYMENT_INITIATED', 'PAYMENT_RELEASED', 'PAYMENT_DISPUTED',
  'REPUTATION_UPDATED',
  'USER_CREATED', 'USER_UPDATED', 'USER_DELETED',
  'AUTH_LOGIN', 'AUTH_LOGOUT', 'AUTH_FAILED',
  'ADMIN_ACTION',
]);

const VALID_SEVERITIES = new Set<AuditSeverity>(['INFO', 'WARNING', 'CRITICAL']);

/**
 * GET /api/v1/audit
 * Query audit log entries with optional filters and pagination.
 *
 * Query params:
 *   action, severity, actor, resource, resourceId, from, to, limit, offset
 */
auditRouter.get('/', (req: Request, res: Response): void => {
  const {
    action, severity, actor, resource, resourceId, from, to,
  } = req.query as Record<string, string | undefined>;

  const limit = Math.min(parseInt(req.query['limit'] as string ?? '100', 10) || 100, 1000);
  const offset = Math.max(parseInt(req.query['offset'] as string ?? '0', 10) || 0, 0);

  // Validate enum fields
  if (action && !VALID_ACTIONS.has(action as AuditAction)) {
    res.status(400).json({ error: `Invalid action: ${action}` });
    return;
  }
  if (severity && !VALID_SEVERITIES.has(severity as AuditSeverity)) {
    res.status(400).json({ error: `Invalid severity: ${severity}` });
    return;
  }

  const query: AuditQuery = {
    ...(action && { action: action as AuditAction }),
    ...(severity && { severity: severity as AuditSeverity }),
    ...(actor && { actor }),
    ...(resource && { resource }),
    ...(resourceId && { resourceId }),
    ...(from && { from }),
    ...(to && { to }),
    limit,
    offset,
  };

  const entries = auditService.query(query);
  res.json({ entries, count: entries.length, limit, offset });
});

/**
 * GET /api/v1/audit/integrity
 * Verify the tamper-evident hash chain.
 * Returns 200 if valid, 409 if corruption is detected.
 */
auditRouter.get('/integrity', (_req: Request, res: Response): void => {
  const report = auditService.verifyIntegrity();
  const status = report.valid ? 200 : 409;
  res.status(status).json(report);
});

/**
 * GET /api/v1/audit/:id
 * Retrieve a single audit entry by its UUID.
 */
auditRouter.get('/:id', (req: Request, res: Response): void => {
  const entry = auditService.getById(req.params['id'] ?? '');
  if (!entry) {
    res.status(404).json({ error: 'Audit entry not found' });
    return;
  }
  res.json(entry);
});
