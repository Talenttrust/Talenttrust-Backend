import { NextFunction, Request, Response } from 'express';
import { ReputationService } from '../services/reputation.service';
import { AppError, mapErrorToPayload } from '../errors/appError';
import { AuthenticatedRequest } from '../auth/authenticate';
import { isValidReputationRatingPayload, isValidReputationBulkItem } from './reputation.validation';
import { profileToResponseDTO, createRatingBodyToPayload } from '../types/reputation';
import type { GetProfileParamsDTO, CreateRatingBodyDTO, ReputationProfile } from '../types/reputation';
import { parseLimit, resolveCursorQueryParam } from '../contracts/cursor.repository';
import { CURSOR_DEFAULT_LIMIT } from '../contracts/cursor.types';
import { logger, Logger } from '../logger';
import { reputationCache } from '../utils/reputationCache';

/**
 * Extract the request-scoped logger from res.locals, falling back to the singleton logger.
 */
function resolveLogger(res: Response): Logger {
  const log = res.locals['log'] as Logger | undefined;
  if (log) return log;
  return logger;
}

/**
 * Centralized error handler that delegates to Express next() if present, or
 * falls back to serializing the error directly (essential for compatibility
 * with older unit tests).
 */
function handleError(res: Response, next: NextFunction | undefined, error: unknown): void {
  if (typeof next === 'function') {
    next(error);
  } else {
    const requestId =
      typeof res.locals.requestId === 'string' ? res.locals.requestId : 'unknown';
    const correlationId = res.locals.correlationId;
    const { statusCode, payload } = mapErrorToPayload(error, requestId);
    if (correlationId !== undefined) {
      payload.error.correlationId = correlationId;
    }
    res.status(statusCode).json(payload);
  }
}

/**
 * @title Reputation Controller
 * @dev Thin HTTP adapter.
 *
 * All reputation business logic lives in {@link ReputationService}. This
 * controller only:
 *   1. extracts path parameters from the HTTP request,
 *   2. delegates to the service, and
 *   3. serializes the service's response to JSON, or forwards errors.
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
  public static async getProfile(req: Request, res: Response, next?: NextFunction): Promise<void> {
    const log = resolveLogger(res);
    const correlationId = res.locals.correlationId;
    log.info('reputation.getProfile: start', { freelancerId: req.params.id, correlationId });

    try {
      const params: GetProfileParamsDTO = { id: req.params.id };

      if (!params.id) {
        handleError(res, next, new AppError(400, 'bad_request', 'Freelancer ID is required'));
        return;
      }

      // Resolve cursor query parameter
      const cursorResult = resolveCursorQueryParam(req.query ? req.query['cursor'] : undefined);
      if (!cursorResult.ok) {
        handleError(res, next, new AppError(400, 'bad_request', cursorResult.message || 'Invalid cursor'));
        return;
      }

      // Resolve limit query parameter
      let limit = CURSOR_DEFAULT_LIMIT;
      try {
        limit = parseLimit(req.query ? req.query['limit'] : undefined);
      } catch (err: any) {
        handleError(res, next, new AppError(400, 'bad_request', err.message || 'Invalid limit'));
        return;
      }

      const isPaginated =
        req.query && (cursorResult.cursor !== undefined || req.query['limit'] !== undefined);

      // Cache read (skip pagination for cache to keep it simple, or cache raw profiles)
      // Only cache unpaginated requests to avoid cache pollution with pages, matching original implementation
      if (!isPaginated) {
        const cached = reputationCache.get(params.id);
        if (cached !== undefined) {
          const response = {
            status: 'success',
            data: profileToResponseDTO(cached as ReputationProfile),
            ...(correlationId !== undefined && { correlationId }),
          };
          log.info('reputation.getProfile: cache hit', { freelancerId: req.params.id, correlationId });
          res.status(200).json(response);
          return;
        }
      }

      let profile;
      if (isPaginated) {
        profile = ReputationService.getProfilePaginated(params.id, {
          cursor: cursorResult.cursor,
          limit,
        });
      } else {
        profile = ReputationService.getProfile(params.id);
        // Store in cache for subsequent reads
        reputationCache.set(params.id, profile);
      }

      const mappedProfile = profileToResponseDTO(profile);
      const responseData = isPaginated
        ? {
            ...mappedProfile,
            nextCursor: (profile as any).nextCursor,
            hasNextPage: (profile as any).hasNextPage,
            limit: (profile as any).limit,
          }
        : mappedProfile;

      const response = {
        status: 'success',
        data: responseData,
        ...(correlationId !== undefined && { correlationId }),
      };

      log.info('reputation.getProfile: success', { freelancerId: req.params.id, correlationId });
      res.status(200).json(response);
    } catch (error: any) {
      log.error('reputation.getProfile: error', { freelancerId: req.params.id, correlationId, err: error });
      if (error.message === 'Freelancer ID is required') {
        handleError(res, next, new AppError(400, 'bad_request', error.message));
      } else {
        handleError(res, next, error);
      }
    }
  }

  /**
   * POST /api/v1/reputation/:id/rate / PUT /api/v1/reputation/:id
   * Record a new rating and return the recomputed profile.
   */
  public static async createRating(req: AuthenticatedRequest, res: Response, next?: NextFunction): Promise<void> {
    const log = resolveLogger(res);
    const correlationId = res.locals.correlationId;
    log.info('reputation.createRating: start', { freelancerId: req.params.id, correlationId });

    try {
      const { id } = req.params;
      const bodyDTO: CreateRatingBodyDTO = req.body as CreateRatingBodyDTO;

      if (!isValidReputationRatingPayload(bodyDTO)) {
        handleError(res, next, new AppError(400, 'bad_request', 'Invalid payload: reviewerId and a valid integer rating (1–5) are required'));
        return;
      }

      const payload = createRatingBodyToPayload(bodyDTO);
      let updatedProfile = (ReputationService as any).updateProfile
        ? (ReputationService as any).updateProfile(id, payload, correlationId)
        : undefined;

      if (!updatedProfile) {
        updatedProfile = ReputationService.getProfile(id);
      }

      // Evict any stale cached profile so the next GET reflects the new rating.
      reputationCache.invalidate(id);

      const response = {
        status: 'success',
        data: profileToResponseDTO(updatedProfile),
        ...(correlationId !== undefined && { correlationId }),
      };

      log.info('reputation.createRating: success', { freelancerId: req.params.id, correlationId });
      res.status(200).json(response);
    } catch (error) {
      log.error('reputation.createRating: error', { freelancerId: req.params.id, correlationId, err: error });
      sendError(res, error);
    }
  }

  /**
   * POST /api/v1/reputation/bulk
   * Create multiple reputation ratings in a single request.
   */
  public static async createBulkRatings(req: AuthenticatedRequest, res: Response, next?: NextFunction): Promise<void> {
    const log = resolveLogger(res);
    const correlationId = res.locals.correlationId;
    log.info('reputation.createBulkRatings: start', { correlationId });

    try {
      const { items } = req.body as { items: unknown[] };

      if (!Array.isArray(items) || items.length === 0) {
        sendError(res, new AppError(400, 'bad_request', 'Request body must contain a non-empty items array'));
        return;
      }

      const validItems: Array<{ reviewerId: string; targetId: string; rating: number; contextId: string; comment?: string }> = [];
      const validationErrors: Array<{ index: number; error: { code: string; message: string } }> = [];

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (isValidReputationBulkItem(item)) {
          validItems.push(item);
        } else {
          validationErrors.push({
            index: i,
            error: {
              code: 'validation_error',
              message: 'Invalid item: reviewerId, targetId, contextId are required, and rating must be a finite integer (1–5)',
            },
          });
        }
      }

      const serviceResults = validItems.length > 0
        ? ReputationService.createBulkRatings(validItems, correlationId)
        : [];

      const allResults: Array<{ index: number; success: boolean; data?: any; error?: { code: string; message: string } }> = [];

      let viIdx = 0;
      let valErrIdx = 0;
      for (let i = 0; i < items.length; i++) {
        if (valErrIdx < validationErrors.length && validationErrors[valErrIdx].index === i) {
          allResults.push({ index: i, success: false, error: validationErrors[valErrIdx].error });
          valErrIdx++;
        } else {
          allResults.push(serviceResults[viIdx]);
          viIdx++;
        }
      }

      // Evict any stale cached profiles for the successful target IDs.
      for (const item of validItems) {
        reputationCache.invalidate(item.targetId);
      }

      const failures = allResults.filter((r) => !r.success);
      const statusCode = failures.length === 0 ? 200 : 207;

      const response = {
        status: statusCode === 200 ? 'success' : 'partial_failure',
        data: allResults,
        ...(correlationId !== undefined && { correlationId }),
      };

      log.info('reputation.createBulkRatings: success', { correlationId, statusCode });
      res.status(statusCode).json(response);
    } catch (error) {
      log.error('reputation.createBulkRatings: error', { correlationId, err: error });
      sendError(res, error);
    }
  }
}
