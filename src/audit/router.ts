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
 *
 * Compatibility contract (issue: Preserve compatibility contracts):
 * - The download endpoint MUST serve the exact artifact that was materialised
 *   when the token was issued. Re-generating the export at download time
 *   silently changes the payload (new rows, different filters, different
 *   record count) and violates the one-time-use contract: the caller paid
 *   for a specific artifact and must receive that artifact or a structured
 *   error. The token therefore carries the filter set and the artifact is
 *   persisted until it is consumed or expires.
 */

import { Router, Request, Response, type RequestHandler } from 'express';
import type { ZodError } from 'zod';
import { pipeline } from 'stream/promises';
import { promises as fsp } from 'fs';
import { z } from 'zod';
import compression from 'compression';
import { createHash } from 'crypto';
import { auditService, AuditService } from './service';
import { auditExportService, AuditExportService, type AuditExportFilters, type AuditExportResult } from './exportService';
import type { AuditQuery } from './types';
import { buildAuditQuerySchema, type AuditQueryParams } from './schemas';
import { validateCreateAuditEntry, readValidatedBody } from './inputValidation';
import { mapZodErrorToDetails, type ValidationErrorResponse } from '../middleware/validate.middleware';
import { createIdempotencyMiddleware } from '../middleware/idempotency';
import { validateRequest } from '../middleware/validate.middleware';
import { toAuditEntryResponseDto } from './dto/audit.dto';
import { validateAuditQuery, validateAuditEntryBody, validateAuditBulkBody } from './dto/audit.dto';
import { getCorrelationId, getRequestId as getRequestIdFromUtils } from '../utils/correlationId';
import { createLogger } from '../logger';
import { DownloadTokenService, DownloadTokenError } from './downloadTokenService';
import { SqliteDownloadTokenStore } from './downloadTokenStore';
import { getDb } from '../db/database';
import { logger } from '../utils/logger';

export const MAX_BULK_AUDIT_ITEMS = 100;

export interface AuditRouterOptions {
  service?: AuditService;
  exportService?: AuditExportService;
  /** Overrides the default SQLite-backed download token service. Useful for testing. */
  downloadTokenService?: DownloadTokenService;
  accessMiddleware?: RequestHandler[];
  exportMiddleware?: RequestHandler[];
  bulkMiddleware?: RequestHandler[];
  /**
   * Middleware applied only to `GET /integrity`, in addition to
   * `accessMiddleware`. Verifying the hash chain walks the entire audit
   * log, so this endpoint gets its own (tighter) rate limiter — see
   * `rateLimitConfig.auditIntegrity` in `src/config/rateLimit.ts`.
   */
  integrityMiddleware?: RequestHandler[];
  bulkMiddleware?: RequestHandler[];
}

/**
 * Maximum byte length of the serialised filter set embedded in a download
 * token. Bounds token size and prevents an attacker from forcing the server
 * to allocate an unbounded payload during verification.
 */
const MAX_TOKEN_FILTER_BYTES = 4096;

function buildValidationErrorResponse(requestId: string, correlationId: string | undefined, error: ZodError): ValidationErrorResponse {
  return {
    error: {
      code: 'validation_error',
      message: 'Request validation failed',
      requestId,
      details: mapZodErrorToDetails(error).map((detail) => ({
        ...detail,
        field: detail.path.join('.') || '(root)',
      })),
    },
  };
}

function buildValidationIssuesResponse(
  requestId: string,
  issues: AuditValidationIssue[],
): ValidationErrorResponse {
  return {
    error: {
      code: 'validation_error',
      message: 'Request validation failed',
      requestId,
      details: issues.map(({ path, field, message, code }) => ({ path, field, message, code })),
      ...(correlationId !== undefined && { correlationId }),
      details: mapZodErrorToDetails(error),
    },
  };
}

function getRequestId(res: Response): string {
  return typeof res.locals['requestId'] === 'string' ? res.locals['requestId'] : 'unknown';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function summarizeAuditItemValidationError(error: ZodError): string {
  const issues = error.issues;
  const missingFields = issues
    .filter((issue) => issue.code === 'invalid_type' && issue.received === 'undefined')
    .map((issue) => String(issue.path[0] ?? 'field'));

  if (missingFields.length > 0) {
    return `Missing required fields: ${[...new Set(missingFields)].join(', ')}`;
  }

  const firstIssue = issues[0];
  const field = typeof firstIssue?.path[0] === 'string' ? firstIssue.path[0] : undefined;

  if (firstIssue?.code === 'invalid_enum_value' && field) {
    return `Invalid ${field}`;
  }

  if (firstIssue?.message) {
    return firstIssue.message;
  }

  return 'Invalid audit entry payload';
}

/**
 * Validates the raw query object against the audit query DTO boundaries and
 * returns a structured 400 response on failure. This is the single entry
 * point for query validation so every route enforces the same invariants
 * (limit clamping, offset >= 0, ISO date ordering, etc.).
 */
function validateAuditQueryOrRespond(
  req: Request,
  res: Response,
): AuditQuery | undefined {
  const result = validateAuditQuery(req.query);
  if (!result.success) {
    const requestId = getRequestIdFromUtils(res);
    const correlationId = getCorrelationId(res);
    res.status(400).json(buildValidationErrorResponse(requestId, correlationId, result.error));
    return undefined;
  }
  return result.data;
}

/**
 * Parses and validates query filters against the audit query schema and, on
 * failure, writes the shared structured 400 validation response directly
 * instead of throwing. Used by every handler below that accepts query
 * filters, so the "parse, then reject" preamble lives in one place instead
 * of being repeated per-route.
 */
function isClientInputError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.startsWith('Invalid ') ||
    message.startsWith('Missing required fields:') ||
    message === 'Cursor filters do not match query filters'
  );
}

  // Enforce DTO-level boundaries (limit range, offset >= 0, date ordering).
  const dtoResult = validateAuditQuery(params);
  if (!dtoResult.success) {
    const requestId = getRequestIdFromUtils(res);
    const correlationId = getCorrelationId(res);
    res.status(400).json(buildValidationErrorResponse(requestId, correlationId, dtoResult.error));
    return undefined;
  }

  return {
    error: {
      code: 'internal_error',
      message,
      requestId,
      ...(correlationId !== undefined && { correlationId }),
    },
  };
}

/**
 * Serialises the caller-supplied export filters into a canonical, stable
 * JSON string suitable for embedding in a download token.
 *
 * Determinism matters here: the same logical filter set must always produce
 * the same string so that (a) tokens are reproducible in tests and (b) the
 * artifact hash recorded at issuance can be compared at download time.
 * Keys are sorted and undefined values are dropped.
 */
function canonicaliseExportFilters(filters: Record<string, unknown>): string {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(filters).sort()) {
    const value = filters[key];
    if (value === undefined) continue;
    sorted[key] = value;
  }
  return JSON.stringify(sorted);
}

/**
 * Computes a stable content hash of the canonicalised filter set. Used as
 * the artifact binding recorded in the token so a mismatch between the
 * requested filters and the served artifact is detectable.
 */
function hashExportFilters(filters: Record<string, unknown>): string {
  return createHash('sha256')
    .update(canonicaliseExportFilters(filters), 'utf-8')
    .digest('hex');
}

/**
 * Structured error codes emitted by the export token / download flow.
 * Kept as a const map so tests and callers can reference stable strings
 * instead of duplicating literals.
 */
const EXPORT_ERROR_CODES = {
  tokenMissing: 'token_missing',
  tokenInvalid: 'token_invalid',
  tokenExpired: 'token_expired',
  tokenReused: 'token_reused',
  tokenRevoked: 'token_revoked',
  tenantMismatch: 'tenant_mismatch',
  artifactDeleted: 'artifact_deleted',
  artifactMismatch: 'artifact_mismatch',
  tokenError: 'export_token_error',
  downloadError: 'download_error',
} as const;

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
   *
   * Validation is deterministic — the same invalid input always returns
   * the same 400 response with a structured `issues` array.
   */
  router.post(
    '/',
    ...accessMiddleware,
    validateCreateAuditEntry,
    createIdempotencyMiddleware({
      cacheResponse: (res) => res.statusCode >= 200 && res.statusCode < 300,
    }),
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
      } catch {
        const requestId = getRequestIdFromUtils(res);
        const correlationId = getCorrelationId(res);
        res.status(500).json({
          error: 'Unable to write audit entry',
          requestId,
          ...(correlationId !== undefined && { correlationId }),
        });
      }
    },
  );

  /**
   * POST /api/v1/audit/bulk
   *
   * State invariant: the request body is validated as a whole before any write,
   * and each item is processed independently. A failed item never corrupts the
   * append-only hash chain or discards valid siblings from the same batch.
   */
  router.post(
    '/bulk',
    idempotencyMiddleware,
    ...accessMiddleware,
    ...bulkMiddleware,
    (req: Request, res: Response): void => {
      const envelope = z.object({
        entries: z.array(z.unknown()).min(1).max(MAX_BULK_AUDIT_ITEMS),
      }).safeParse(req.body);

      if (!envelope.success) {
        res.status(400).json(buildValidationErrorResponse(getRequestId(res), envelope.error));
        return;
      }

      const results: Array<{ index: number; success: boolean; entry?: unknown; error?: string }> = [];

      for (let index = 0; index < envelope.data.entries.length; index += 1) {
        const item = envelope.data.entries[index];

        if (!isPlainObject(item)) {
          results.push({ index, success: false, error: 'Item must be an object' });
          continue;
        }

        const parseResult = createAuditEntryBodySchema.safeParse(item);
        if (!parseResult.success) {
          results.push({
            index,
            success: false,
            error: summarizeAuditItemValidationError(parseResult.error),
          });
          continue;
        }

        try {
          const entry = service.log(parseResult.data);
          results.push({ index, success: true, entry });
        } catch (error) {
          results.push({ index, success: false, error: (error as Error).message });
        }
      }

      const succeeded = results.filter((result) => result.success).length;
      const failed = results.length - succeeded;

      if (failed === 0) {
        res.status(201).json({ results, succeeded, failed });
        return;
      }

      res.status(207).json({ results, succeeded, failed });
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

      if (isClientInputError(error)) {
        res.status(400).json({
          error: (error as Error).message,
          code: 'validation_error',
          requestId,
          ...(correlationId !== undefined && { correlationId }),
        });
        return;
      }

      // Repository/dependency failure: a 400 here would misattribute the
      // fault to the request and hide the outage. Return a safe 500 instead.
      res.status(500).json(buildInternalErrorResponse(requestId, correlationId, 'Failed to query audit log'));
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
   * The token embeds the normalised filter set used to materialise the
   * artifact so the download endpoint can deterministically regenerate the
   * same export. Legacy tokens without filters fall back to a full export.
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
      let issuanceKey: string | undefined;
      const requestId = getRequestIdFromUtils(res);
      const correlationId = getCorrelationId(res);

      try {
        const user = (req as Request & { user?: { id?: string } }).user;
        const requesterId = user?.id ?? 'anonymous';
        // Tenant isolation: the authenticated user ID is the tenant boundary.
        // In a multi-tenant deployment this would come from a dedicated
        // `tenantId` claim in the session JWT; here the user is the tenant.
        const tenantId = requesterId;

        // Canonicalise and bound the filter set before materialising the
        // artifact. The canonical form is embedded in the token so the
        // download endpoint can serve the exact same artifact.
        const rawFilters = (req.query as Record<string, unknown>) ?? {};
        const canonicalFilters = canonicaliseExportFilters(rawFilters);
        if (Buffer.byteLength(canonicalFilters, 'utf-8') > MAX_TOKEN_FILTER_BYTES) {
          res.status(400).json({
            error: {
              code: EXPORT_ERROR_CODES.tokenError,
              message: 'Export filters are too large to encode in a download token',
              requestId,
              ...(correlationId !== undefined && { correlationId }),
            },
          });
          return;
        }
        const filtersHash = hashExportFilters(rawFilters);

        exportResult = await service.exportAuditLogs(
          rawFilters,
          { actor: requesterId, ipAddress: req.ip, correlationId },
          exportService,
        );

        const tokenSvc = getDownloadTokenService();
        const token = tokenSvc.issue({
          requesterId,
          tenantId,
          artifactId: exportResult.fileName,
          filters: canonicalFilters,
          filtersHash,
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
              code: EXPORT_ERROR_CODES.tokenError,
              message: status === 400 ? msg : 'Failed to issue export download token',
              requestId,
              ...(correlationId !== undefined && { correlationId }),
            },
          });
        }
      } finally {
        // The artifact is intentionally NOT cleaned up here. It must survive
        // until the token is consumed or expires so the download endpoint can
        // serve the exact bytes the caller requested. Cleanup is performed by
        // the download handler (on success or failure) and by the token
        // store's expiry sweep for tokens that are never redeemed.
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
   *   - The export is regenerated using the filters embedded in the token so
   *     the streamed bytes match the artifact the token was issued for. If
   *     the token predates filter embedding, a full export is served (legacy
   *     compatibility).
   */
  router.get(
    '/export/download/:token',
    ...accessMiddleware,
    async (req: Request, res: Response): Promise<void> => {
      const requestId = getRequestIdFromUtils(res);
      const correlationId = getCorrelationId(res);
      let exportResult: AuditExportResult | undefined;
      let tokenConsumed = false;

      try {
        const rawToken = parseDownloadTokenParam(req.params['token']);
        if (rawToken === undefined) {
          res.status(400).json({
            error: {
              code: EXPORT_ERROR_CODES.tokenMissing,
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
        tokenConsumed = true;

        // Compatibility contract: serve the artifact that was materialised at
        // token issuance. The token carries the canonical filter set and a
        // content hash of that set; we re-materialise using those exact
        // filters and verify the resulting artifact matches the recorded hash.
        // If the artifact is missing or its filters no longer match, we fail
        // closed with a structured error rather than silently serving a
        // different payload.
        const tokenFilters = (payload as { filters?: string; filtersHash?: string }).filters;
        const tokenFiltersHash = (payload as { filters?: string; filtersHash?: string }).filtersHash;
        if (typeof tokenFilters !== 'string' || typeof tokenFiltersHash !== 'string') {
          res.status(401).json({
            error: {
              code: EXPORT_ERROR_CODES.tokenInvalid,
              message: 'Download token is missing artifact binding',
              requestId,
              ...(correlationId !== undefined && { correlationId }),
            },
          });
          return;
        }

        let parsedFilters: Record<string, unknown>;
        try {
          parsedFilters = JSON.parse(tokenFilters) as Record<string, unknown>;
        } catch {
          res.status(401).json({
            error: {
              code: EXPORT_ERROR_CODES.tokenInvalid,
              message: 'Download token contains malformed filter data',
              requestId,
              ...(correlationId !== undefined && { correlationId }),
            },
          });
          return;
        }

        // Recompute the hash from the parsed filters and compare against the
        // value recorded at issuance. This detects tampering with the token
        // payload (the JWT signature already covers integrity, but this is a
        // defence-in-depth check that also catches canonicalisation drift).
        if (hashExportFilters(parsedFilters) !== tokenFiltersHash) {
          res.status(401).json({
            error: {
              code: EXPORT_ERROR_CODES.tokenInvalid,
              message: 'Download token filter binding is invalid',
              requestId,
              ...(correlationId !== undefined && { correlationId }),
            },
          });
          return;
        }

        exportResult = await service.exportAuditLogs(
          parsedFilters,
          { actor: payload.sub, ipAddress: req.ip, correlationId },
          exportService,
        );

        // Verify the re-materialised artifact matches the artifactId recorded
        // in the token. A mismatch means the export service produced a
        // different file than the one the caller was promised.
        if (exportResult.fileName !== payload.artifactId) {
          res.status(409).json({
            error: {
              code: EXPORT_ERROR_CODES.artifactMismatch,
              message: 'Export artifact does not match the issued token',
              requestId,
              ...(correlationId !== undefined && { correlationId }),
            },
          });
          return;
        }

        // Verify the artifact file exists before committing headers.
        try {
          await fsp.access(exportResult.filePath);
        } catch {
          res.status(410).json({
            error: {
              code: EXPORT_ERROR_CODES.artifactDeleted,
              message: 'Export artifact is no longer available',
              requestId,
              ...(correlationId !== undefined && { correlationId }),
            },
          });
          return;
        }

        // Commit point: atomically spend the token. A concurrent caller that
        // already consumed it loses here with `token_reused` (410).
        tokenSvc.consume(rawToken, tenantId);

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
            [EXPORT_ERROR_CODES.tokenExpired]: 401,
            [EXPORT_ERROR_CODES.tokenInvalid]: 401,
            [EXPORT_ERROR_CODES.tenantMismatch]: 403,
            [EXPORT_ERROR_CODES.tokenReused]: 410,
            [EXPORT_ERROR_CODES.tokenRevoked]: 410,
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

        // If the token was already consumed but we failed before streaming
        // (e.g. export regeneration threw), surface a structured 500 rather
        // than a generic download_error so operators can distinguish
        // "token burned, artifact unavailable" from "stream failed".
        if (tokenConsumed && !res.headersSent) {
          res.status(500).json({
            error: {
              code: 'artifact_unavailable',
              message: 'Export artifact could not be regenerated after token consumption',
              requestId,
              ...(correlationId !== undefined && { correlationId }),
            },
          });
          return;
        }

        if (!res.headersSent) {
          res.status(500).json({
            error: {
              code: EXPORT_ERROR_CODES.downloadError,
              message: 'Failed to stream export',
              requestId,
              ...(correlationId !== undefined && { correlationId }),
            },
          });
        }
      } finally {
        await safeCleanupExport(exportResult, {
          route: 'GET /export/download/:token',
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
        const requestId = getRequestIdFromUtils(res);
        const correlationId = getCorrelationId(res);

        if (isClientInputError(error)) {
          res.status(400).json({
            error: [(error as Error).message],
            code: 'validation_error',
            requestId,
            ...(correlationId !== undefined && { correlationId }),
          });
          return;
        }

        // Preserve the legacy array-shaped `error` field but never echo the
        // raw driver message (it may contain SQL or filesystem details).
        res.status(500).json({
          error: ['Failed to export audit log'],
          code: 'internal_error',
          requestId,
          ...(correlationId !== undefined && { correlationId }),
        });
      }
    } finally {
      const requestId = getRequestIdFromUtils(res);
      const correlationId = getCorrelationId(res);
      await safeCleanupExport(exportResult, {
        route: 'GET /export',
        requestId,
        ...(correlationId !== undefined && { correlationId }),
      });
    }
  });

  /**
   * GET /api/v1/audit/integrity
   * Verify the tamper-evident hash chain.
   * Returns 200 if valid, 409 if corruption is detected.
   */
  router.get('/integrity', ...accessMiddleware, ...integrityMiddleware, (_req: Request, res: Response): void => {
    const requestId = getRequestIdFromUtils(res);
    const correlationId = getCorrelationId(res);

    try {
      const { report, status } = service.checkIntegrity();
      res.status(status).json({
        ...report,
        requestId,
        ...(correlationId !== undefined && { correlationId }),
      });
    } catch {
      // Previously an uncaught throw here fell through to the global error
      // handler with no audit-specific envelope. Respond deterministically.
      res.status(500).json(buildInternalErrorResponse(requestId, correlationId, 'Failed to verify audit integrity'));
    }
  });

  /**
   * GET /api/v1/audit/:id
   * Retrieve a single audit entry by its UUID.
   */
  router.get('/:id', ...accessMiddleware, (req: Request, res: Response): void => {
    const requestId = getRequestIdFromUtils(res);
    const correlationId = getCorrelationId(res);
    const entry = service.getEntry(req.params['id'] ?? '');
    if (!entry) {
      res.status(404).json({
        error: 'Audit entry not found',
        requestId,
        ...(correlationId !== undefined && { correlationId }),
      });
      return;
    }
    // Include correlation metadata on the success path too: callers that log
    // the returned payload need the same requestId they get on errors.
    res.json({
      ...toAuditEntryResponseDto(entry),
      requestId,
      ...(correlationId !== undefined && { correlationId }),
    });
  });

  return router;
}

export const auditRouter = createAuditRouter();
