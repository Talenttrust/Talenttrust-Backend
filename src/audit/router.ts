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

import { Router, Request, Response, type RequestHandler } from 'express';
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
import { validateRequest } from '../middleware/validate.middleware';
import { toAuditEntryResponseDto } from './dto/audit.dto';
import { getCorrelationId, getRequestId as getRequestIdFromUtils } from '../utils/correlationId';
import { validateCreateAuditEntry, readValidatedBody } from './inputValidation';

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
  idempotencyMiddleware?: RequestHandler;
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
    const requestId = getRequestIdFromUtils(res);
    const correlationId = getCorrelationId(res);
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
  const idempMiddleware = options.idempotencyMiddleware ?? idempotencyMiddleware;

  /**
   * POST /api/v1/audit
   *
   * Write an audit entry with idempotency support.
   * Accepts an Idempotency-Key header to prevent duplicate entries.
   */
  router.post(
    '/',
    ...accessMiddleware,
    validateCreateAuditEntry,
    idempMiddleware,
    (req: Request, res: Response): void => {
      try {
        // Propagate correlation ID from request context to audit entry
        const correlationId = getCorrelationId(res);
        const entryData = readValidatedBody(res);
        if (correlationId && !entryData.correlationId) {
          entryData.correlationId = correlationId;
        }

        const entry = service.log(entryData);
        res.status(201).json(entry);
      } catch (error) {
        const message = (error as Error).message;
        const status = message.startsWith('Missing required fields:') ? 400 : 500;
        const requestId = getRequestIdFromUtils(res);
        const correlationId = getCorrelationId(res);
        res.status(status).json({ 
          error: message,
          requestId,
          ...(correlationId !== undefined && { correlationId }),
        });
      }
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
    if (!parsed) return;

    try {
      // Just pass the original query string, but we know it's valid now
      // Alternatively pass parsed.query but queryLogs expects Record<string, unknown>
      const result = service.queryLogs(req.query as Record<string, unknown>, { defaultLimit: 50, maxLimit: 100 });
      const requestId = getRequestIdFromUtils(res);
      const correlationId = getCorrelationId(res);
      res.json({
        ...result,
        requestId,
        ...(correlationId !== undefined && { correlationId }),
      });
    } catch (error) {
      const requestId = getRequestIdFromUtils(res);
      const correlationId = getCorrelationId(res);
      res.status(400).json({ 
        error: (error as Error).message,
        requestId,
        ...(correlationId !== undefined && { correlationId }),
      });
    }
  });

  /**
   * GET /api/v1/audit/export
   * Streams a file-backed NDJSON export for compliance downloads.
   */
  router.get('/export', ...accessMiddleware, ...exportMiddleware, async (req: Request, res: Response): Promise<void> => {
    const parsed = parseAuditQueryOrRespond(req, res, { maxLimit: 50_000 });
    if (!parsed) return;

    let exportResult: AuditExportResult | undefined;

    try {
      const actor = (req as Request & { user?: { id?: string } }).user?.id ?? 'anonymous';
      const correlationId = getCorrelationId(res);

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
        console.error("EXPORT ERROR:", error); const status = (error as Error).message.startsWith('Invalid ') ? 400 : 500;
        const requestId = getRequestIdFromUtils(res);
        const correlationId = getCorrelationId(res);
        res.status(status).json({ 
          error: [(error as Error).message],
          requestId,
          ...(correlationId !== undefined && { correlationId }),
        });
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
    const requestId = getRequestIdFromUtils(res);
    const correlationId = getCorrelationId(res);
    res.status(status).json({
      ...report,
      requestId,
      ...(correlationId !== undefined && { correlationId }),
    });
  });

  /**
   * GET /api/v1/audit/:id
   * Retrieve a single audit entry by its UUID.
   */
  router.get('/:id', ...accessMiddleware, (req: Request, res: Response): void => {
    const entry = service.getEntry(req.params['id'] ?? '');
    if (!entry) {
      const requestId = getRequestIdFromUtils(res);
      const correlationId = getCorrelationId(res);
      res.status(404).json({ 
        error: 'Audit entry not found',
        requestId,
        ...(correlationId !== undefined && { correlationId }),
      });
      return;
    }
    res.json(toAuditEntryResponseDto(entry));
  });

  /**
   * GET /api/v1/audit/:id/mutations
   * Retrieve mutations (create, update, delete) for a specific audit entry.
   */
  router.get('/:id/mutations', ...accessMiddleware, (req: Request, res: Response): void => {
    const mutations = service.getMutations(req.params['id'] ?? '');
    res.json(mutations.map(toAuditEntryResponseDto));
  });

  /**
   * PUT /api/v1/audit/:id
   * Update an audit entry and append an AUDIT_UPDATED mutation log.
   */
  router.put('/:id', ...accessMiddleware, (req: Request, res: Response): void => {
    try {
      const actor = (req as Request & { user?: { id?: string } }).user?.id ?? 'anonymous';
      const correlationId = getCorrelationId(res);
      const ipAddress = req.ip;

      const payload = req.body;
      const entry = service.updateEntry(req.params['id'] ?? '', payload, { actor, ipAddress, correlationId });
      res.json(toAuditEntryResponseDto(entry));
    } catch (error) {
      const status = (error as Error).message === 'Audit entry not found' ? 404 : 400;
      const requestId = getRequestIdFromUtils(res);
      const correlationId = getCorrelationId(res);
      res.status(status).json({ 
        error: (error as Error).message,
        requestId,
        ...(correlationId !== undefined && { correlationId }),
      });
    }
  });

  /**
   * DELETE /api/v1/audit/:id
   * Delete an audit entry and append an AUDIT_DELETED mutation log.
   */
  router.delete('/:id', ...accessMiddleware, (req: Request, res: Response): void => {
    try {
      const actor = (req as Request & { user?: { id?: string } }).user?.id ?? 'anonymous';
      const correlationId = getCorrelationId(res);
      const ipAddress = req.ip;

      service.deleteEntry(req.params['id'] ?? '', { actor, ipAddress, correlationId });
      res.status(204).send();
    } catch (error) {
      const status = (error as Error).message === 'Audit entry not found' ? 404 : 400;
      const requestId = getRequestIdFromUtils(res);
      const correlationId = getCorrelationId(res);
      res.status(status).json({ 
        error: (error as Error).message,
        requestId,
        ...(correlationId !== undefined && { correlationId }),
      });
    }
  });

  return router;
}

export const auditRouter = createAuditRouter();
