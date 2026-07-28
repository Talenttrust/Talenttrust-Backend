/**
 * @module routes/metrics.routes
 * @description HTTP write endpoints for recording application metrics.
 *
 * All request bodies are validated with strict Zod schemas before any metric
 * is mutated. Unknown fields, wrong types, out-of-range values, and missing
 * required fields all produce a structured 400 response with the machine-
 * readable error code `validation_error`.
 *
 * ### Endpoints
 *
 * | Method | Path                                     | Description                      |
 * |--------|------------------------------------------|----------------------------------|
 * | POST   | /api/v1/metrics/webhook/delivery         | Record a webhook delivery outcome |
 * | POST   | /api/v1/metrics/webhook/dlq-depth        | Set the webhook DLQ depth gauge  |
 * | POST   | /api/v1/metrics/health-status            | Record a service health status   |
 * | POST   | /api/v1/metrics/dlq/operation            | Increment a DLQ operation counter|
 * | POST   | /api/v1/metrics/dlq/replay               | Increment a DLQ replay counter   |
 *
 * @security
 *  - All routes should be protected by the metricsAuthMiddleware in production.
 *  - Unknown fields are rejected by strict schemas (no passthrough).
 *  - Numeric values are bounded to prevent gauge/counter corruption.
 */

import { Router, Request, Response } from "express";
import { createRateLimiter } from "../middleware/rateLimiter";
import { validateEnv } from "../config/env.schema";
import {
  validateMetricsInput,
  WebhookDeliveryInputSchema,
  WebhookDlqDepthInputSchema,
  HealthStatusInputSchema,
  DlqOperationInputSchema,
  DlqReplayInputSchema,
  MetricsValidationFailure,
} from "../observability/metrics-validation";
import type { MetricsValidationFailure } from "../observability/metrics-validation";
import { MetricsServiceLike } from "../observability/metrics-service";
import {
  incrementDlqOperation,
  incrementDlqReplay,
} from "../utils/webhookMetrics";
import { validateMetricsRequestBody } from "./metrics-validation-handler";

/**
 * Format a validation failure into the project's standard error envelope.
 */
function validationErrorResponse(
  res: Response,
  failure: MetricsValidationFailure,
  requestId?: string,
): Response {
  return res.status(400).json({
    error: {
      code: failure.code,
      message: "Request validation failed",
      requestId: requestId ?? res.locals.requestId ?? "unknown",
      details: failure.issues,
    },
  });
}

/**
 * Create the metrics write router.
 *
 * @param metricsService - The MetricsService instance used to record metrics.
 *   Pass a mock in tests.
 */
export function createMetricsRouter(metricsService: MetricsServiceLike): Router {
  const router = Router();
  
  let config;
  try {
    config = validateEnv();
  } catch {
    // Fallback for tests if env is not fully valid
    config = { 
      METRICS_RATE_LIMIT_MAX_REQUESTS: parseInt(process.env.METRICS_RATE_LIMIT_MAX_REQUESTS || '100', 10), 
      METRICS_RATE_LIMIT_WINDOW_MS: parseInt(process.env.METRICS_RATE_LIMIT_WINDOW_MS || '60000', 10) 
    };
  }

  const metricsRateLimiter = createRateLimiter({
    maxRequests: config.METRICS_RATE_LIMIT_MAX_REQUESTS,
    windowMs: config.METRICS_RATE_LIMIT_WINDOW_MS,
    keyFn: (req) => {
      const authHeader = req.get("authorization");
      if (authHeader && authHeader.startsWith("Bearer ")) {
        return authHeader.substring(7);
      }
      const xff = req.headers["x-forwarded-for"];
      if (xff) {
        return Array.isArray(xff) ? xff[0] : xff.split(",")[0].trim();
      }
      return req.ip ?? req.socket?.remoteAddress ?? "unknown";
    },
  });

  router.use(metricsRateLimiter);

  /**
   * POST /api/v1/metrics/webhook/delivery
   * Record a webhook delivery outcome.
   *
   * Body: { outcome: 'success' | 'failure' | 'dlq' }
   */
  router.post('/webhook/delivery', (req: Request, res: Response) => {
    const validation = validateMetricsInput(WebhookDeliveryInputSchema, req.body);
    if (!validation.ok) {
      return validationErrorResponse(res, validation);
    }

    try {
      metricsService.recordWebhookDelivery(validation.data.outcome);
      return res.status(204).send();
    } catch {
      return res.status(500).json({
        error: {
          code: 'internal_error',
          message: 'Failed to record webhook delivery metric',
          requestId: res.locals.requestId ?? 'unknown',
        },
      });
    }
  });

  /**
   * POST /api/v1/metrics/webhook/dlq-depth
   * Set the current DLQ depth gauge.
   *
   * Body: { depth: number }  (integer, 0..10_000_000)
   */
  router.post('/webhook/dlq-depth', (req: Request, res: Response) => {
    const validation = validateMetricsInput(WebhookDlqDepthInputSchema, req.body);
    if (!validation.ok) {
      return validationErrorResponse(res, validation);
    }

    try {
      metricsService.setWebhookDlqDepth(validation.data.depth);
      return res.status(204).send();
    } catch {
      return res.status(500).json({
        error: {
          code: 'internal_error',
          message: 'Failed to set DLQ depth metric',
          requestId: res.locals.requestId ?? 'unknown',
        },
      });
    }
  });

  /**
   * POST /api/v1/metrics/health-status
   * Record a service health status observation.
   *
   * Body: { status: 'up' | 'degraded' | 'down' }
   */
  router.post('/health-status', (req: Request, res: Response) => {
    const validation = validateMetricsInput(HealthStatusInputSchema, req.body);
    if (!validation.ok) {
      return validationErrorResponse(res, validation);
    }

    try {
      metricsService.recordHealthStatus(validation.data.status);
      return res.status(204).send();
    } catch {
      return res.status(500).json({
        error: {
          code: 'internal_error',
          message: 'Failed to record health status metric',
          requestId: res.locals.requestId ?? 'unknown',
        },
      });
    }
  });

  /**
   * POST /api/v1/metrics/dlq/operation
   * Increment the webhook DLQ operation counter.
   *
   * Body: { operation: 'enqueue' | 'drop_overflow' | 'drop_poison' }
   */
  router.post('/dlq/operation', (req: Request, res: Response) => {
    const validation = validateMetricsInput(DlqOperationInputSchema, req.body);
    if (!validation.ok) {
      return validationErrorResponse(res, validation);
    }

    try {
      incrementDlqOperation(validation.data.operation);
      return res.status(204).send();
    } catch {
      return res.status(500).json({
        error: {
          code: 'internal_error',
          message: 'Failed to record DLQ operation metric',
          requestId: res.locals.requestId ?? 'unknown',
        },
      });
    }
  });

  /**
   * POST /api/v1/metrics/dlq/replay
   * Increment the DLQ replay counter.
   *
   * Body: { outcome: 'success' | 'failed' | 'idempotent_noop' | 'error' }
   */
  router.post('/dlq/replay', (req: Request, res: Response) => {
    const validation = validateMetricsInput(DlqReplayInputSchema, req.body);
    if (!validation.ok) {
      return validationErrorResponse(res, validation);
    }

    try {
      incrementDlqReplay(validation.data.outcome);
      return res.status(204).send();
    } catch {
      return res.status(500).json({
        error: {
          code: 'internal_error',
          message: 'Failed to record DLQ replay metric',
          requestId: res.locals.requestId ?? 'unknown',
        },
      });
    }
  });

  return router;
}
