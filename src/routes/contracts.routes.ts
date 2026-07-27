import { Router, Request, Response, NextFunction } from 'express';
import compression from 'compression';

import { createContractsController } from '../controllers/contracts.controller';
import { createContractsBulkController } from '../controllers/contracts-bulk.controller';
import { createMilestonesSoftDeleteController } from '../controllers/milestones.softdelete.controller';
import { ContractsService } from '../services/contracts.service';
import { ContractCacheService, DEFAULT_CACHE_TTL_MS, DEFAULT_CACHE_SWR_MS, DEFAULT_CACHE_MAX_ENTRIES } from '../services/contractCache.service';
import { ContractRepository } from '../repositories/contractRepository';
import { getDb } from '../db/database';
import { validateSchema } from '../middleware/validate.middleware';
import { createRateLimiter } from '../middleware/rateLimiter';
import { rateLimitConfig } from '../config/rateLimit';
import {
  createContractSchema,
  contractIdParamSchema,
  contractQuerySchema,
  bulkMilestonesSchema,
} from '../modules/contracts/dto/contract.dto';
import { bulkCreateContractsSchema } from '../modules/contracts/dto/bulk-operations.dto';
import {
  createMilestoneSchema,
  milestoneIdParamSchema,
  milestonesQuerySchema,
} from '../modules/contracts/dto/milestones.dto';
import { validateUpdateContract } from '../modules/contracts/validation.middleware';
import { contractCreateIdempotencyMiddleware } from '../middleware/contractIdempotency';
import { requireAuth, requirePermission } from '../middleware/authorization';
import { validateRequest, validateParams, validateQuery } from '../middleware/validate.middleware';
import type { MetricsServiceLike } from '../observability/metrics-service';

// ─── Inline route-param validator ────────────────────────────────────────────

/**
 * Validates the `:id` route parameter against contractIdParamSchema.
 *
 * Returns 400 with a structured `validation_error` response when:
 *  - `id` is empty
 *  - `id` exceeds CONTRACT_ID_MAX_LENGTH
 *
 * This guard runs before any DB query so oversized or clearly-invalid IDs
 * never reach the repository layer.
 */
function validateContractId(req: Request, res: Response, next: NextFunction): void {
  const result = contractIdParamSchema.safeParse(req.params);
  if (!result.success) {
    const requestId =
      typeof res.locals.requestId === 'string' ? res.locals.requestId : 'unknown';
    res.status(400).json({
      error: {
        code: 'validation_error',
        message: 'Request validation failed',
        requestId,
        details: result.error.issues.map((issue) => ({
          path: issue.path.map(String),
          message: issue.message,
          code: issue.code,
        })),
      },
    });
    return;
  }
  next();
}

  // ─── Inline query-param validator ────────────────────────────────────────────

/**
 * Validates query parameters on GET /api/v1/contracts against contractQuerySchema.
 *
 * Validates and strips unknown query keys (e.g. `admin`, `debug`) before the
 * controller sees them. Returns 400 with a structured `validation_error` response
 * when:
 *  - `page` or `limit` is not a positive integer, or limit exceeds QUERY_LIMIT_MAX
 *  - `status`, `sortBy`, or `sortOrder` is not a recognised enum value
 *  - `clientId` or `freelancerId` is not a valid UUID
 *
 * After validation, `req.query` is replaced with only the recognised keys
 * (unknown keys are stripped), preserving string types so the controller's
 * own parsers (e.g. parsePaginationQuery) continue to work correctly.
 */
function validateContractQuery(req: Request, res: Response, next: NextFunction): void {
  const result = contractQuerySchema.safeParse(req.query);
  if (!result.success) {
    const requestId =
      typeof res.locals.requestId === 'string' ? res.locals.requestId : 'unknown';
    res.status(400).json({
      error: {
        code: 'validation_error',
        message: 'Request validation failed',
        requestId,
        details: result.error.issues.map((issue) => ({
          path: issue.path.map(String),
          message: issue.message,
          code: issue.code,
        })),
      },
    });
    return;
  }

  // Strip unknown keys: rebuild req.query with only the keys that appeared in
  // the validated result, keeping original string values so downstream parsers
  // (e.g. parsePaginationQuery) receive the raw strings they expect.
  const knownKeys = Object.keys(result.data) as Array<keyof typeof result.data>;
  const stripped: Record<string, string | string[] | undefined> = {};
  for (const key of knownKeys) {
    const raw = req.query[key];
    if (raw !== undefined) {
      stripped[key] = raw as string | string[];
    }
  }
  req.query = stripped as typeof req.query;
  next();
}

// ─── Router factory ───────────────────────────────────────────────────────────

/**
 * Creates the contracts router with injected dependencies.
 * DB acquisition happens here at route registration time,
 * not at module import time.
 *
 * @param metricsService - Optional metrics service for recording milestone
 *   operation counters and durations. When omitted the controller operates
 *   without metrics instrumentation (e.g. in unit tests).
 */
function createContractsRouter(metricsService?: MetricsServiceLike): Router {
  const router = Router();

  // Enable compression for large payloads (e.g. milestones arrays)
  // The threshold is 1KB by default, but we set it explicitly here.
  router.use(compression({ threshold: 1024 }));

  const db = getDb();
  const repo = new ContractRepository(db);
  const controller = createContractsController(new ContractsService(repo), metricsService);
  const milestonesSoftDelete = createMilestonesSoftDeleteController();
  const bulkController = createContractsBulkController(new ContractsService(repo));

  /**
   * Resolves the owner (clientId) of a contract from the DB.
   * Used by requirePermission for ownOnly PATCH and DELETE checks.
   * Returns null when the contract does not exist (triggers 404).
   */
  const getContractOwnerId = async (req: any): Promise<string | null> => {
    const contract = await repo.findById(req.params?.id ?? '');
    return contract ? contract.clientId : null;
  };

  // ─── Rate limiter ───────────────────────────────────────────────────────────
  // Per-client rate limiting using X-API-Key if available, otherwise client IP.
  // Applied before auth to protect server resources from unauthenticated abuse.
  const milestonesLimiter = createRateLimiter({
    ...rateLimitConfig.milestones,
    keyFn: (req) => {
      const apiKey = req.headers['x-api-key'];
      if (apiKey) {
        const key = Array.isArray(apiKey) ? apiKey[0] : apiKey;
        return `milestones:apikey:${key}`;
      }
      const xff = req.headers['x-forwarded-for'];
      if (xff) {
        const first = Array.isArray(xff) ? xff[0] : (xff as string).split(',')[0];
        return `milestones:ip:${first.trim()}`;
      }
      return `milestones:ip:${req.ip ?? req.socket?.remoteAddress ?? 'unknown'}`;
    },
  });
  router.use(milestonesLimiter);

  // GET /bounds — public-facing bounds, still requires auth
  /** @permission contracts:read — admin, client (ownOnly), freelancer (ownOnly) */
  router.get('/bounds', requireAuth, requirePermission('contracts', 'read'), controller.getBounds);

  // GET /stats — aggregate statistics
  /** @permission contracts:list — admin, client (ownOnly), freelancer (ownOnly) */
  router.get('/stats', requireAuth, requirePermission('contracts', 'list'), controller.getContractStats);

  // GET / — list all contracts (with query-param validation)
  /** @permission contracts:list — admin, client (ownOnly), freelancer (ownOnly) */
  router.get(
    '/',
    requireAuth,
    requirePermission('contracts', 'list'),
    validateContractQuery,
    controller.getContracts,
  );

  // GET /:id/history — fetch contract event history (param validation first)
  // TODO: Implement getContractHistory in controller
  // router.get('/:id/history', validateContractId, controller.getContractHistory);

  // GET /:id — fetch single contract (param validation before auth to reject clearly invalid IDs)
  /** @permission contracts:read — admin, client (ownOnly), freelancer (ownOnly) */
  router.get(
    '/:id',
    validateContractId,
    requireAuth,
    requirePermission('contracts', 'read', getContractOwnerId),
    controller.getContractById,
  );

  // GET /:id/milestones — list milestones (soft-deleted excluded by default)
  /** @permission contracts:read — admin, client (ownOnly), freelancer (ownOnly) */
  router.get(
    '/:id/milestones',
    validateContractId,
    validateQuery(milestonesQuerySchema),
    requireAuth,
    requirePermission('contracts', 'read', getContractOwnerId),
    milestonesSoftDelete.list.bind(milestonesSoftDelete),
  );

  // POST /:id/milestones — create a milestone record (active)
  /** @permission contracts:update (ownOnly) — admin, client, freelancer */
  router.post(
    '/:id/milestones',
    validateContractId,
    validateRequest(createMilestoneSchema),
    requireAuth,
    requirePermission('contracts', 'update', getContractOwnerId),
    milestonesSoftDelete.create.bind(milestonesSoftDelete),
  );

  // POST /:id/milestones/:milestoneId/restore — restore within retention window
  /** @permission contracts:update (ownOnly) — admin, client, freelancer */
  router.post(
    '/:id/milestones/:milestoneId/restore',
    validateContractId,
    validateParams(milestoneIdParamSchema),
    requireAuth,
    requirePermission('contracts', 'update', getContractOwnerId),
    milestonesSoftDelete.restore.bind(milestonesSoftDelete),
  );

  // DELETE /:id/milestones/:milestoneId — soft-delete (mark deleted_at, do not purge)
  /** @permission contracts:update (ownOnly) — admin, client, freelancer */
  router.delete(
    '/:id/milestones/:milestoneId',
    validateContractId,
    validateParams(milestoneIdParamSchema),
    requireAuth,
    requirePermission('contracts', 'update', getContractOwnerId),
    milestonesSoftDelete.softDelete.bind(milestonesSoftDelete),
  );

  // GET /:id/milestones/audit-log — bounded, cursor-paginated audit trail
  // (actor, action, before/after summary, timestamp) for milestone writes on
  // this contract. Same visibility as reading the contract itself.
  // TODO: Implement getMilestonesAuditLog in controller
  /** @permission contracts:read — admin, client (ownOnly), freelancer (ownOnly) */
  // router.get(
  //   '/:id/milestones/audit-log',
  //   validateContractId,
  //   requireAuth,
  //   requirePermission('contracts', 'read', getContractOwnerId),
  //   controller.getMilestonesAuditLog,
  // );

  /**
   * POST /api/v1/contracts
   * Supports Idempotency-Key to safely retry contract creation without creating duplicates.
   */
  router.post(
    '/',
    requireAuth,
    requirePermission('contracts', 'create'),
    contractCreateIdempotencyMiddleware(),
    validateSchema(createContractSchema),
    controller.createContract,
  );

  /**
   * POST /api/v1/contracts/bulk
   * Bulk create contracts endpoint.
   * 
   * Request: Array of contract creation payloads (each validated separately)
   * Response: Per-item results with summary (always 200, check per-item status for failures)
   * 
   * - Each item is validated and processed independently
   * - One item's failure does not affect other items
   * - Batch size is capped at BULK_OPERATION_MAX_BATCH_SIZE (100)
   * - Empty batch is rejected as a validation error
   */
  router.post(
    '/bulk',
    requireAuth,
    requirePermission('contracts', 'create'),
    validateSchema(bulkCreateContractsSchema),
    bulkController.bulkCreateContracts,
  );

  // PATCH /:id — update an existing contract (owner or admin only)
  // validateContractId runs before auth to reject clearly invalid :id params early.
  // Idempotency-Key support added for milestones write safety.
  /** @permission contracts:update (ownOnly for client/freelancer) — admin, client, freelancer */
  router.patch(
    '/:id',
    validateContractId,
    requireAuth,
    requirePermission('contracts', 'update', getContractOwnerId),
    contractCreateIdempotencyMiddleware(),
    validateUpdateContract,
    controller.updateContract,
  );

  // DELETE /:id — delete a contract (admin only per PERMISSION_MATRIX)
  // validateContractId runs before auth to reject clearly invalid :id params early.
  /** @permission contracts:delete — admin only */
  router.delete(
    '/:id',
    validateContractId,
    requireAuth,
    requirePermission('contracts', 'delete', getContractOwnerId),
    controller.deleteContract,
  );

  return router;
}

export { createContractsRouter };
export default createContractsRouter();
