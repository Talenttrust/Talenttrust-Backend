/**
 * @module routes/health
 * @description Health-check route.
 *
 * Used by load balancers and CI smoke tests to verify the service is alive.
 *
 * Validation notes:
 * - POST /health validates the request body against {@link HealthWriteBodySchema}.
 *   Unknown fields, wrong types, out-of-range values, and oversized strings are
 *   rejected with HTTP 400 and a machine-readable `validation_error` payload.
 * - GET /health validates query parameters against {@link HealthQuerySchema}.
 *   Unknown query keys are rejected to prevent parameter-injection probing.
 *
 * @route GET /health
 * @route POST /health
 * @returns {{ status: string, service: string }} 200 JSON payload on success
 * @returns {{ error: { code: 'validation_error', ... } }} 400 on validation failure
 */

import { Router, Request, Response } from 'express';
import { registry } from '../docs/openapi-registry';
import { validateRequest, validateQuery } from '../middleware/validation';
import { HealthWriteBodySchema, HealthQuerySchema } from '../health/validation';

export const healthRouter = Router();

registry.registerPath({
  method: "get",
  path: "/health",
  summary: "Health check",
  responses: {
    200: {
      description: "Service is healthy",
      content: {
        "application/json": {
          schema: {
            type: "object",
            properties: {
              status: { type: "string", example: "ok" },
              service: { type: "string", example: "talenttrust-backend" },
            },
          },
        },
      },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/health',
  summary: 'Submit health snapshot',
  responses: {
    200: {
      description: 'Health snapshot accepted',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              status: { type: 'string', example: 'healthy' },
              timestamp: { type: 'string', example: new Date().toISOString() },
              version: { type: 'string', example: '0.1.0' }
            }
          }
        }
      }
    },
    400: {
      description: 'Validation error — malformed or out-of-bounds fields',
    }
  }
});

healthRouter.get('/', validateQuery(HealthQuerySchema), (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    service: 'talenttrust-backend',
  });
});

healthRouter.post('/', validateRequest(HealthWriteBodySchema), (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version ?? '0.1.0',
  });
healthRouter.get('/', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok', service: 'talenttrust-backend' });
});

healthRouter.post("/", (_req: Request, res: Response) => {
  sendHealthResponse(res);
});
