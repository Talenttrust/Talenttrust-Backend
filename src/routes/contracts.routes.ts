import { payoutIdempotencyMiddleware } from "../middleware/payoutIdempotency";
import { Router, Request, Response, NextFunction } from "express";
import compression from "compression";

import { createContractsController } from "../controllers/contracts.controller";
import { createContractsBulkController } from "../controllers/contracts-bulk.controller";
import { createMilestonesSoftDeleteController } from "../controllers/milestones.softdelete.controller";
import { ContractsService } from "../services/contracts.service";
import { ContractRepository } from "../repositories/contractRepository";
import { getDb } from "../db/database";
import { validateSchema } from "../middleware/validate.middleware";
import { createRateLimiter } from "../middleware/rateLimiter";
import { rateLimitConfig } from "../config/rateLimit";
import {
  createContractSchema,
  contractIdParamSchema,
  contractQuerySchema,
} from "../modules/contracts/dto/contract.dto";
import { bulkCreateContractsSchema } from "../modules/contracts/dto/bulk-operations.dto";
import {
  createMilestoneSchema,
  milestoneIdParamSchema,
  milestonesQuerySchema,
} from "../modules/contracts/dto/milestones.dto";
import { updateContractSchema } from "../modules/contracts/dto/contract.dto";
import { contractCreateIdempotencyMiddleware } from "../middleware/contractIdempotency";
import { requireAuth, requirePermission } from "../middleware/authorization";
import {
  validateRequest,
  validateParams,
  validateQuery,
} from "../middleware/validate.middleware";
import type { MetricsServiceLike } from "../observability/metrics-service";
import { createContractsObservabilityMiddleware } from "../observability/contracts-observability";

/**
 * Creates the contracts router with injected dependencies.
 * DB acquisition happens here at route registration time,
 * not at module import time.
 *
 * @param metricsService - Optional metrics service for recording milestone
 *   operation counters and durations. When omitted the controller operates
 *   without metrics instrumentation (e.g. in unit tests).
 */
function createContractsRouter(
  metricsService?: MetricsServiceLike,
  customDb?: any,
): Router {
  const router = Router();

  // Enable compression for large payloads (e.g. milestones arrays)
  // The threshold is 1KB by default, but we set it explicitly here.
  router.use(compression({ threshold: 1024 }));
  router.use(createContractsObservabilityMiddleware({ metricsService }));

  const db = customDb ?? getDb();
  const repo = new ContractRepository(db);
  const service = new ContractsService(repo);
  const controller = createContractsController(service, metricsService);
  const milestonesSoftDelete = createMilestonesSoftDeleteController();
  const bulkController = createContractsBulkController(service);

  /**
   * Resolves the owner (clientId) of a contract from the DB.
   * Used by requirePermission for ownOnly PATCH and DELETE checks.
   * Returns null when the contract does not exist (triggers 404).
   */
  const getContractOwnerId = async (req: any): Promise<string | null> => {
    const contract = await repo.findById(req.params?.id ?? "");
    return contract ? contract.clientId : null;
  };

  // â”€â”€â”€ Rate limiter â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Per-client rate limiting using X-API-Key if available, otherwise client IP.
  // Applied before auth to protect server resources from unauthenticated abuse.
  const milestonesLimiter = createRateLimiter({
    ...rateLimitConfig.milestones,
    keyFn: (req) => {
      const apiKey = req.headers["x-api-key"];
      if (apiKey) {
        const key = Array.isArray(apiKey) ? apiKey[0] : apiKey;
        return `milestones:apikey:${key}`;
      }
      const xff = req.headers["x-forwarded-for"];
      if (xff) {
        const first = Array.isArray(xff)
          ? xff[0]
          : (xff as string).split(",")[0];
        return `milestones:ip:${first.trim()}`;
      }
      return `milestones:ip:${req.ip ?? req.socket?.remoteAddress ?? "unknown"}`;
    },
  });
  router.use(milestonesLimiter);

  // GET /bounds â€” public-facing bounds, still requires auth
  /** @permission contracts:read â€” admin, client (ownOnly), freelancer (ownOnly) */
  router.get(
    "/bounds",
    requireAuth,
    requirePermission("contracts", "read"),
    controller.getBounds,
  );

  // GET /stats â€” aggregate statistics
  /** @permission contracts:list â€” admin, client (ownOnly), freelancer (ownOnly) */
  router.get(
    "/stats",
    requireAuth,
    requirePermission("contracts", "list"),
    controller.getContractStats,
  );

  // GET / â€” list all contracts (with query-param validation)
  /** @permission contracts:list â€” admin, client (ownOnly), freelancer (ownOnly) */
  router.get(
    "/",
    requireAuth,
    requirePermission("contracts", "list"),
    validateQuery(contractQuerySchema),
    controller.getContracts,
  );

  // GET /:id/history â€” fetch contract event history (param validation first)
  // TODO: Implement getContractHistory in controller
  // router.get('/:id/history', validateParams(contractIdParamSchema), controller.getContractHistory);

  // GET /:id â€” fetch single contract (param validation before auth to reject clearly invalid IDs)
  /** @permission contracts:read â€” admin, client (ownOnly), freelancer (ownOnly) */
  router.get(
    "/:id",
    validateParams(contractIdParamSchema),
    requireAuth,
    requirePermission("contracts", "read", getContractOwnerId),
    controller.getContractById,
  );

  // GET /:id/milestones â€” list milestones (soft-deleted excluded by default)
  /** @permission contracts:read â€” admin, client (ownOnly), freelancer (ownOnly) */
  router.get(
    "/:id/milestones",
    validateParams(contractIdParamSchema),
    validateQuery(milestonesQuerySchema),
    requireAuth,
    requirePermission("contracts", "read", getContractOwnerId),
    milestonesSoftDelete.list.bind(milestonesSoftDelete),
  );

  // POST /:id/milestones â€” create a milestone record (active)
  /** @permission contracts:update (ownOnly) â€” admin, client, freelancer */
  router.post(
    "/:id/milestones",
    validateParams(contractIdParamSchema),
    validateRequest(createMilestoneSchema),
    requireAuth,
    requirePermission("contracts", "update", getContractOwnerId),
    milestonesSoftDelete.create.bind(milestonesSoftDelete),
  );

  // POST /:id/milestones/:milestoneId/restore â€” restore within retention window
  /** @permission contracts:update (ownOnly) â€” admin, client, freelancer */
  router.post(
    "/:id/milestones/:milestoneId/restore",
    validateParams(contractIdParamSchema),
    validateParams(milestoneIdParamSchema),
    requireAuth,
    requirePermission("contracts", "update", getContractOwnerId),
    milestonesSoftDelete.restore.bind(milestonesSoftDelete),
  );

  // DELETE /:id/milestones/:milestoneId â€” soft-delete (mark deleted_at, do not purge)
  /** @permission contracts:update (ownOnly) â€” admin, client, freelancer */
  router.delete(
    "/:id/milestones/:milestoneId",
    validateParams(contractIdParamSchema),
    validateParams(milestoneIdParamSchema),
    requireAuth,
    requirePermission("contracts", "update", getContractOwnerId),
    milestonesSoftDelete.softDelete.bind(milestonesSoftDelete),
  );

  // POST /:id/milestones/:milestoneId/payout ?" payout request
  /** @permission contracts:update (ownOnly) ?" admin, client, freelancer */
  router.post(
    "/:id/milestones/:milestoneId/payout",
    validateParams(contractIdParamSchema),
    validateParams(milestoneIdParamSchema),
    requireAuth,
    requirePermission("contracts", "update", getContractOwnerId),
    payoutIdempotencyMiddleware(),
    milestonesSoftDelete.payout.bind(milestonesSoftDelete),
  );
  // GET /:id/milestones/audit-log â€” bounded, cursor-paginated audit trail
  // (actor, action, before/after summary, timestamp) for milestone writes on
  // this contract. Same visibility as reading the contract itself.
  // TODO: Implement getMilestonesAuditLog in controller
  /** @permission contracts:read â€” admin, client (ownOnly), freelancer (ownOnly) */
  // router.get(
  //   '/:id/milestones/audit-log',
  //   validateParams(contractIdParamSchema),
  //   requireAuth,
  //   requirePermission('contracts', 'read', getContractOwnerId),
  //   controller.getMilestonesAuditLog,
  // );

  /**
   * POST /api/v1/contracts
   *
   * Optionally supports an `Idempotency-Key` header to safely retry contract
   * creation (the "milestone release" side effect) without executing it twice.
   */
  router.post(
    "/",
    requireAuth,
    requirePermission("contracts", "create"),
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
    "/bulk",
    requireAuth,
    requirePermission("contracts", "create"),
    validateSchema(bulkCreateContractsSchema),
    bulkController.bulkCreateContracts,
  );

  // PATCH /:id â€” update an existing contract (owner or admin only)
  // validateContractId runs before auth to reject clearly invalid :id params early.
  /** @permission contracts:update (ownOnly for client/freelancer) â€” admin, client, freelancer */
  router.patch(
    "/:id",
    validateParams(contractIdParamSchema),
    requireAuth,
    requirePermission("contracts", "update", getContractOwnerId),
    validateSchema(updateContractSchema),
    controller.updateContract,
  );

  // POST /:id/restore â€” restore a soft-deleted contract within retention window
  /** @permission contracts:update (ownOnly for client/freelancer) â€” admin, client, freelancer */
  router.post(
    "/:id/restore",
    validateParams(contractIdParamSchema),
    requireAuth,
    requirePermission("contracts", "update", getContractOwnerId),
    controller.restoreContract,
  );

  // DELETE /:id â€” delete a contract (admin only per PERMISSION_MATRIX)
  // validateContractId runs before auth to reject clearly invalid :id params early.
  /** @permission contracts:delete â€” admin only */
  router.delete(
    "/:id",
    validateParams(contractIdParamSchema),
    requireAuth,
    requirePermission("contracts", "delete", getContractOwnerId),
    controller.deleteContract,
  );

  return router;
}

export { createContractsRouter };
export default createContractsRouter();
