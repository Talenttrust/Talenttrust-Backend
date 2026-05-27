import { Router } from 'express';
import { ReputationController } from '../controllers/reputation.controller';
import { registry } from '../docs/openapi-registry';
import { updateReputationSchema } from '../modules/reputation/dto/reputation.dto';
import { validateSchema } from '../middleware/validate.middleware';
import { requireAuth, requirePermission } from '../middleware/authorization';
import { z } from 'zod';

const router = Router();

// ── Authentication guard — all reputation routes require a valid JWT ──────────
router.use(requireAuth);

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
                  reviews: { type: 'array' }
                }
              }
            }
          }
        }
      }
    }
  }
});

// GET /api/v1/reputation/:id - Retrieve reputation for a freelancer
// All authenticated roles (admin, client, freelancer) may read reviews.
router.get('/:id', requirePermission('reviews', 'read'), ReputationController.getProfile);

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

// PUT /api/v1/reputation/:id - Submit a reputation review for a freelancer.
// Requires 'reviews.create' permission — granted to admin, client, freelancer.
router.put(
  '/:id',
  requirePermission('reviews', 'create'),
  validateSchema(z.object({ body: updateReputationSchema, params: z.object({ id: z.string().min(1) }) })),
  ReputationController.createRating
);

export default router;

