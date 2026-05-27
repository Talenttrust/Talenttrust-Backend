/**
 * @module routes/health
 * @description Health-check route.
 *
 * Used by load balancers and CI smoke tests to verify the service is alive.
 *
 * @route GET /health
 * @returns {{ status: string, service: string }} 200 JSON payload
 */

import { Router, Request, Response } from 'express';
import { registry } from '../docs/openapi-registry';

export const healthRouter = Router();

registry.registerPath({
  method: 'get',
  path: '/health',
  summary: 'Health check',
  responses: {
    200: {
      description: 'Service is healthy',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              status: { type: 'string', example: 'ok' },
              service: { type: 'string', example: 'talenttrust-backend' }
            }
          }
        }
      }
    }
  }
});

healthRouter.get('/', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok', service: 'talenttrust-backend' });
});
