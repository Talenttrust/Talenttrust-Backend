/**
 * @module audit/router
 * @description REST endpoints for querying and writing the audit log.
 *
 * Routes:
 *   GET  /api/v1/audit          - Query audit entries with optional filters
 *   GET  /api/v1/audit/export   - Stream an NDJSON export for compliance
 *   GET  /api/v1/audit/integrity - Verify the hash chain integrity
 *   POST /api/v1/audit          - Write a single audit entry
 *   POST /api/v1/audit/bulk     - Write a bounded batch of audit entries
 */

import { Router, Request, Response, NextFunction, type RequestHandler } from 'express';
import type { ZodError } from 'zod';
import { pipeline } from 'stream/promises';
import { z } from 'zod';
import compression from 'compression';
import { auditService, AuditService } from './service';
import { auditExportService, AuditExportService, type AuditExportFilters, type AuditExportResult } from './exportService';
import type { AuditQuery } from './types';
import { buildAuditQuerySchema, createAuditEntryBodySchema, type AuditQueryParams } from './schemas';
import { mapZodErrorToDetails, type ValidationErrorResponse } from '../middleware/validate.middleware';
import { idempotencyMiddleware } from '../middleware/idempotency';
import { toAuditEntryResponseDto } from './dto/audit.dto';
import { getCorrelationId, getRequestId as getRequestIdFromUtils } from '../utils/correlationId';

/**
 * Maximum number of audit entries accepted in a single bulk request.
 */
export const MAX_BULK_AUDIT_ITEMS = 500;

export interface AuditRouterOptions {
  service?: AuditService;
  exportService?: AuditExportService;
  accessMiddleware?: RequestHandler[];
  exportMiddleware?: RequestHandler[];
  integrityMiddleware?: RequestHandler[];
  bulkMiddleware?: RequestHandler[];
}

function safeGetRequestId(res: Response): string {
  try {
    return getRequestIdFromUtils(res);
  } catch {
    return typeof res.locals?.['requestId'] === 'string' ? res.locals['requestId'] : 'unknown';
  }
}

function safeGetCorrelationId(res: Response): string | undefined {
  try {
    return getCorrelationId(res);
  } catch {
    return typeof res.locals?.['correlationId'] === 'string' ? res.locals['correlationId'] : undefined;
  }
}

function buildValidationErrorResponse(requestId: string, correlationId: string | undefined, error: ZodError): ValidationErrorResponse {
  return {
    error: {
      code: 'validation_error',
      message: 'Request validation failed',
      requestId,
      ...(correlationId !== undefined && { correlationId }),
      details: mapZodErrorToDetails(error),
    },
  };
}

/**
 * Parses and validates query filters against the audit query schema and, on
 * failure, writes the shared structured 400 validation response directly.
 */
function parseAuditQueryOrRespond(
  req: Request,
  res: Response,
  options: { defaultLimit?: number; maxLimit: number },
): { query: AuditQuery; limit?: number; offset: number } | undefined {
  const result = buildAuditQuerySchema(options).safeParse(req.query);

  if (!result.success) {
    const requestId = safeGetRequestId(res);
    const correlationId = safeGetCorrelationId(res);
    res.status(400).json(buildValidationErrorResponse(requestId, correlationId, result.error));
    return undefined;
  }

  const params: AuditQueryParams = result.data;
  const { action, severity, actor, resource, resourceId, from, to, limit, offset, cursor } = params;

  return {
    query: {
      ...(action && { action }),
      ...(severity && { severity }),
      ...(actor && { actor }),
      ...(resource && { resource }),
      ...(resourceId && { resourceId }),
      ...(from && { from }),
      ...(to && { to }),
      ...(limit !== undefined && { limit }),
      offset,
      ...(cursor && { cursor }),
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
  const integrityMiddleware = options.integrityMiddleware ?? [];
  const bulkMiddleware = options.bulkMiddleware ?? [];

  /**
   * POST /api/v1/audit
   */
  router.post(
    '/',
    idempotencyMiddleware,
    ...accessMiddleware,
    (req: Request, res: Response): void => {
      try {
        const parseResult = createAuditEntryBodySchema.safeParse(req.body);

        if (!parseResult.success) {
          const requestId = safeGetRequestId(res);
          const correlationId = safeGetCorrelationId(res);
          res.status(400).json(buildValidationErrorResponse(requestId, correlationId, parseResult.error));
          return;
        }

        const correlationId = safeGetCorrelationId(res);
        const entryData = parseResult.data;
        if (correlationId && !entryData.correlationId) {
          entryData.correlationId = correlationId;
        }

        const entry = service.log(entryData);
        res.status(201).json(entry);
      } catch (error) {
        const message = (error as Error).message;
        const status = message.startsWith('Missing required fields:') ? 400 : 500;
        const requestId = safeGetRequestId(res);
        const correlationId = safeGetCorrelationId(res);
        res.status(status).json({ 
          error: message,
          requestId,
          ...(correlationId !== undefined && { correlationId }),
        });
      }
    },
  );

  /**
   * POST /api/v1/audit/bulk
   */
  const bulkEnvelopeSchema = z.object({
    entries: z
      .array(z.unknown())
      .min(1, 'Batch must contain at least one entry')
      .max(MAX_BULK_AUDIT_ITEMS, `Batch must not exceed ${MAX_BULK_AUDIT_ITEMS} entries`),
  });

  router.post(
    '/bulk',
    idempotencyMiddleware,
    ...accessMiddleware,
    ...bulkMiddleware,
    (req: Request, res: Response): void => {
      const envelopeResult = bulkEnvelopeSchema.safeParse(req.body);
      if (!envelopeResult.success) {
        const requestId = safeGetRequestId(res);
        const correlationId = safeGetCorrelationId(res);
        res.status(400).json(buildValidationErrorResponse(requestId, correlationId, envelopeResult.error));
        return;
      }

      const rawEntries = envelopeResult.data.entries;
      let succeeded = 0;
      let failed = 0;

      const results = rawEntries.map((rawItem, index) => {
        if (typeof rawItem !== 'object' || rawItem === null || Array.isArray(rawItem)) {
          failed += 1;
          return { index, success: false, error: 'Item must be an object' };
        }

        const itemResult = createAuditEntryBodySchema.safeParse(rawItem);
        if (!itemResult.success) {
          failed += 1;
          const r = rawItem as Record<string, unknown>;
          const missingFields = ['action', 'severity', 'actor', 'resource', 'resourceId']
            .filter((k) => r[k] === undefined || r[k] === null || r[k] === '');

          let msg: string;
          if (missingFields.length > 0) {
            msg = `Missing required fields: ${missingFields.join(', ')}`;
          } else {
            const firstIssue = itemResult.error.issues[0];
            const field = firstIssue?.path[0] as string | undefined;
            if (field === 'action') {
              msg = `Invalid action: ${r['action']}`;
            } else if (field === 'severity') {
              msg = `Invalid severity: ${r['severity']}`;
            } else {
              msg = firstIssue?.message ?? 'Validation failed';
            }
          }
          return { index, success: false, error: msg };
        }

        try {
          const entry = service.log(itemResult.data);
          succeeded += 1;
          return { index, success: true, entry };
        } catch (err) {
          failed += 1;
          return { index, success: false, error: (err as Error).message };
        }
      });

      const status = failed === 0 ? 201 : 207;
      res.status(status).json({ succeeded, failed, results });
    },
  );

  /**
   * GET /api/v1/audit
   */
  router.get(
    '/',
    ...accessMiddleware,
    compression({ threshold: 1024 }),
    (req: Request, res: Response): void => {
      const parsed = parseAuditQueryOrRespond(req, res, { defaultLimit: 50, maxLimit: 100 });
      if (!parsed) {
        return;
      }
      try {
        const result = service.queryLogs(req.query as Record<string, unknown>, { defaultLimit: 50, maxLimit: 100 });
        const requestId = safeGetRequestId(res);
        const correlationId = safeGetCorrelationId(res);
        res.json({
          ...result,
          requestId,
          ...(correlationId !== undefined && { correlationId }),
        });
      } catch (error) {
        const requestId = safeGetRequestId(res);
        const correlationId = safeGetCorrelationId(res);
        res.status(400).json({ 
          error: (error as Error).message,
          requestId,
          ...(correlationId !== undefined && { correlationId }),
        });
      }
    },
  );

  /**
   * GET /api/v1/audit/export
   */
  router.get('/export', ...accessMiddleware, ...exportMiddleware, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const parsed = parseAuditQueryOrRespond(req, res, { maxLimit: 50000 });
    if (!parsed) {
      return;
    }

    let exportResult: AuditExportResult | undefined;

    try {
      const actor = (req as Request & { user?: { id?: string } }).user?.id ?? 'anonymous';
      const correlationId = safeGetCorrelationId(res);

      exportResult = await service.exportAuditLogs(
        req.query as Record<string, unknown>,
        { actor, ipAddress: req.ip, correlationId },
        exportService,
      );

      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${exportResult.fileName}"`);
      res.setHeader('X-Audit-Export-Records', String(exportResult.recordCount));

      await pipeline(exportResult.openReadStream(), res);
    } catch (error) {
      if (!res.headersSent) {
        const status = (error as Error).message.startsWith('Invalid ') ? 400 : 500;
        const requestId = safeGetRequestId(res);
        const correlationId = safeGetCorrelationId(res);
        res.status(status).json({ 
          error: (error as Error).message,
          requestId,
          ...(correlationId !== undefined && { correlationId }),
        });
      } else {
        next(error);
      }
    } finally {
      if (exportResult) {
        await exportResult.cleanup();
      }
    }
  });

  /**
   * GET /api/v1/audit/integrity
   */
  router.get('/integrity', ...accessMiddleware, ...integrityMiddleware, (_req: Request, res: Response): void => {
    const { report, status } = service.checkIntegrity();
    const requestId = safeGetRequestId(res);
    const correlationId = safeGetCorrelationId(res);
    res.status(status).json({
      ...report,
      requestId,
      ...(correlationId !== undefined && { correlationId }),
    });
  });

  /**
   * GET /api/v1/audit/:id
   */
  router.get('/:id', ...accessMiddleware, (req: Request, res: Response): void => {
    const entry = service.getEntry(req.params['id'] ?? '');
    if (!entry) {
      const requestId = safeGetRequestId(res);
      const correlationId = safeGetCorrelationId(res);
      res.status(404).json({ 
        error: 'Audit entry not found',
        requestId,
        ...(correlationId !== undefined && { correlationId }),
      });
      return;
    }
    res.json(toAuditEntryResponseDto(entry));
  });

  return router;
}

export const auditRouter = createAuditRouter();