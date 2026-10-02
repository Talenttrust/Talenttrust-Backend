import { Router } from 'express';
import { ReputationController } from '../controllers/reputation.controller';
import { registry } from '../docs/openapi-registry';
import {
  updateReputationSchema,
  reputationParamsSchema,
  bulkReputationSchema,
  correctReputationSchema,
  reputationCorrectionResponseSchema,
} from '../modules/reputation/dto/reputation.dto';
import { validateSchema } from '../middleware/validate.middleware';
import { createRateLimiter } from '../middleware/rateLimiter';
import { requireAuth, requirePermission } from '../middleware/authorization';
import { rateLimitConfig } from '../config/rateLimit';
import { authRateLimitKeyFn } from '../auth/rateLimitKey';
import { z } from 'zod';
import { reputationIdempotencyMiddleware } from '../middleware/reputationIdempotency';
import { randomUUID } from 'crypto';
import { requestContextStore } from '../middleware/requestContext';

const router = Router();
const reputationLimiter = createRateLimiter({
  ...rateLimitConfig.reputation,
  keyFn: req => `reputation:${authRateLimitKeyFn(req)}`,
});

// Dedicated per-client limiter. Keys are namespaced because the store is shared.
router.use(reputationLimiter);

// Local middleware to accept/generate correlation ID for all reputation requests
router.use((req, res, next) => {
  if (!res.locals.correlationId) {
    const generatedId = `rep-${randomUUID()}`;
    res.locals.correlationId = generatedId;
    res.setHeader('x-correlation-id', generatedId);

    // Update ALS store context if it is active
    const store = requestContextStore.getStore();
    if (store) {
      store.correlationId = generatedId;
    }

    // Re-bind res.locals.log with the new correlation ID context
    if (res.locals.log && typeof res.locals.log.child === 'function') {
      res.locals.log = res.locals.log.child({ correlationId: generatedId });
    }
  }
  next();
});

// ── Authentication guard — all reputation routes require a valid JWT ──────────
router.use(requireAuth);

// POST /api/v1/reputation/bulk — batch create reputation ratings
// Must be registered before the /:id routes to avoid being captured by the param route.
router.post(
  '/bulk',
  requirePermission('reviews', 'create'),
  validateSchema(bulkReputationSchema),
  reputationIdempotencyMiddleware,
  ReputationController.createBulkRatings
);

registry.registerPath({
  method: 'get',
  path: '/reputation/{id}',
  summary: 'Get freelancer reputation',
  parameters: [
    {
      name: 'id',
      in: 'path',
      required: true,
      schema: { type: 'string', format: 'uuid' }
    },
    {
      name: 'cursor',
      in: 'query',
      required: false,
      description: 'Opaque cursor for the next page of reviews (base64url-encoded).',
      schema: { type: 'string' }
    },
    {
      name: 'limit',
      in: 'query',
      required: false,
      description: 'Maximum reviews per page (1-100, default 20).',
      schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 }
    }
  ],
  responses: {
    200: {
      description: 'Freelancer reputation profile',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              status: { type: 'string', example: 'success' },
              data: {
                type: 'object',
                properties: {
                  freelancerId: { type: 'string' },
                  score: { type: 'number' },
                  totalRatings: { type: 'number' },
                  reviews: { type: 'array' },
                  nextCursor: {
                    type: 'string',
                    nullable: true,
                    description: 'Opaque cursor for the next page of reviews, or null on the last page.'
                  },
                  hasNextPage: { type: 'boolean' },
                  limit: { type: 'integer' }
                }
              }
            }
          }
        }
      }
    },
    400: { description: 'Invalid cursor or limit parameter' }
  }
});

// GET /api/v1/reputation/:id - Retrieve reputation for a freelancer
// All authenticated roles (admin, client, freelancer) may read reviews.
router.get(
  '/:id',
  requirePermission('reviews', 'read'),
  validateSchema(z.object({ params: reputationParamsSchema })),
  ReputationController.getProfile
);

/**
 * POST /api/v1/reputation/:id/rate
 * Create a new reputation rating. Requires authentication.
 */
registry.registerPath({
  method: 'post',
  path: '/reputation/{id}/rate',
  summary: 'Create reputation rating',
  security: [{ bearerAuth: [] }],
  parameters: [
    {
      name: 'id',
      in: 'path',
      required: true,
      schema: { type: 'string', format: 'uuid' }
    },
    {
      name: 'Idempotency-Key',
      in: 'header',
      required: false,
      description: 'Optional retry key. Exact retries replay the original response.',
      schema: { type: 'string', maxLength: 255 }
    }
  ],
  request: {
    body: {
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/UpdateReputation' }
        }
      }
    }
  },
  responses: {
    201: {
      description: 'Rating created successfully',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              status: { type: 'string', example: 'success' },
              data: { type: 'object' }
            }
          }
        }
      }
    },
    400: { description: 'Invalid payload' },
    403: { description: 'Forbidden - self-rating or unauthorized' },
    409: { description: 'Conflict - duplicate rating' },
    422: { description: 'Validation error' }
  }
});

router.post(
  '/:id/rate',
  requirePermission('reviews', 'create'),
  validateSchema(z.object({ body: updateReputationSchema, params: reputationParamsSchema })),
  reputationIdempotencyMiddleware,
  ReputationController.createRating,
);

// PUT /api/v1/reputation/:id - Submit a reputation review for a freelancer.
// Requires 'reviews.create' permission — granted to admin, client, freelancer.
router.put(
  '/:id',
  requirePermission('reviews', 'create'),
  validateSchema(z.object({ body: updateReputationSchema, params: reputationParamsSchema })),
  reputationIdempotencyMiddleware,
  ReputationController.createRating
);

/**
 * POST /api/v1/reputation/:id/correct
 * Apply a manual reputation correction with full provenance tracking.
 * 
 * Strictly separated from ordinary event ingestion pathways.
 * Requires 'reputation.correct' permission (admin, support, moderator).
 */
registry.registerPath({
  method: 'post',
  path: '/reputation/{id}/correct',
  summary: 'Apply manual reputation correction with provenance',
  security: [{ bearerAuth: [] }],
  parameters: [
    {
      name: 'id',
      in: 'path',
      required: true,
      schema: { type: 'string', format: 'uuid' }
    },
    {
      name: 'Idempotency-Key',
      in: 'header',
      required: false,
      description: 'Optional retry key. Exact retries replay the original response.',
      schema: { type: 'string', maxLength: 255 }
    }
  ],
  request: {
    body: {
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/CorrectReputation' }
        }
      }
    }
  },
  responses: {
    201: {
      description: 'Correction applied successfully',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              status: { type: 'string', example: 'success' },
              data: { $ref: '#/components/schemas/ReputationCorrectionResponse' }
            }
          }
        }
      }
    },
    400: { description: 'Invalid payload - reason, reference, contextId required' },
    401: { description: 'Unauthorized - operator identity not found' },
    403: { description: 'Forbidden - operator role not authorized' },
    409: { description: 'Conflict - correction with same reference already exists' },
    422: { description: 'Validation error - reason length, reference format, etc.' }
  }
});

router.post(
  '/:id/correct',
  requirePermission('reputation', 'correct'),
  validateSchema(z.object({ body: correctReputationSchema, params: reputationParamsSchema })),
  ReputationController.correctReputation
);

/**
 * GET /api/v1/reputation/:id/corrections
 * Retrieve all reputation corrections for a freelancer.
 */
registry.registerPath({
  method: 'get',
  path: '/reputation/{id}/corrections',
  summary: 'Get reputation corrections for a freelancer',
  security: [{ bearerAuth: [] }],
  parameters: [
    {
      name: 'id',
      in: 'path',
      required: true,
      schema: { type: 'string', format: 'uuid' }
    }
  ],
  responses: {
    200: {
      description: 'List of reputation corrections',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              status: { type: 'string', example: 'success' },
              data: { type: 'array', items: { $ref: '#/components/schemas/ReputationCorrectionResponse' } }
            }
          }
        }
      }
    },
    400: { description: 'Invalid freelancer ID' }
  }
});

router.get(
  '/:id/corrections',
  requirePermission('reviews', 'read'),
  validateSchema(z.object({ params: reputationParamsSchema })),
  ReputationController.getCorrections
);

export default router;
