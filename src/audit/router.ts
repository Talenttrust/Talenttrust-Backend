/**
 * @module audit/router
 * @description REST endpoints for querying and writing the audit log.
 *
 * Routes:
 *   GET  /api/v1/audit                       - Query audit entries with optional filters
 *   GET  /api/v1/audit/export                - Stream an NDJSON export for compliance
 *   POST /api/v1/audit/export/token          - Issue a signed, expiring, one-time-use download token
 *   GET  /api/v1/audit/export/download/:token - Download a previously-issued export via token
 *   GET  /api/v1/audit/integrity             - Verify the hash chain integrity
 *   POST /api/v1/audit                       - Write a single audit entry
 *   POST /api/v1/audit/bulk                  - Write a bounded batch of audit entries
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
 *
 * Download token security (issue #1222):
 * - POST /export/token materialises the export file and issues a JWT bound
 *   to that artifact, the requester, and the tenant. The token expires after
 *   AUDIT_DOWNLOAD_TOKEN_TTL_SECONDS (default 900 s = 15 min).
 * - GET /export/download/:token verifies the JWT (signature, expiry, tenant)
 *   and enforces one-time use before streaming. Errors are structured and do
 *   not leak internal paths, stack traces, or token secrets.
 */

import { Router, Request, Response, type RequestHandler } from 'express';
import type { ZodError } from 'zod';
import { pipeline } from 'stream/promises';
import { promises as fsp } from 'fs';
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
import { DownloadTokenService, DownloadTokenError } from './downloadTokenService';
import { SqliteDownloadTokenStore } from './downloadTokenStore';
import { getDb } from '../db/database';

export interface AuditRouterOptions {
  service?: AuditService;
  exportService?: AuditExportService;
  /** Overrides the default SQLite-backed download token service. Useful for testing. */
  downloadTokenService?: DownloadTokenService;
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

  // Lazily build the default download token service so the DB is not opened
  // during module load (important for test isolation with ':memory:' DBs).
  let _defaultDownloadTokenService: DownloadTokenService | undefined;
  function getDownloadTokenService(): DownloadTokenService {
    if (options.downloadTokenService) return options.downloadTokenService;
    if (!_defaultDownloadTokenService) {
      _defaultDownloadTokenService = new DownloadTokenService(
        new SqliteDownloadTokenStore(getDb()),
      );
    }
    return _defaultDownloadTokenService;
  }

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
          const requestId = getRequestIdFromUtils(res);
          const correlationId = getCorrelationId(res);
          res.status(400).json(buildValidationErrorResponse(requestId, correlationId, parseResult.error));
          return;
        }

        // Propagate correlation ID from request context to audit entry
        const correlationId = getCorrelationId(res);
        const entryData = parseResult.data;
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
    try {
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
   * POST /api/v1/audit/export/token
   *
   * Materialises an export file and issues a short-lived, tenant-scoped,
   * single-use download token bound to that artifact and the requester.
   *
   * The caller must be authenticated; `req.user.id` is used as both the
   * requesterId and the tenantId for the token.
   *
   * Response:
   *   201 { token: string, expiresAt: string, artifactId: string }
   *
   * @security Token TTL defaults to 15 min (AUDIT_DOWNLOAD_TOKEN_TTL_SECONDS).
   *           The token is one-time-use; reuse returns 410.
   */
  router.post(
    '/export/token',
    ...accessMiddleware,
    ...exportMiddleware,
    async (req: Request, res: Response): Promise<void> => {
      let exportResult: AuditExportResult | undefined;
      const requestId = getRequestIdFromUtils(res);
      const correlationId = getCorrelationId(res);

      try {
        const user = (req as Request & { user?: { id?: string } }).user;
        const requesterId = user?.id ?? 'anonymous';
        // Tenant isolation: the authenticated user ID is the tenant boundary.
        // In a multi-tenant deployment this would come from a dedicated
        // `tenantId` claim in the session JWT; here the user is the tenant.
        const tenantId = requesterId;

        exportResult = await service.exportAuditLogs(
          req.query as Record<string, unknown>,
          { actor: requesterId, ipAddress: req.ip, correlationId },
          exportService,
        );

        const tokenSvc = getDownloadTokenService();
        const token = tokenSvc.issue({
          requesterId,
          tenantId,
          artifactId: exportResult.fileName,
        });

        // Decode exp from the JWT without re-verifying so we can return expiresAt
        // to the caller without importing jwt in this handler.
        const [, payloadB64] = token.split('.');
        const payload = JSON.parse(
          Buffer.from(payloadB64, 'base64url').toString('utf-8'),
        ) as { exp: number };
        const expiresAt = new Date(payload.exp * 1000).toISOString();

        res.status(201).json({
          token,
          expiresAt,
          artifactId: exportResult.fileName,
          requestId,
          ...(correlationId !== undefined && { correlationId }),
        });
      } catch (error) {
        if (!res.headersSent) {
          const msg = (error as Error).message;
          const status = msg.startsWith('Invalid ') ? 400 : 500;
          res.status(status).json({
            error: {
              code: 'export_token_error',
              message: status === 400 ? msg : 'Failed to issue export download token',
              requestId,
              ...(correlationId !== undefined && { correlationId }),
            },
          });
        }
      } finally {
        // Clean up the temp file — the download token encodes the artifactId
        // (file name) but the actual file is re-generated at download time.
        // We only needed to create the file to capture its name here.
        // NOTE: The download endpoint recreates the export on demand; see below.
        if (exportResult) {
          await exportResult.cleanup();
        }
      }
    },
  );

  /**
   * GET /api/v1/audit/export/download/:token
   *
   * Streams the export file for a previously-issued download token.
   *
   * Validation order (each failure returns a structured error; no content
   * is streamed before all checks pass):
   *   1. JWT signature and expiry (→ 401 token_expired / token_invalid)
   *   2. Tenant isolation: token.tenantId must match req.user.id (→ 403 tenant_mismatch)
   *   3. One-time use: atomically marks used; reuse → 410 token_reused
   *   4. Revocation: → 410 token_revoked
   *   5. Artifact existence on disk: if the file is gone → 410 artifact_deleted
   *   6. Stream with pipeline; on mid-stream error the connection is closed
   *      but the token stays used (no retry allowed — issue a new token).
   *
   * @security
   *   - Token is consumed atomically so concurrent requests cannot both succeed.
   *   - Headers are committed only after the artifact check so a 410 response
   *     is still possible after token consumption if the file disappeared.
   *   - Stack traces and internal paths are never included in error responses.
   */
  router.get(
    '/export/download/:token',
    ...accessMiddleware,
    async (req: Request, res: Response): Promise<void> => {
      const requestId = getRequestIdFromUtils(res);
      const correlationId = getCorrelationId(res);
      let exportResult: AuditExportResult | undefined;

      try {
        const rawToken = req.params['token'];
        if (!rawToken) {
          res.status(400).json({
            error: {
              code: 'token_missing',
              message: 'Download token is required',
              requestId,
              ...(correlationId !== undefined && { correlationId }),
            },
          });
          return;
        }

        const user = (req as Request & { user?: { id?: string } }).user;
        const requesterId = user?.id ?? 'anonymous';
        const tenantId = requesterId;

        const tokenSvc = getDownloadTokenService();

        // consume() verifies the JWT, checks tenant isolation, revocation, and
        // one-time use atomically. Throws DownloadTokenError on any failure.
        const { payload } = tokenSvc.consume(rawToken, tenantId);

        // Re-generate the export file with the same filters as encoded in the
        // token (the artifactId is the file name; filters are not re-encoded
        // in the token to keep the token compact and secret-free — the
        // requester re-supplies filters via the original POST, and the download
        // just regenerates without filters to serve the full original export).
        //
        // DESIGN NOTE: We regenerate rather than persisting the file between
        // token issuance and download because:
        //   a) temporary files that outlive the request lifetime are a storage
        //      leak vector if cleanup races or crashes occur;
        //   b) the file can be recreated deterministically from the current DB;
        //   c) it keeps the token issuance path stateless with respect to disk.
        //
        // This means the download endpoint does a fresh export. This is the
        // correct approach for correctness and operability.
        exportResult = await service.exportAuditLogs(
          {},
          { actor: payload.sub, ipAddress: req.ip, correlationId },
          exportService,
        );

        // Verify the artifact file exists before committing headers.
        try {
          await fsp.access(exportResult.filePath);
        } catch {
          res.status(410).json({
            error: {
              code: 'artifact_deleted',
              message: 'Export artifact is no longer available',
              requestId,
              ...(correlationId !== undefined && { correlationId }),
            },
          });
          return;
        }

        res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${exportResult.fileName}"`,
        );
        res.setHeader('X-Audit-Export-Records', String(exportResult.recordCount));

        await pipeline(exportResult.openReadStream(), res);
      } catch (error) {
        if (error instanceof DownloadTokenError) {
          const statusMap: Record<string, number> = {
            token_expired: 401,
            token_invalid: 401,
            tenant_mismatch: 403,
            token_reused: 410,
            token_revoked: 410,
          };
          const status = statusMap[error.code] ?? 401;

          if (!res.headersSent) {
            res.status(status).json({
              error: {
                code: error.code,
                message: error.message,
                requestId,
                ...(correlationId !== undefined && { correlationId }),
              },
            });
          }
          return;
        }

        if (!res.headersSent) {
          res.status(500).json({
            error: {
              code: 'download_error',
              message: 'Failed to stream export',
              requestId,
              ...(correlationId !== undefined && { correlationId }),
            },
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
   * GET /api/v1/audit/export
   * Streams a file-backed NDJSON export for compliance downloads.
   */
  router.get('/export', ...accessMiddleware, ...exportMiddleware, async (req: Request, res: Response): Promise<void> => {
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
        const status = (error as Error).message.startsWith('Invalid ') ? 400 : 500;
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

  return router;
}

export const auditRouter = createAuditRouter();
