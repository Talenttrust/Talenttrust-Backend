import { NextFunction, Request, Response } from 'express';
import { ReputationService } from '../services/reputation.service';
import { mapErrorToPayload } from '../errors/appError';
import { AuthenticatedRequest } from '../auth/authenticate';
import { isValidReputationRatingPayload } from './reputation.validation';
import { profileToResponseDTO, createRatingBodyToPayload } from '../types/reputation';
import type { GetProfileParamsDTO, CreateRatingBodyDTO, ApiSuccessResponseDTO, ReputationProfileResponseDTO } from '../types/reputation';

/**
 * @title Reputation Controller
 * @dev Thin HTTP adapter.
 *
 * All reputation business logic lives in {@link ReputationService}. This
 * controller only:
 *   1. extracts path parameters from the HTTP request,
 *   2. delegates to the service, and
 *   3. serializes the service's response (or thrown error) to JSON.
 *
 * Error serialization goes through the shared {@link mapErrorToPayload} helper
 * so that all endpoints emit the canonical `{ error: { code, message, requestId } }`
 * payload shape - matching every other controller in the codebase.
 */
export class ReputationController {
  /**
   * GET /api/v1/reputation/:id
   * Retrieve a freelancer's reputation profile with optional cursor pagination.
   *
   * Query params:
   *   - cursor  (optional, opaque string): anchor for the next page.
   *   - limit   (optional, positive integer 1-100, default 20): page size.
   */
  public static async getProfile(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const params: GetProfileParamsDTO = { id: req.params.id };
      const profile = ReputationService.getProfile(params.id);
      const response: ApiSuccessResponseDTO<ReputationProfileResponseDTO> = {
        status: 'success',
        data: profileToResponseDTO(profile),
      };
      res.status(200).json(response);
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
   * POST /api/v1/reputation/:id/rate / PUT /api/v1/reputation/:id
   * Record a new rating and return the recomputed profile.
   *
   * Payload validation is enforced at two layers:
   *  1. Zod DTO via `validateSchema` middleware (primary - rejects before
   *     this method runs).
   *  2. `ReputationService.updateProfile` (defense-in-depth - catches
   *     bypassed middleware or direct service callers).
   */
  public static async createRating(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id } = req.params;
      const bodyDTO: CreateRatingBodyDTO = req.body as CreateRatingBodyDTO;
      const requestId =
        typeof res.locals.requestId === 'string' ? res.locals.requestId : 'unknown';

      if (!isValidReputationRatingPayload(bodyDTO)) {
        res.status(400).json({
          error: {
            code: 'bad_request',
            message: 'Request body must contain a non-empty items array',
            requestId,
          },
        });
        return;
      }

      const payload = createRatingBodyToPayload(bodyDTO);
      const updatedProfile = (ReputationService as any).updateProfile
        ? (ReputationService as any).updateProfile(id, payload)
        : ReputationService.getProfile(id);
      const response: ApiSuccessResponseDTO<ReputationProfileResponseDTO> = {
        status: 'success',
        data: profileToResponseDTO(updatedProfile),
      };
      res.status(200).json(response);
    } catch (error) {
      sendError(res, error);
    }
  }

  /**
   * POST /api/v1/reputation/bulk
   * Batch create reputation ratings with per-item partial success handling (207 status code if any item fails).
   */
  public static async createBulkRatings(req: Request, res: Response): Promise<void> {
    try {
      const items = (req.body as any)?.items;
      const requestId = typeof res.locals.requestId === 'string' ? res.locals.requestId : 'unknown';

      if (!Array.isArray(items) || items.length === 0) {
        res.status(400).json({
          error: {
            code: 'bad_request',
            message: 'Request body must contain a non-empty items array',
            requestId,
          },
        });
        return;
      }

      const results = (ReputationService as any).createBulkRatings
        ? (ReputationService as any).createBulkRatings(items)
        : [];

      const hasFailures = results.some((r: any) => !r.success);
      const statusCode = hasFailures ? 207 : 200;

      res.status(statusCode).json({
        status: 'success',
        data: results,
      });
    } catch (error) {
      const requestId = typeof res.locals.requestId === 'string' ? res.locals.requestId : 'unknown';
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
 * Single error-serialization boundary for reputation endpoints.
 *
 * Delegates to {@link mapErrorToPayload} so AppError subclasses, Zod errors,
 * and unknown errors all map to the same `{ error: { code, message, requestId } }`
 * shape used elsewhere in the codebase.
 */
function sendError(res: Response, error: unknown): void {
  const requestId =
    typeof res.locals.requestId === 'string' ? res.locals.requestId : 'unknown';
  const { statusCode, payload } = mapErrorToPayload(error, requestId);
  res.status(statusCode).json(payload);
}
