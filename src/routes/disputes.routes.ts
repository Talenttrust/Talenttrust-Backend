/**
 * @module routes/disputes
 * @description Disputes API routes with per-client rate limiting.
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
 */

import { Router, Request, Response } from 'express';
import { createRateLimiter } from '../middleware/rateLimiter';
import { rateLimitConfig } from '../config/rateLimit';
import { requireAuth, requirePermission } from '../middleware/authorization';

const router = Router();

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
  (_req: Request, res: Response) => {
    res.status(200).json({ disputes: [], total: 0 });
  },
);

// ── GET /:id — get a single dispute ───────────────────────────────────────────
/** @permission disputes:read — admin, auditor, client (ownOnly), freelancer (ownOnly) */
router.get(
  '/:id',
  requirePermission('disputes', 'read'),
  (req: Request, res: Response) => {
    res.status(200).json({
      dispute: {
        id: req.params.id,
        status: 'open',
        createdAt: new Date().toISOString(),
      },
    });
  },
);

// ── POST / — create a new dispute ─────────────────────────────────────────────
/** @permission disputes:create — admin, client, freelancer */
router.post(
  '/',
  requirePermission('disputes', 'create'),
  (req: Request, res: Response) => {
    const body = req.body ?? {};
    res.status(201).json({
      dispute: {
        id: `dispute-${Date.now()}`,
        ...body,
        status: 'open',
        createdAt: new Date().toISOString(),
      },
    });
  },
);

// ── PATCH /:id — update a dispute ────────────────────────────────────────────
/** @permission disputes:update — admin, client (ownOnly) */
router.patch(
  '/:id',
  requirePermission('disputes', 'update'),
  (req: Request, res: Response) => {
    const body = req.body ?? {};
    res.status(200).json({
      dispute: {
        id: req.params.id,
        ...body,
        updatedAt: new Date().toISOString(),
      },
    });
  },
);

// ── DELETE /:id — delete a dispute ────────────────────────────────────────────
/** @permission disputes:delete — admin only */
router.delete(
  '/:id',
  requirePermission('disputes', 'delete'),
  (req: Request, res: Response) => {
    res.status(200).json({
      message: `Dispute ${req.params.id} deleted successfully`,
    });
  },
);

export default router;
