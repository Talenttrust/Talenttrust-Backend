import { Router, Request, Response, NextFunction } from 'express';

import { createContractsController } from '../controllers/contracts.controller';
import { createMilestonesSoftDeleteController } from '../controllers/milestones.softdelete.controller';
import { createContractsBulkController } from '../controllers/contracts-bulk.controller';
import { ContractsService } from '../services/contracts.service';
import { ContractRepository } from '../repositories/contractRepository';
import { getDb } from '../db/database';
import { validateSchema } from '../middleware/validate.middleware';
import { createRateLimiter } from '../middleware/rateLimiter';
import { rateLimitConfig } from '../config/rateLimit';
import {
  createContractSchema,
  contractIdParamSchema,
  contractQuerySchema,
} from '../modules/contracts/dto/contract.dto';
import { bulkCreateContractsSchema } from '../modules/contracts/dto/bulk-operations.dto';
import {
  createMilestoneSchema,
  milestoneIdParamSchema,
  milestonesQuerySchema,
} from '../modules/contracts/dto/milestones.dto';
import { validateUpdateContract } from '../modules/contracts/validation.middleware';
import { eventIngestionService } from '../events/registry';
import { contractCreateIdempotencyMiddleware } from '../middleware/contractIdempotency';
import { requireAuth, requirePermission } from '../middleware/authorization';
import { validateRequest, validateParams, validateQuery } from '../middleware/validate.middleware';
import type { MetricsServiceLike } from '../observability/metrics-service';

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

function createContractsRouter(metricsService?: MetricsServiceLike): Router {
  const router = Router();
  const db = getDb();
  const repo = new ContractRepository(db);
  const controller = createContractsController(new ContractsService(repo), metricsService);
  const milestonesSoftDelete = createMilestonesSoftDeleteController();
  const _bulkController = createContractsBulkController(new ContractsService(repo));

  const getContractOwnerId = async (req: any): Promise<string | null> => {
    const contract = await repo.findById(req.params?.id ?? '');
    return contract ? contract.clientId : null;
  };

  router.get('/bounds', requireAuth, requirePermission('contracts', 'read'), controller.getBounds);

  router.get('/stats', requireAuth, requirePermission('contracts', 'list'), controller.getContractStats);

  router.get(
    '/',
    requireAuth,
    requirePermission('contracts', 'list'),
    validateContractQuery,
    controller.getContracts,
  );

  router.get('/:id/history', validateContractId, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const history = await eventIngestionService.getContractHistory(req.params.id);
      res.status(200).json(history);
    } catch (error) {
      next(error);
    }
  });

  router.get(
    '/:id',
    validateContractId,
    requireAuth,
    requirePermission('contracts', 'read', getContractOwnerId),
    controller.getContractById,
  );

  router.get(
    '/:id/milestones',
    validateContractId,
    validateQuery(milestonesQuerySchema),
    requireAuth,
    requirePermission('contracts', 'read', getContractOwnerId),
    milestonesSoftDelete.list.bind(milestonesSoftDelete),
  );

  router.post(
    '/:id/milestones',
    validateContractId,
    validateRequest(createMilestoneSchema),
    requireAuth,
    requirePermission('contracts', 'update', getContractOwnerId),
    milestonesSoftDelete.create.bind(milestonesSoftDelete),
  );

  router.post(
    '/:id/milestones/:milestoneId/restore',
    validateContractId,
    validateParams(milestoneIdParamSchema),
    requireAuth,
    requirePermission('contracts', 'update', getContractOwnerId),
    milestonesSoftDelete.restore.bind(milestonesSoftDelete),
  );

  router.delete(
    '/:id/milestones/:milestoneId',
    validateContractId,
    validateParams(milestoneIdParamSchema),
    requireAuth,
    requirePermission('contracts', 'update', getContractOwnerId),
    milestonesSoftDelete.softDelete.bind(milestonesSoftDelete),
  );

  router.post(
    '/',
    requireAuth,
    requirePermission('contracts', 'create'),
    contractCreateIdempotencyMiddleware(),
    validateSchema(createContractSchema),
    controller.createContract,
  );

  router.patch(
    '/:id',
    validateContractId,
    requireAuth,
    requirePermission('contracts', 'update', getContractOwnerId),
    validateUpdateContract,
    controller.updateContract,
  );

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