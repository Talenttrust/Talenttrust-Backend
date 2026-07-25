import { Router, Request, Response, NextFunction } from 'express';

import { createContractsController } from '../controllers/contracts.controller';
import { ContractsService } from '../services/contracts.service';
import { ContractRepository } from '../repositories/contractRepository';
import { getDb } from '../db/database';
import { validateSchema } from '../middleware/validate.middleware';
import {
  createContractSchema,
  contractIdParamSchema,
  contractQuerySchema,
} from '../modules/contracts/dto/contract.dto';
import { validateUpdateContract } from '../modules/contracts/validation.middleware';
import { eventIngestionService } from '../events/registry';
import { contractCreateIdempotencyMiddleware } from '../middleware/contractIdempotency';
import { requireAuth, requirePermission } from '../middleware/authorization';

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
 */
function createContractsRouter(): Router {
  const router = Router();
  const db = getDb();
  const repo = new ContractRepository(db);
  const controller = createContractsController(new ContractsService(repo));

  /**
   * Resolves the owner (clientId) of a contract from the DB.
   * Used by requirePermission for ownOnly PATCH and DELETE checks.
   * Returns null when the contract does not exist (triggers 404).
   */
  const getContractOwnerId = async (req: any): Promise<string | null> => {
    const contract = await repo.findById(req.params?.id ?? '');
    return contract ? contract.clientId : null;
  };

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
  router.get('/:id/history', validateContractId, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const history = await eventIngestionService.getContractHistory(req.params.id);
      res.status(200).json(history);
    } catch (error) {
      next(error);
    }
  });

  // GET /:id — fetch single contract (param validation before auth to reject clearly invalid IDs)
  /** @permission contracts:read — admin, client (ownOnly), freelancer (ownOnly) */
  router.get(
    '/:id',
    validateContractId,
    requireAuth,
    requirePermission('contracts', 'read', getContractOwnerId),
    controller.getContractById,
  );

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

  // PATCH /:id — update an existing contract (owner or admin only)
  // validateContractId runs before auth to reject clearly invalid :id params early.
  /** @permission contracts:update (ownOnly for client/freelancer) — admin, client, freelancer */
  router.patch(
    '/:id',
    validateContractId,
    requireAuth,
    requirePermission('contracts', 'update', getContractOwnerId),
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

export default createContractsRouter();
