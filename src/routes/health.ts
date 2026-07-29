/**
 * @module routes/health
 * @description Health-check route.
 *
 * Used by load balancers and CI smoke tests to verify the service is alive.
 *
 * Rate limiting:
 * - All health routes are protected by a per-client rate limiter using the
 *   shared `health` tier from {@link module:config/rateLimit}.
 * - Key is derived from X-API-Key (service clients) or client IP.
 * - Exceeding the limit returns HTTP 429 with a `Retry-After` header.
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
 * @returns {{ error: { code: 'rate_limited', ... } }} 429 when rate limit exceeded
 */

import { Router, Request, Response } from 'express';
import { createHash } from 'crypto';
import { LRUCache } from 'lru-cache';
import { registry } from '../docs/openapi-registry';
import { validateRequest, validateQuery } from '../middleware/validation';
import { HealthWriteBodySchema, HealthQuerySchema } from '../health/validation';
import { createRateLimiter } from '../middleware/rateLimiter';
import { rateLimitConfig } from '../config/rateLimit';
import { healthRateLimitKeyFn } from '../health/rateLimitKey';

const idempotencyStore = new LRUCache<string, { bodyHash: string; response: any }>({
  max: 1000,
  ttl: 1000 * 60 * 60 * 24, // 24 hours
});

export const healthRouter = Router();

// Apply per-client rate limiter to all /health routes in this router.
healthRouter.use(
  createRateLimiter({
    ...rateLimitConfig.health,
    keyFn: healthRateLimitKeyFn,
  }),
);

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
    429: {
      description: "Rate limit exceeded",
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
    },
    429: {
      description: 'Rate limit exceeded',
    },
  }
});

healthRouter.get('/', validateQuery(HealthQuerySchema), (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    service: 'talenttrust-backend',
  });
});

healthRouter.post('/', validateRequest(HealthWriteBodySchema), (req: Request, res: Response) => {
  const idempotencyKey = req.header('idempotency-key');

  if (idempotencyKey) {
    const bodyHash = createHash('sha256').update(JSON.stringify(req.body)).digest('hex');
    const cached = idempotencyStore.get(idempotencyKey);

    if (cached) {
      if (cached.bodyHash !== bodyHash) {
        return res.status(409).json({
          error: {
            code: 'conflict',
            message: 'Idempotency key already used for a different request',
          },
        });
      }
      return res.status(200).json(cached.response);
    }

    const response = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      version: process.env.npm_package_version ?? '0.1.0',
    };

    idempotencyStore.set(idempotencyKey, { bodyHash, response });
    return res.status(200).json(response);
  }

  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version ?? '0.1.0',
  });
});
