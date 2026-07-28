/**
 * @module deployRoutes
 * @description HTTP routes for blue-green deployment operations.
 *
 * All endpoints require admin authentication via JWT or API key.
 * Routes are mounted at `/api/v1/admin/deploy`.
 *
 * @security
 *  - `adminAuthGuard` must pass before any handler executes.
 *  - `switchToGreen` is idempotent — calling it when already green is a no-op.
 *  - `rollback` is idempotent — calling it when already blue is a no-op.
 */

import type { Request, Response, NextFunction } from 'express';
import { Router } from 'express';
import { switchToGreen, rollback, getStatus, setHealthChecker, DeploymentState } from '../deploy';
import { adminAuthGuard, AdminAuthenticatedRequest } from '../middleware/adminAuthGuard';

const router = Router();

/**
 * GET /api/v1/admin/deploy/status
 *
 * Returns the current deployment state without modifying it.
 *
 * @returns 200 with deployment state JSON.
 */
router.get(
  '/status',
  adminAuthGuard,
  async (_req: AdminAuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const state: DeploymentState = await getStatus();
      res.status(200).json({
        status: 'success',
        data: state,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({
        error: {
          code: 'internal_error',
          message: `Failed to get deployment status: ${message}`,
        },
      });
    }
  },
);

/**
 * POST /api/v1/admin/deploy/switch-green
 *
 * Promotes the green instance to active.
 *
 * - Idempotent when green is already active (returns 200).
 * - Throws 502 when green is unhealthy within timeout.
 * - Throws 409 when a switch is already in progress.
 *
 * @returns 202 on success, 200 if already green.
 */
router.post(
  '/switch-green',
  adminAuthGuard,
  async (_req: AdminAuthenticatedRequest, res: Response): Promise<void> => {
    try {
      await switchToGreen();
      res.status(202).json({
        status: 'success',
        message: 'Switched to green successfully.',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';

      if (message === 'Switch already in progress') {
        res.status(409).json({
          error: {
            code: 'conflict',
            message: 'A deployment switch is already in progress.',
          },
        });
        return;
      }

      if (message === 'Green not ready') {
        res.status(502).json({
          error: {
            code: 'bad_gateway',
            message: 'Green instance is not healthy. Switch aborted.',
          },
        });
        return;
      }

      res.status(500).json({
        error: {
          code: 'internal_error',
          message: `Failed to switch to green: ${message}`,
        },
      });
    }
  },
);

/**
 * POST /api/v1/admin/deploy/rollback
 *
 * Rolls back to the previous (blue) instance.
 *
 * - Idempotent when already on blue (returns 200 with "no-op").
 *
 * @returns 200 on success.
 */
router.post(
  '/rollback',
  adminAuthGuard,
  async (_req: AdminAuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const stateBefore: DeploymentState = await getStatus();

      if (stateBefore.activeColor === 'blue') {
        res.status(200).json({
          status: 'success',
          message: 'Already on blue. No rollback needed.',
          data: stateBefore,
        });
        return;
      }

      await rollback();
      const stateAfter: DeploymentState = await getStatus();

      res.status(200).json({
        status: 'success',
        message: 'Rolled back to blue successfully.',
        data: stateAfter,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({
        error: {
          code: 'internal_error',
          message: `Failed to rollback: ${message}`,
        },
      });
    }
  },
);

export { router as deployRouter };
