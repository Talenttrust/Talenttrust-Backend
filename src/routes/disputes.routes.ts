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
 * @route GET    /api/v1/disputes       - List disputes
 * @route GET    /api/v1/disputes/:id   - Get a single dispute
 * @route POST   /api/v1/disputes       - Create a new dispute
 * @route PATCH  /api/v1/disputes/:id   - Update a dispute
 * @route DELETE /api/v1/disputes/:id   - Delete a dispute
 *
 * @security
 *  - All routes require a valid JWT (Bearer token).
 *  - Rate limiting returns 429 with Retry-After header when exceeded.
 *  - Abuse guard hard-blocks repeat offenders.
 *  - Correlation IDs are validated against a strict pattern before use.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { createRateLimiter } from '../middleware/rateLimiter';
import { rateLimitConfig } from '../config/rateLimit';
import { requireAuth, requirePermission } from '../middleware/authorization';
import { validateSchema, validateRequest, validateParams, validateQuery } from '../middleware/validate.middleware';
import {
  createDisputeSchema,
  updateDisputeSchema,
  disputeParamsSchema,
  listDisputesQuerySchema,
} from './disputes.validation';
import { features } from '../config/features';
import { ok, fail } from '../utils/apiResponse';
import { getRequestLogger, getRequestContext } from '../utils/correlationId';

const router = Router();

// ── Feature flag — gate all disputes routes ───────────────────────────────────
router.use((_req: Request, res: Response, next: NextFunction) => {
  if (!features.disputesEnabled) {
    fail(res, 'feature_disabled', 'Disputes feature is currently disabled.', 404);
    return;
  }
  next();
});

// ── Rate limiter (disputes tier) ──────────────────────────────────────────────
const disputesLimiter = createRateLimiter(rateLimitConfig.disputes);

// Apply rate limiting to all disputes routes
router.use(disputesLimiter);

// ── Authentication — all disputes routes require a valid JWT ──────────────────
router.use(requireAuth);

// ── GET / — list disputes ─────────────────────────────────────────────────────
/** @permission disputes:list — admin, auditor, client (ownOnly), freelancer (ownOnly) */
router.get(
  '/',
  requirePermission('disputes', 'list'),
  validateQuery(listDisputesQuerySchema),
  (req: Request, res: Response) => {
    const log = getRequestLogger(res);
    const { correlationId } = getRequestContext(res);
    log.info('Listing disputes', { query: req.query });

    ok(
      res,
      { disputes: [], total: 0 },
      correlationId ? { correlationId } : undefined,
    );
  },
);

// ── GET /:id — get a single dispute ───────────────────────────────────────────
/** @permission disputes:read — admin, auditor, client (ownOnly), freelancer (ownOnly) */
router.get(
  '/:id',
  requirePermission('disputes', 'read'),
  validateParams(disputeParamsSchema),
  (req: Request, res: Response) => {
    const log = getRequestLogger(res);
    const { correlationId } = getRequestContext(res);
    const disputeId = req.params.id;
    log.info('Getting dispute', { disputeId });

    ok(
      res,
      {
        dispute: {
          id: disputeId,
          status: 'open',
          createdAt: new Date().toISOString(),
        },
      },
      correlationId ? { correlationId } : undefined,
    );
  },
);

// ── POST / — create a new dispute ─────────────────────────────────────────────
/** @permission disputes:create — admin, client, freelancer */
router.post(
  '/',
  requirePermission('disputes', 'create'),
  validateRequest(createDisputeSchema),
  (req: Request, res: Response) => {
    const log = getRequestLogger(res);
    const { correlationId } = getRequestContext(res);
    const body = req.body ?? {};
    const disputeId = `dispute-${Date.now()}`;
    log.info('Creating dispute', { disputeId });

    ok(
      res,
      {
        dispute: {
          id: disputeId,
          ...body,
          status: 'open',
          createdAt: new Date().toISOString(),
        },
      },
      correlationId ? { correlationId } : undefined,
      201,
    );
  },
);

// ── PATCH /:id — update a dispute ────────────────────────────────────────────
/** @permission disputes:update — admin, client (ownOnly) */
router.patch(
  '/:id',
  requirePermission('disputes', 'update'),
  validateSchema(z.object({
    body: updateDisputeSchema,
    params: disputeParamsSchema,
  })),
  (req: Request, res: Response) => {
    const log = getRequestLogger(res);
    const { correlationId } = getRequestContext(res);
    const disputeId = req.params.id;
    const body = req.body ?? {};
    log.info('Updating dispute', { disputeId, updateFields: Object.keys(body) });

    ok(
      res,
      {
        dispute: {
          id: disputeId,
          ...body,
          updatedAt: new Date().toISOString(),
        },
      },
      correlationId ? { correlationId } : undefined,
    );
  },
);

// ── DELETE /:id — delete a dispute ────────────────────────────────────────────
/** @permission disputes:delete — admin only */
router.delete(
  '/:id',
  requirePermission('disputes', 'delete'),
  (req: Request, res: Response) => {
    const log = getRequestLogger(res);
    const { correlationId } = getRequestContext(res);
    const disputeId = req.params.id;
    log.info('Deleting dispute', { disputeId });

    ok(
      res,
      { message: `Dispute ${disputeId} deleted successfully` },
      correlationId ? { correlationId } : undefined,
    );
  },
);

export default router;
