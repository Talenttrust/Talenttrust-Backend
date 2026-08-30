/**
 * @module routes/disputes
 * @description Disputes API routes with per-client rate limiting and
 * correlation ID propagation for distributed tracing.
 *
 * Every disputes request is tagged with a requestId and an optional
 * caller-supplied correlation ID.  These IDs are:
 *   - threaded through request-scoped logs so operations can be traced
 *   - echoed back in response headers (X-Request-Id, X-Correlation-Id)
 *   - included in success/error response bodies for support tooling
 *
 * All disputes endpoints are protected by authentication and role-based
 * authorization. A sliding-window rate limiter (sensitive-tier) is applied
 * to every route to prevent abuse and accidental overload.
 *
 * Status changes go through the service layer's centralized transition
 * matrix (`DisputesService.updateDispute`), so every route enforces the
 * same legal transitions, evidence requirements, and optimistic-concurrency
 * rules — no route can bypass them.
 *
 * @route GET    /api/v1/disputes       - List disputes
 * @route GET    /api/v1/disputes/:id   - Get a single dispute
 * @route POST   /api/v1/disputes       - Create a new dispute
 * @route PATCH  /api/v1/disputes/:id   - Update a dispute
 * @route DELETE /api/v1/disputes/:id   - Delete a dispute
 *
 * @security
 *  - All routes require a valid JWT (Bearer token).
 *  - Rate limiting returns 429 with Retry-After header when exceeded.
 *  - Correlation IDs are validated against a strict pattern before use.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { createRateLimiter } from '../middleware/rateLimiter';
import { rateLimitConfig } from '../config/rateLimit';
import { requireAuth, requirePermission } from '../middleware/authorization';
import { validateRequest, validateParams, validateQuery, validateSchema } from '../middleware/validate.middleware';
import {
  createDisputeSchema,
  updateDisputeSchema,
  disputeParamsSchema,
  listDisputesQuerySchema,
} from './disputes.validation';
import { features } from '../config/features';
import { getRequestLogger } from '../utils/correlationId';
import { createDisputesController } from '../controllers/disputes.controller';
import type { Logger } from '../logger';
import type { MetricsServiceLike } from '../observability/metrics-service';

export interface DisputesRouterOptions {
  /** Optional metrics service; when omitted, metrics are skipped. */
  metricsService?: Pick<MetricsServiceLike, 'recordDisputesRequest'>;
  /** Optional logger override (tests). Defaults to request-scoped or root logger. */
  log?: Logger;
}

/**
 * Build the disputes router.
 *
 * @param options - Optional metrics/logger injection for observability.
 */
export function createDisputesRouter(options: DisputesRouterOptions = {}): Router {
  const router = Router();
  const controller = createDisputesController();

  // ── Feature flag — gate all disputes routes ───────────────────────────────────
  router.use((_req: Request, res: Response, next: NextFunction) => {
    if (!features.disputesEnabled) {
      res.status(404).json({
        status: 'error',
        error: { code: 'feature_disabled', message: 'Disputes feature is currently disabled.' },
      });
      return;
    }
    next();
  });

  // Observability first so duration/status capture includes auth + rate-limit outcomes.
  router.use(createDisputesObservabilityMiddleware(options));

  // ── Rate limiter (disputes tier) ──────────────────────────────────────────────
  const disputesLimiter = createRateLimiter(rateLimitConfig.disputes);
  router.use(disputesLimiter);

  // ── GET / — list disputes ─────────────────────────────────────────────────────
  /** @permission disputes:list — admin, auditor, client (ownOnly), freelancer (ownOnly) */
  router.get(
    '/',
    requireAuth,
    requirePermission('disputes', 'list'),
    validateQuery(listDisputesQuerySchema),
    (req: Request, res: Response, next: NextFunction) => {
      void controller.getDisputes(req, res, next);
    },
  );

  // ── GET /:id — get a single dispute ───────────────────────────────────────────
  /** @permission disputes:read — admin, auditor, client (ownOnly), freelancer (ownOnly) */
  router.get(
    '/:id',
    requireAuth,
    requirePermission('disputes', 'read'),
    validateParams(disputeParamsSchema),
    (req: Request, res: Response, next: NextFunction) => {
      void controller.getDisputeById(req, res, next);
    },
  );

  // ── POST / — create a new dispute ─────────────────────────────────────────────
  /** @permission disputes:create — admin, client, freelancer */
  router.post(
    '/',
    requireAuth,
    requirePermission('disputes', 'create'),
    validateRequest(createDisputeSchema),
    (req: Request, res: Response, next: NextFunction) => {
      void controller.createDispute(req, res, next);
    },
  );

  // ── PATCH /:id — update a dispute ────────────────────────────────────────────
  /**
   * @permission disputes:update — admin, client (ownOnly)
   * @description All status changes are validated by the service layer's
   * centralized transition matrix; a stale `expectedVersion` is rejected
   * with 409 so concurrent transitions surface a conflict.
   */
  router.patch(
    '/:id',
    requireAuth,
    requirePermission('disputes', 'update'),
    // Single combined parse: validating params alone would strip `body` from
    // the parsed result and clobber req.body before the handler runs.
    validateSchema(z.object({
      body: updateDisputeSchema,
      params: disputeParamsSchema,
    })),
    (req: Request, res: Response, next: NextFunction) => {
      void controller.updateDispute(req, res, next);
    },
  );

  // ── DELETE /:id — delete a dispute ────────────────────────────────────────────
  /** @permission disputes:delete — admin only */
  router.delete(
    '/:id',
    requireAuth,
    requirePermission('disputes', 'delete'),
    validateParams(disputeParamsSchema),
    (req: Request, res: Response, next: NextFunction) => {
      void controller.deleteDispute(req, res, next);
    },
  );

  return router;
}

/**
 * Create observability middleware for disputes routes.
 * Records metrics and structured logs for each request.
 */
export function createDisputesObservabilityMiddleware(options: DisputesRouterOptions = {}) {
  return (req: Request, res: Response, next: NextFunction) => {
    const startTime = Date.now();
    const log = options.log || getRequestLogger(res);

    res.on('finish', () => {
      const duration = Date.now() - startTime;
      const statusCode = res.statusCode;

      // Record metrics if service is available
      if (options.metricsService && options.metricsService.recordDisputesRequest) {
        options.metricsService.recordDisputesRequest(duration);
      }

      // Log request completion
      log.info('disputes_request', {
        statusCode,
        duration,
        method: req.method,
        path: req.path,
      });
    });

    next();
  };
}
