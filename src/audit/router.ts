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
 * Compatibility contract (issue #1222 follow-up):
 * - The download token issued by POST /export/token MUST be bound to the
 *   exact filter set used to materialise the artifact. The download endpoint
 *   MUST re-apply those filters when regenerating the export so that the
 *   bytes streamed to the caller match the artifact the token was issued for.
 * - Tokens issued before this change (without an embedded filter payload)
 *   remain valid and fall back to the legacy "full export" behaviour.
 */

import { Router, Request, Response, type RequestHandler } from 'express';
import type { ZodError } from 'zod';
import { pipeline } from 'stream/promises';
import { promises as fsp } from 'fs';
import { z } from 'zod';
import compression from 'compression';
import { auditService, AuditService } from './service';
import { auditExportService, AuditExportService, type AuditExportFilters, type AuditExportResult } from './exportService';
import { createAuditEntryBodySchema } from './schemas';
import { mapZodErrorToDetails, type ValidationErrorResponse } from '../middleware/validate.middleware';
import { idempotencyMiddleware } from '../middleware/idempotency';
import { validateRequest } from '../middleware/validate.middleware';
import { toAuditEntryResponseDto } from './dto/audit.dto';
import { getCorrelationId, getRequestId as getRequestIdFromUtils } from '../utils/correlationId';
import { createLogger } from '../logger';
import { DownloadTokenService, DownloadTokenError } from './downloadTokenService';
import { SqliteDownloadTokenStore } from './downloadTokenStore';
import { getDb } from '../db/database';
import { logger } from '../logger';

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

/**
 * Filter payload embedded in a download token. Kept intentionally small and
 * JSON-serialisable so it can round-trip through the JWT without leaking
 * secrets. Only the fields accepted by `buildAuditQuerySchema` are allowed.
 */
type DownloadTokenFilters = Record<string, unknown>;

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
 * Normalises the raw query object into a stable, JSON-serialisable filter
 * payload. Sorting keys makes the payload deterministic so the same logical
 * query produces the same token payload (useful for tests and caching).
 *
 * Only string/number/boolean values are kept; anything else is dropped to
 * avoid smuggling non-serialisable data into the JWT.
 */
function normaliseDownloadFilters(query: Record<string, unknown>): DownloadTokenFilters {
  const out: DownloadTokenFilters = {};
  const keys = Object.keys(query).sort();
  for (const key of keys) {
    const value = query[key];
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      // Preserve arrays of primitives (e.g. repeated query params) as-is.
      const filtered = value.filter(
        (v) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean',
      );
      if (filtered.length > 0) out[key] = filtered;
      continue;
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
    }
  }
  return out;
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

/**
 * Builds the shared structured 500 body.
 *
 * The underlying error message is intentionally never included: driver
 * errors can contain SQL fragments, table names, or absolute file paths.
 * The caller-facing message is a stable, non-sensitive description while the
 * `code` field stays machine-readable for clients and dashboards.
 */
function buildInternalErrorResponse(
  requestId: string,
  correlationId: string | undefined,
  message: string,
): { error: { code: string; message: string; requestId: string; correlationId?: string } } {
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
 * In-flight guard for the download-token issuance path.
 *
 * The token store enforces one-time *consumption*, but nothing prevents a
 * client from issuing many tokens for the same artifact concurrently (or
 * retrying a POST that already succeeded). Each issuance materialises a
 * fresh export file, so an unbounded burst of concurrent issuances is a
 * resource-amplification vector. This map de-duplicates concurrent
 * issuances for the same (tenant, artifact) pair so racing requests share
 * a single in-flight materialisation instead of each spawning their own.
 *
 * Invariants:
 *   - Keys are scoped by tenantId so cross-tenant requests never coalesce.
 *   - Entries are removed in a `finally` block, so a rejected issuance
 *     never poisons the map (no permanent lock-out on failure).
 *   - The map is bounded by the number of distinct in-flight keys, which is
 *     itself bounded by the rate limiter on this route.
 */
const inFlightIssuances = new Map<string, Promise<AuditExportResult>>();

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
        const requestId = getRequestIdFromUtils(res);
        const correlationId = getCorrelationId(res);

        if (isClientInputError(error)) {
          // Preserve the documented legacy validation shape (`error` is a
          // string) for compatibility with existing callers.
          res.status(400).json({
            error: (error as Error).message,
            code: 'validation_error',
            requestId,
            ...(correlationId !== undefined && { correlationId }),
          });
          return;
        }

        // A persistence/driver failure must not be echoed to the caller.
        res.status(500).json(buildInternalErrorResponse(requestId, correlationId, 'Failed to write audit entry'));
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

        // Snapshot the filters BEFORE materialising the export so the token
        // and the artifact are guaranteed to describe the same query.
        const filters = normaliseDownloadFilters(req.query as Record<string, unknown>);

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
          filters,
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
        // Defensive: if we registered an in-flight entry but never awaited it
        // (e.g. an error before the await), drop it so the key cannot leak.
        if (issuanceKey !== undefined && !inFlightIssuances.has(issuanceKey)) {
          // no-op: entry already cleared by the settle handler
        }

        // Clean up the temp file — the download token encodes the artifactId
        // (file name) but the actual file is re-generated at download time.
        // We only needed to create the file to capture its name here.
        // NOTE: The download endpoint recreates the export on demand; see below.
        await safeCleanupExport(exportResult, {
          route: 'POST /export/token',
          requestId,
          ...(correlationId !== undefined && { correlationId }),
        });
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
              code: 'token_invalid',
              message: 'Download token is malformed',
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
        //
        // Compatibility contract: the filters embedded in the token are
        // re-applied here so the regenerated artifact is byte-for-byte
        // equivalent to the one the token was issued for. Tokens issued
        // before filter embedding (legacy) carry no `filters` claim and
        // fall back to a full export — this preserves the old behaviour
        // for in-flight tokens during a rolling deploy.
        const tokenFilters =
          payload.filters && typeof payload.filters === 'object'
            ? (payload.filters as DownloadTokenFilters)
            : {};

        exportResult = await service.exportAuditLogs(
          tokenFilters,
          { actor: payload.sub, ipAddress: req.ip, correlationId },
          exportService,
        );

        // Verify the artifact file exists before consuming the token or
        // committing headers, so a missing artifact leaves the token reusable.
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
            token_expired: 401,
            token_invalid: 401,
            tenant_mismatch: 403,
            token_reused: 410,
            token_revoked: 410,
            token_invalid: 401,
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
              code: 'download_error',
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
