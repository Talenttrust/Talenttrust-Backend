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
import { pipeline } from 'stream/promises';
import { z } from 'zod';
import compression from 'compression';
import { auditService, AuditService } from './service';
import { auditExportService, AuditExportService, type AuditExportResult } from './exportService';
import type { AuditQuery } from './types';
import { buildAuditQuerySchema, type AuditQueryParams } from './schemas';
import { validateRequest } from '../middleware/validate.middleware';
import { idempotencyMiddleware } from '../middleware/idempotency';
import { toAuditEntryResponseDto, toIntegrityReportResponseDto } from './dto/audit.dto';
import { getCorrelationId, getRequestId as getRequestIdFromUtils, isValidCorrelationId } from '../utils/correlationId';
import { validateCreateAuditEntry, readValidatedBody } from './inputValidation';
import { AUDIT_MESSAGES, AUDIT_DEFAULTS, AUDIT_ACTIONS, AUDIT_SEVERITIES } from '../constants/audit';
import type { BulkAuditItemResult, CreateAuditEntryInput } from './types';
import { createAuditObservabilityMiddleware } from '../observability/audit-observability';
import type { MetricsServiceLike } from '../observability/metrics-service';
import type { Logger } from '../logger';

function getRequestIdSafe(res: Response): string {
  try {
    return getRequestIdFromUtils(res);
  } catch {
    const val = res.locals['requestId'] as string | undefined;
    return typeof val === 'string' && val.length > 0 ? val : 'unknown';
  }
}

function getCorrelationIdSafe(res: Response, req?: Request): string | undefined {
  const fromLocals = getCorrelationId(res);
  if (fromLocals !== undefined) return fromLocals;
  if (req?.headers) {
    const headerVal = req.headers['x-correlation-id'] || req.headers['X-Correlation-ID'];
    if (typeof headerVal === 'string' && isValidCorrelationId(headerVal)) {
      return headerVal;
    }
  }
  return undefined;
}

function getRequestIdForEnvelope(res: Response): string | undefined {
  const val = res.locals['requestId'] as string | undefined;
  return typeof val === 'string' && val.length > 0 ? val : undefined;
}

/** Hard cap on the number of items accepted by a single `POST /bulk` request. */
export const MAX_BULK_AUDIT_ITEMS = 100;

const bulkAuditRequestSchema = z.object({
  entries: z
    .array(z.unknown())
    .min(1, 'entries must contain at least 1 item')
    .max(MAX_BULK_AUDIT_ITEMS, `entries must not exceed ${MAX_BULK_AUDIT_ITEMS} items`),
});

function validateBulkAuditItem(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return 'Item must be an object';
  }

  const input = raw as Partial<CreateAuditEntryInput>;

  if (!input.action || !input.severity || !input.actor || !input.resource || !input.resourceId) {
    return 'Missing required fields: action, severity, actor, resource, resourceId';
  }

  const validActions = new Set(Object.values(AUDIT_ACTIONS));
  if (!validActions.has(input.action as any)) {
    return `Invalid action: ${String(input.action)}`;
  }

  const validSeverities = new Set(Object.values(AUDIT_SEVERITIES));
  if (!validSeverities.has(input.severity as any)) {
    return `Invalid severity: ${String(input.severity)}`;
  }

  return undefined;
}

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
  metricsService?: Pick<MetricsServiceLike, 'recordAuditRequest'>;
  log?: Pick<Logger, 'info' | 'warn' | 'error'>;
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
    const reqId = getRequestIdForEnvelope(res);
    const requestId = getRequestIdSafe(res);
    const correlationId = getCorrelationIdSafe(res, req);
    const issues = result.error.issues.map((issue) => ({
      path: issue.path.map(String),
      field: issue.path.join('.') || '(root)',
      code: issue.code,
      message: issue.message,
    }));
    res.status(400).json({
      error: {
        code: 'validation_error',
        message: AUDIT_MESSAGES.VALIDATION_FAILED,
        requestId,
        ...(correlationId !== undefined && { correlationId }),
        details: issues,
      },
      ...(reqId !== undefined && { requestId: reqId }),
      ...(correlationId !== undefined && { correlationId }),
    });
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
  router.use(
    createAuditObservabilityMiddleware({
      metricsService: options.metricsService,
      log: options.log,
    }),
  );
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
        const correlationId = getCorrelationIdSafe(res, req);
        const entryData = readValidatedBody(res);
        if (correlationId && !entryData.correlationId) {
          entryData.correlationId = correlationId;
        }

        const entry = service.log(entryData);
        const reqId = getRequestIdForEnvelope(res);
        res.status(201).json({
          ...entry,
          ...(reqId !== undefined && { requestId: reqId }),
        });
      } catch (error) {
        const message = (error as Error).message;
        const status = message.startsWith('Missing required fields:') ? 400 : 500;
        const reqId = getRequestIdForEnvelope(res);
        const correlationId = getCorrelationIdSafe(res, req);
        res.status(status).json({
          error: message,
          ...(reqId !== undefined && { requestId: reqId }),
          ...(correlationId !== undefined && { correlationId }),
        });
      }
    },
  );

  /**
   * POST /api/v1/audit/bulk
   * Write a bounded batch of audit entries in one request.
   */
  router.post(
    '/bulk',
    idempMiddleware,
    ...accessMiddleware,
    ...bulkMiddleware,
    validateRequest(bulkAuditRequestSchema),
    (req: Request, res: Response): void => {
      const { entries } = req.body as { entries: unknown[] };

      const results: BulkAuditItemResult[] = entries.map((raw, index) => {
        const validationError = validateBulkAuditItem(raw);
        if (validationError) {
          return { index, success: false, error: validationError };
        }

        try {
          const entry = service.log(raw as CreateAuditEntryInput);
          return { index, success: true, entry };
        } catch (error) {
          return { index, success: false, error: (error as Error).message };
        }
      });

      const failed = results.filter((result) => !result.success).length;
      const succeeded = results.length - failed;
      const status = failed === 0 ? 201 : 207;

      res.status(status).json({ results, succeeded, failed });
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
        const result = service.queryLogs(req.query as Record<string, unknown>, {
          defaultLimit: 50,
          maxLimit: 100,
        });
        const reqId = getRequestIdForEnvelope(res);
        const correlationId = getCorrelationIdSafe(res, req);
        res.json({
          ...result,
          ...(reqId !== undefined && { requestId: reqId }),
          ...(correlationId !== undefined && { correlationId }),
        });
      } catch (error) {
        const requestId = getRequestIdSafe(res);
        const correlationId = getCorrelationIdSafe(res, req);
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
   * Streams a file-backed NDJSON export for compliance downloads.
   */
  router.get(
    '/export',
    ...accessMiddleware,
    ...exportMiddleware,
    async (req: Request, res: Response): Promise<void> => {
      const parsed = parseAuditQueryOrRespond(req, res, { maxLimit: 50_000 });
      if (!parsed) return;

      let exportResult: AuditExportResult | undefined;

      try {
        const actor =
          (req as Request & { user?: { id?: string } }).user?.id ??
          AUDIT_DEFAULTS.ANONYMOUS_ACTOR;
        const correlationId = getCorrelationIdSafe(res, req);

        exportResult = await service.exportAuditLogs(
          req.query as Record<string, unknown>,
          { actor, ipAddress: req.ip, correlationId },
          exportService,
        );

        res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${exportResult.fileName}"`,
        );
        res.setHeader('X-Audit-Export-Records', String(exportResult.recordCount));

        await pipeline(exportResult.openReadStream(), res);
      } catch (error) {
        if (!res.headersSent) {
          const status = (error as Error).message.startsWith('Invalid ') ? 400 : 500;
          const requestId = getRequestIdSafe(res);
          const correlationId = getCorrelationIdSafe(res, req);
          res.status(status).json({
            error: (error as Error).message,
            requestId,
            ...(correlationId !== undefined && { correlationId }),
          });
        }
      } finally {
        if (exportResult) {
          await exportResult.cleanup();
        }
      }
    },
  );

  /**
   * GET /api/v1/audit/integrity
   * Verify the tamper-evident hash chain.
   * Returns 200 if valid, 409 if corruption is detected.
   */
  router.get(
    '/integrity',
    ...accessMiddleware,
    ...integrityMiddleware,
    (req: Request, res: Response): void => {
      try {
        const { report, status } = service.checkIntegrity();
        const reqId = getRequestIdForEnvelope(res);
        const correlationId = getCorrelationIdSafe(res, req);
        res.status(status).json({
          ...toIntegrityReportResponseDto(report),
          ...(reqId !== undefined && { requestId: reqId }),
          ...(correlationId !== undefined && { correlationId }),
        });
      } catch (error) {
        console.error('GET /integrity error:', error);
        const requestId = getRequestIdSafe(res);
        const correlationId = getCorrelationIdSafe(res, req);
        res.status(500).json({
          error: (error as Error).message,
          requestId,
          ...(correlationId !== undefined && { correlationId }),
        });
      }
    },
  );

  /**
   * GET /api/v1/audit/:id
   * Retrieve a single audit entry by its UUID.
   */
  router.get('/:id', ...accessMiddleware, (req: Request, res: Response): void => {
    try {
      const entry = service.getEntry(req.params['id'] ?? '');
      const correlationId = getCorrelationIdSafe(res, req);
      if (!entry) {
        const reqId = getRequestIdForEnvelope(res);
        res.status(404).json({
          error: AUDIT_MESSAGES.NOT_FOUND,
          ...(reqId !== undefined && { requestId: reqId }),
          ...(correlationId !== undefined && { correlationId }),
        });
        return;
      }
      const reqId = getRequestIdForEnvelope(res);
      res.json({
        ...toAuditEntryResponseDto(entry),
        ...(reqId !== undefined && { requestId: reqId }),
      });
    } catch (error) {
      console.error('GET /:id error:', error);
      const requestId = getRequestIdSafe(res);
      const correlationId = getCorrelationIdSafe(res, req);
      res.status(500).json({
        error: (error as Error).message,
        requestId,
        ...(correlationId !== undefined && { correlationId }),
      });
    }
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
      const actor = (req as Request & { user?: { id?: string } }).user?.id ?? AUDIT_DEFAULTS.ANONYMOUS_ACTOR;
      const correlationId = getCorrelationIdSafe(res, req);
      const ipAddress = req.ip;

      const payload = req.body;
      const entry = service.updateEntry(req.params['id'] ?? '', payload, { actor, ipAddress, correlationId });
      res.json(toAuditEntryResponseDto(entry));
    } catch (error) {
      const status = (error as Error).message === AUDIT_MESSAGES.NOT_FOUND ? 404 : 400;
      const requestId = getRequestIdSafe(res);
      const correlationId = getCorrelationIdSafe(res, req);
      res.status(status).json({ 
        error: (error as Error).message,
        requestId,
        ...(correlationId !== undefined && { correlationId }),
      });
    }
  });

/**
 * DELETE /api/v1/audit/:id
 * Soft-delete an audit entry.
 */
  router.delete('/:id', ...accessMiddleware, (req: Request, res: Response): void => {
    const success = service.softDelete(req.params['id'] ?? '');
    if (!success) {
      res.status(404).json({ error: AUDIT_MESSAGES.NOT_FOUND_OR_DELETED });
      return;
    }
    res.json({ success: true });
  });

/**
 * POST /api/v1/audit/:id/restore
 * Restore a soft-deleted audit entry.
 */
  router.post('/:id/restore', ...accessMiddleware, (req: Request, res: Response): void => {
    try {
      const success = service.restore(req.params['id'] ?? '', 30); // 30 days default
      if (!success) {
        res.status(404).json({ error: AUDIT_MESSAGES.NOT_FOUND_OR_NOT_SOFT_DELETED });
        return;
      }
      res.json({ success: true });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

/**
 * POST /api/v1/audit/maintenance/purge
 * Permanently purge expired soft-deleted audit entries.
 */
  router.post('/maintenance/purge', ...accessMiddleware, (req: Request, res: Response): void => {
    try {
      const count = service.purgeExpiredAuditLogs(30);
      res.json({ success: true, purgedCount: count });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  return router;
}

export const auditRouter = createAuditRouter();
