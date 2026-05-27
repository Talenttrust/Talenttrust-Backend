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

import { Router, Request, Response, type RequestHandler } from 'express';
import { pipeline } from 'stream/promises';
import { auditService, AuditService } from './service';
import { auditExportService, AuditExportService } from './exportService';
import type { AuditAction, AuditQuery, AuditSeverity } from './types';

export interface AuditRouterOptions {
  service?: AuditService;
  exportService?: AuditExportService;
  accessMiddleware?: RequestHandler[];
  exportMiddleware?: RequestHandler[];
}

const VALID_ACTIONS = new Set<AuditAction>([
  'CONTRACT_CREATED', 'CONTRACT_UPDATED', 'CONTRACT_CANCELLED', 'CONTRACT_COMPLETED',
  'PAYMENT_INITIATED', 'PAYMENT_RELEASED', 'PAYMENT_DISPUTED',
  'REPUTATION_UPDATED',
  'USER_CREATED', 'USER_UPDATED', 'USER_DELETED',
  'AUTH_LOGIN', 'AUTH_LOGOUT', 'AUTH_FAILED',
  'ADMIN_ACTION',
  'ENDPOINT_ACCESS', 'ENDPOINT_MUTATION',
]);

const VALID_SEVERITIES = new Set<AuditSeverity>(['INFO', 'WARNING', 'CRITICAL']);

function parseOptionalIsoDate(
  value: string | undefined,
  fieldName: 'from' | 'to',
): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid ${fieldName} timestamp`);
  }

  return new Date(parsed).toISOString();
}

function parseOffset(value: string | undefined): number {
  if (value === undefined) {
    return 0;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error('Invalid offset');
  }

  return parsed;
}

function parseLimit(value: string | undefined, maxLimit: number, defaultLimit?: number): number | undefined {
  if (value === undefined) {
    return defaultLimit;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error('Invalid limit');
  }

  return Math.min(parsed, maxLimit);
}

function parseAuditQuery(
  req: Request,
  options: { defaultLimit?: number; maxLimit: number },
): { query: AuditQuery; limit?: number; offset: number } {
  const {
    action, severity, actor, resource, resourceId,
  } = req.query as Record<string, string | undefined>;

  if (action && !VALID_ACTIONS.has(action as AuditAction)) {
    throw new Error(`Invalid action: ${action}`);
  }

  if (severity && !VALID_SEVERITIES.has(severity as AuditSeverity)) {
    throw new Error(`Invalid severity: ${severity}`);
  }

  const limit = parseLimit(req.query['limit'] as string | undefined, options.maxLimit, options.defaultLimit);
  const offset = parseOffset(req.query['offset'] as string | undefined);

  return {
    query: {
      ...(action && { action: action as AuditAction }),
      ...(severity && { severity: severity as AuditSeverity }),
      ...(actor && { actor }),
      ...(resource && { resource }),
      ...(resourceId && { resourceId }),
      ...(parseOptionalIsoDate(req.query['from'] as string | undefined, 'from') && {
        from: parseOptionalIsoDate(req.query['from'] as string | undefined, 'from'),
      }),
      ...(parseOptionalIsoDate(req.query['to'] as string | undefined, 'to') && {
        to: parseOptionalIsoDate(req.query['to'] as string | undefined, 'to'),
      }),
      ...(limit !== undefined && { limit }),
      offset,
    },
    limit,
    offset,
  };
}

export function createAuditRouter(options: AuditRouterOptions = {}): Router {
  const router = Router();
  const service = options.service ?? auditService;
  const exportService = options.exportService ?? auditExportService;
  const accessMiddleware = options.accessMiddleware ?? [];
  const exportMiddleware = options.exportMiddleware ?? [];

  router.get('/', ...accessMiddleware, (req: Request, res: Response): void => {
    try {
      const { query, limit = 100, offset } = parseAuditQuery(req, { defaultLimit: 100, maxLimit: 1000 });
      const entries = service.query(query);
      res.json({ entries, count: entries.length, limit, offset });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

/**
 * GET /api/v1/audit/export
 * Streams a file-backed NDJSON export for compliance downloads.
 */
  router.get('/export', ...accessMiddleware, ...exportMiddleware, async (req: Request, res: Response): Promise<void> => {
    let exportResult:
      | Awaited<ReturnType<AuditExportService['createNdjsonExport']>>
      | undefined;

    try {
      const actor = (req as Request & { user?: { id?: string } }).user?.id ?? 'anonymous';
      const { query } = parseAuditQuery(req, { maxLimit: 50_000 });

      exportResult = await exportService.createNdjsonExport(query);

      service.log({
        action: 'ADMIN_ACTION',
        severity: 'CRITICAL',
        actor,
        resource: 'audit-log',
        resourceId: 'export',
        metadata: {
          operation: 'export',
          format: 'ndjson',
          filters: {
            action: query.action ?? null,
            severity: query.severity ?? null,
            actor: query.actor ?? null,
            resource: query.resource ?? null,
            resourceId: query.resourceId ?? null,
            from: query.from ?? null,
            to: query.to ?? null,
            limit: query.limit ?? null,
            offset: query.offset ?? 0,
          },
          recordCount: exportResult.recordCount,
          bytesWritten: exportResult.bytesWritten,
        },
        ipAddress: req.ip,
        correlationId: typeof res.locals['requestId'] === 'string'
          ? res.locals['requestId']
          : undefined,
      });

      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${exportResult.fileName}"`);
      res.setHeader('X-Audit-Export-Records', String(exportResult.recordCount));

      await pipeline(exportResult.openReadStream(), res);
    } catch (error) {
      if (!res.headersSent) {
        const status = (error as Error).message.startsWith('Invalid ') ? 400 : 500;
        res.status(status).json({ error: (error as Error).message });
      }
    } finally {
      if (exportResult) {
        await exportResult.cleanup();
      }
    }
  });

/**
 * GET /api/v1/audit/integrity
 * Verify the tamper-evident hash chain.
 * Returns 200 if valid, 409 if corruption is detected.
 */
  router.get('/integrity', ...accessMiddleware, (_req: Request, res: Response): void => {
    const report = service.verifyIntegrity();
    const status = report.valid ? 200 : 409;
    res.status(status).json(report);
  });

/**
 * GET /api/v1/audit/:id
 * Retrieve a single audit entry by its UUID.
 */
  router.get('/:id', ...accessMiddleware, (req: Request, res: Response): void => {
    const entry = service.getById(req.params['id'] ?? '');
    if (!entry) {
      res.status(404).json({ error: 'Audit entry not found' });
      return;
    }
    res.json(entry);
  });

  return router;
}

export const auditRouter = createAuditRouter();
