import { Router } from 'express';
import { contractMetadataController } from './contractMetadata.controller';
import { authMiddleware, requireContractAccess } from '../../middleware/auth';
import {
  validateRequest,
  validateParams,
  validateQuery
} from '../../middleware/validation';
import {
  createContractMetadataSchema,
  updateContractMetadataSchema,
  contractIdParamsSchema,
  metadataIdParamsSchema,
  paginationQuerySchema
} from './contractMetadata.schema';
import { createRateLimiter } from '../../middleware/rateLimiter';
import { rateLimitConfig } from '../../config/rateLimit';

const router = Router();
const sensitiveLimiter = createRateLimiter(rateLimitConfig.sensitive);

/**
 * Contract Metadata Routes
 * Base path: /api/v1/contracts/:contractId/metadata
 */

// POST /contracts/:contractId/metadata - Create metadata
router.post(
  '/contracts/:contractId/metadata',
  sensitiveLimiter,
  authMiddleware,
  requireContractAccess,
  validateParams(contractIdParamsSchema),
  validateRequest(createContractMetadataSchema),
  contractMetadataController.create.bind(contractMetadataController)
);

// GET /contracts/:contractId/metadata - List metadata with pagination
router.get(
  '/contracts/:contractId/metadata',
  authMiddleware,
  requireContractAccess,
  validateParams(contractIdParamsSchema),
  validateQuery(paginationQuerySchema),
  contractMetadataController.list.bind(contractMetadataController)
);

// GET /contracts/:contractId/metadata/:id - Get single metadata
router.get(
  '/contracts/:contractId/metadata/:id',
  authMiddleware,
  requireContractAccess,
  validateParams(metadataIdParamsSchema),
  contractMetadataController.getById.bind(contractMetadataController)
);

// PATCH /contracts/:contractId/metadata/:id - Update metadata
router.patch(
  '/contracts/:contractId/metadata/:id',
  sensitiveLimiter,
  authMiddleware,
  requireContractAccess,
  validateParams(metadataIdParamsSchema),
  validateRequest(updateContractMetadataSchema),
  contractMetadataController.update.bind(contractMetadataController)
);

// DELETE /contracts/:contractId/metadata/:id - Delete metadata
router.delete(
  '/contracts/:contractId/metadata/:id',
  sensitiveLimiter,
  authMiddleware,
  requireContractAccess,
  validateParams(metadataIdParamsSchema),
  contractMetadataController.delete.bind(contractMetadataController)
);

export { router as contractMetadataRoutes };
