/**
 * @module routes/admin
 * @description Admin-only routes for operational visibility.
 *
 * @route GET /api/v1/admin/queue-health
 * @route GET /api/v1/admin/circuit-breakers
 * @security Requires admin role via JWT authentication
 */

import { Router, Request, Response, NextFunction } from 'express';
import { QueueManager } from '../queue';
import { requireAuth, requireRole } from '../middleware/authorization';
import { adminAuthGuard, AdminAuthenticatedRequest } from '../middleware/adminAuthGuard';
import { circuitBreakerRegistry } from '../circuit-breaker/registry';
import { WebhookService } from '../services/webhook.service';

export const adminRouter = Router();

adminRouter.get(
  '/queue-health',
  requireAuth,
  requireRole('admin'),
  async (_req, res: Response) => {
    const queueManager = QueueManager.getInstance();
    const queues = await queueManager.getHealth();
    const failures = await queueManager.getRecentFailures(10);

    res.status(200).json({
      status: 'success',
      data: {
        queues,
        failures,
        timestamp: Date.now(),
      },
    });
  }
);

/**
 * GET /api/v1/admin/circuit-breakers
 *
 * Returns the current state and counters for all registered circuit breakers.
 * Useful for monitoring upstream dependency health without exposing internals
 * to unauthenticated callers.
 */
adminRouter.get(
  '/circuit-breakers',
  requireAuth,
  requireRole('admin'),
  (_req, res: Response) => {
    const breakers = circuitBreakerRegistry.getAll();
    res.status(200).json({
      status: 'success',
      data: { breakers, timestamp: Date.now() },
    });
  }
);

/**
 * POST /api/v1/admin/webhooks/dlq/replay-all
 *
 * Replays all pending DLQ entries with bounded concurrency (backpressure).
 * Accepts optional `concurrency` body param (default: 5, min: 1, max: 50).
 * Returns a summary { attempted, succeeded, failed, deduped }.
 */
adminRouter.post(
  '/webhooks/dlq/replay-all',
  requireAuth,
  requireRole('admin'),
  async (req: Request, res: Response) => {
    const rawConcurrency = req.body?.concurrency;
    const concurrency =
      typeof rawConcurrency === 'number'
        ? Math.min(50, Math.max(1, Math.floor(rawConcurrency)))
        : 5;

    const service = new WebhookService();
    const summary = await service.replayAll({ concurrency });

    res.status(200).json({ status: 'success', data: summary });
  }
);

/**
 * POST /api/v1/admin/circuit-breaker/:name/reset
 *
 * Resets a single circuit breaker by name back to CLOSED and clears counters.
 * Protected by `adminAuthGuard` (requires admin JWT role or admin API key scope).
 * Emits an audit log entry via `auditService` recording the actor and breaker name.
 *
 * @param req - Express request (extended with AdminAuthenticatedRequest info).
 * @param res - Express response.
 * @param next - Express next function for error propagation.
 * @security Requires admin authentication (JWT admin role or API key admin scope).
 */
adminRouter.post(
  '/circuit-breaker/:name/reset',
  adminAuthGuard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { name } = req.params;
      const performedBy = (req as AdminAuthenticatedRequest).user?.id || 'unknown-admin';

      circuitBreakerRegistry.resetBreaker(name, performedBy);

      res.status(200).json({
        success: true,
        name,
      });
    } catch (error) {
      next(error);
    }
  }
);
