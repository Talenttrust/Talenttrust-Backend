/**
 * @module routes/admin
 * @description Admin-only routes for operational visibility.
 *
 * @route GET /api/v1/admin/queue-health
 * @route GET /api/v1/admin/circuit-breakers
 * @security Requires admin role via JWT authentication
 */

import { Router, Response } from 'express';
import { QueueManager, getWebhookDLQStorage } from '../queue';
import { requireAuth, requireRole } from '../middleware/authorization';
import { circuitBreakerRegistry } from '../circuit-breaker/registry';

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
