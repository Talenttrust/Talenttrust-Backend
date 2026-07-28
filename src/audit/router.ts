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
 *
 * Security notes:
 * - In production these routes MUST be protected by authentication and
 *   role-based authorisation (admin/auditor roles only).
 * - Query parameters are validated and clamped to prevent abuse.
 * - All routes are rate-limited per client (issue #746): `accessMiddleware`
 *   carries the general `audit` tier, `/export` additionally gets the
 *   `auditExport` tier via `exportMiddleware`, `/integrity` additionally
 *   gets the stricter `auditIntegrity` tier via `integrityMiddleware`, and
 *   `/bulk` additionally gets the `auditBulk` tier via `bulkMiddleware` —
 *   see `rateLimitConfig` in `src/config/rateLimit.ts`.
 */

import { Router, Request, Response, NextFunction, type RequestHandler } from 'express';
import type { ZodError } from 'zod';
import { pipeline } from 'stream/promises';
import { z } from 'zod';
import compression from 'compression';
import { auditService, AuditService } from './service';
import { auditExportService, AuditExportService, type AuditExportFilters } from './exportService';
import type { AuditQuery, CreateAuditEntryInput } from './types';
import { buildAuditQuerySchema, createAuditEntryBodySchema, type AuditQueryParams } from './schemas';
import { mapZodErrorToDetails, type ValidationErrorResponse } from '../middleware/validate.middleware';
import { idempotencyMiddleware } from '../middleware/idempotency';
import { toAuditEntryResponseDto } from './dto/audit.dto';

/**
 * Maximum number of audit entries accepted in a single bulk request.
 * Requests exceeding this cap are rejected with 400 before any item is processed.
 */
export const MAX_BULK_AUDIT_ITEMS = 500;

export interface AuditRouterOptions {
  service?: AuditService;
  exportService?: AuditExportService;
  accessMiddleware?: RequestHandler[];
  exportMiddleware?: RequestHandler[];
  /**
   * Middleware applied only to `GET /integrity`, in addition to
   * `accessMiddleware`. Verifying the hash chain walks the entire audit
   * log, so this endpoint gets its own (tighter) rate limiter — see
   * `rateLimitConfig.auditIntegrity` in `src/config/rateLimit.ts`.
   */
  integrityMiddleware?: RequestHandler[];
  bulkMiddleware?: RequestHandler[];
}

function buildValidationErrorResponse(requestId: string, error: ZodError): ValidationErrorResponse {
  return {
    error: {
      code: 'validation_error',
      message: 'Request validation failed',
      requestId,
      details: mapZodErrorToDetails(error),
    },
  };
}

function getRequestId(res: Response): string {
  return typeof res.locals['requestId'] === 'string' ? res.locals['requestId'] : 'unknown';
}

/**
 * Parses and validates query filters against the audit query schema and, on
 * failure, writes the shared structured 400 validation response directly
 * instead of throwing. Used by every handler below that accepts query
 * filters, so the "parse, then reject" preamble lives in one place instead
 * of being repeated per-route.
 */
function parseAuditQueryOrRespond(
  req: Request,
  res: Response,
  options: { defaultLimit?: number; maxLimit: number },
): { query: AuditQuery; limit?: number; offset: number } | undefined {
  const result = buildAuditQuerySchema(options).safeParse(req.query);

  if (!result.success) {
    res.status(400).json(buildValidationErrorResponse(getRequestId(res), result.error));
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
   *
   * Write an audit entry with idempotency support.
   * Accepts an Idempotency-Key header to prevent duplicate entries.
   */
  router.post(
    '/',
    idempotencyMiddleware,
    ...accessMiddleware,
    (req: Request, res: Response): void => {
      try {
        const parseResult = createAuditEntryBodySchema.safeParse(req.body);

        if (!parseResult.success) {
          res.status(400).json(buildValidationErrorResponse(getRequestId(res), parseResult.error));
          return;
        }

        const entry = service.log(parseResult.data);
        res.status(201).json(entry);
      } catch (error) {
        const message = (error as Error).message;
        const status = message.startsWith('Missing required fields:') ? 400 : 500;
        res.status(status).json({ error: message });
      }
    },
  );

  /**
   * POST /api/v1/audit/bulk
   *
   * Write a bounded batch of audit entries in a single request.
   * - All items are validated individually; the batch proceeds regardless of
   *   per-item failures (partial-failure semantics).
   * - Responds 201 when every item succeeded, 207 when any item failed.
   * - Supports Idempotency-Key to prevent duplicate batch processing.
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
      // Validate the outer envelope first.
      const envelopeResult = bulkEnvelopeSchema.safeParse(req.body);
      if (!envelopeResult.success) {
        res.status(400).json(buildValidationErrorResponse(getRequestId(res), envelopeResult.error));
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

        // Use the Zod schema to validate action/severity enums and required fields.
        const itemResult = createAuditEntryBodySchema.safeParse(rawItem);
        if (!itemResult.success) {
          failed += 1;
          // Map Zod issue to a human-readable message matching existing error conventions.
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
   * Query audit entries with optional filters and pagination.
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
        res.json(result);
      } catch (error) {
        res.status(400).json({ error: (error as Error).message });
      }
    },
  );

  /**
   * GET /api/v1/audit/export
   * Streams a file-backed NDJSON export for compliance downloads.
   */
  router.get('/export', ...accessMiddleware, ...exportMiddleware, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const parsed = parseAuditQueryOrRespond(req, res, { maxLimit: 50000 });
    if (!parsed) {
      return;
    }

    let exportResult: AuditExportResult | undefined;

    try {
      const actor = (req as Request & { user?: { id?: string } }).user?.id ?? 'anonymous';
      const correlationId = typeof res.locals['requestId'] === 'string'
        ? res.locals['requestId']
        : undefined;

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
        res.status(status).json({ error: (error as Error).message });
      } else {
        // Headers already sent — delegate to Express error handler to close the socket cleanly.
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
   * Verify the tamper-evident hash chain.
   * Returns 200 if valid, 409 if corruption is detected.
   */
  router.get('/integrity', ...accessMiddleware, ...integrityMiddleware, (_req: Request, res: Response): void => {
    const { report, status } = service.checkIntegrity();
    res.status(status).json(report);
  });

  /**
   * GET /api/v1/audit/:id
   * Retrieve a single audit entry by its UUID.
   */
  router.get('/:id', ...accessMiddleware, (req: Request, res: Response): void => {
    const entry = service.getEntry(req.params['id'] ?? '');
    if (!entry) {
      res.status(404).json({ error: 'Audit entry not found' });
      return;
    }
    res.json(toAuditEntryResponseDto(entry));
  });

  return router;
}

export const auditRouter = createAuditRouter();
