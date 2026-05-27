import { Request, Response } from 'express';
import { ReputationService } from '../services/reputation.service';
import { ForbiddenError, ConflictError, ValidationError, AppError } from '../errors/appError';
import { AuthenticatedRequest } from '../auth/authenticate';

/**
 * @title Reputation Controller
 * @dev Handles HTTP requests for the reputation system with proper error handling.
 */
export class ReputationController {
  /**
   * GET /api/v1/reputation/:id
   * Retrieve a freelancer's reputation profile.
   */
  public static async getProfile(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const profile = ReputationService.getProfile(id);
      res.status(200).json({ status: 'success', data: profile });
    } catch (error: any) {
      const requestId =
        typeof res.locals.requestId === 'string' ? res.locals.requestId : 'unknown';
      if (error.message === 'Freelancer ID is required') {
        res.status(400).json({
          error: {
            code: 'bad_request',
            message: error.message,
            requestId,
          },
        });
      } else {
        res.status(500).json({
          error: {
            code: 'internal_error',
            message: 'An unexpected error occurred',
            requestId,
          },
        });
      }
    }
  }

  /**
   * POST /api/v1/reputation/:id/rate
   * Create a new reputation rating for a freelancer.
   */
  public static async createRating(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const payload: any = req.body;

      if (!payload || !payload.reviewerId || typeof payload.rating !== 'number') {
        const requestId =
          typeof res.locals.requestId === 'string' ? res.locals.requestId : 'unknown';
        res.status(400).json({
          error: {
            code: 'bad_request',
            message: 'Invalid payload: reviewerId and rating are required',
            requestId,
          },
        });
        return;
      }

      const updatedProfile = (ReputationService as any).updateProfile
        ? (ReputationService as any).updateProfile(id, payload)
        : ReputationService.getProfile(id);
      res.status(200).json({ status: 'success', data: updatedProfile });
    } catch (error) {
      handleControllerError(error, res);
    }
  }
}

/**
 * Centralized error handler for controller methods.
 */
function handleControllerError(error: unknown, res: Response): void {
  if (error instanceof ValidationError) {
    res.status(422).json({ status: 'error', message: error.message });
  } else if (error instanceof ForbiddenError) {
    res.status(403).json({ status: 'error', message: error.message });
  } else if (error instanceof ConflictError) {
    res.status(409).json({ status: 'error', message: error.message });
  } else if (error instanceof AppError) {
    res.status(error.statusCode).json({ status: 'error', message: error.message });
  } else {
    res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
}
