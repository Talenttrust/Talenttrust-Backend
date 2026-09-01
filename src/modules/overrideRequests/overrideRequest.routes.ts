/**
 * @module modules/overrideRequests/overrideRequest.routes
 * @description HTTP routes for the high-impact override approval workflow.
 *
 * All routes require authentication via JWT Bearer token.
 * Role requirements:
 *  - Create:  admin, client, freelancer (any authenticated user may request)
 *  - Approve: admin only (separate approver identity required by the service)
 *  - Reject:  admin only
 *  - Apply:   admin only
 *  - List:    admin, auditor
 *  - Get:     admin, auditor, or the original requester (scoped via tenantId)
 *
 * Tenant isolation:
 *  The `tenantId` is taken from `req.user.id` for single-tenant setups.
 *  In multi-tenant deployments this should come from a verified tenant claim
 *  on the JWT. Current implementation uses `req.user.id` as the tenant scope.
 *  NOTE: A proper multi-tenant system would require a dedicated `tenantId`
 *  claim on the JWT — this is intentionally documented as a TODO for
 *  production hardening.
 *
 * Error responses:
 *  All errors use the standard envelope: { error: { code, message, requestId } }
 *
 * @route GET    /api/v1/override-requests         — list
 * @route POST   /api/v1/override-requests         — create
 * @route GET    /api/v1/override-requests/:id     — get
 * @route POST   /api/v1/override-requests/:id/approve — approve
 * @route POST   /api/v1/override-requests/:id/reject  — reject
 * @route POST   /api/v1/override-requests/:id/apply   — apply
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { requireAuth, requireRole } from '../../middleware/authorization';
import { validateRequest, validateParams, validateQuery, validateSchema } from '../../middleware/validate.middleware';
import { OverrideRequestService } from './overrideRequest.service';
import {
  OverrideRequestNotFoundError,
  OverrideRequestSelfApprovalError,
  OverrideRequestExpiredError,
  OverrideRequestInvalidTransitionError,
  OverrideRequestAlreadyAppliedError,
} from './overrideRequest.service';
import {
  createOverrideRequestBodySchema,
  rejectOverrideRequestBodySchema,
  overrideRequestParamsSchema,
  listOverrideRequestsQuerySchema,
} from './overrideRequest.schemas';
import type { AuthenticatedRequest } from '../../lib/types';
import { getDb } from '../../db/database';
import { createLogger } from '../../logger';

const log = createLogger({ service: 'override-requests-routes' });

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Creates the override requests router.
 *
 * @param service - Optional service override for testing. Defaults to a
 *   production instance backed by the shared SQLite database.
 */
export function createOverrideRequestsRouter(
  service?: OverrideRequestService,
): Router {
  const router = Router();

  // Lazily resolve the service so tests can inject mocks
  const getService = (): OverrideRequestService => {
    if (service) return service;
    return new OverrideRequestService(getDb());
  };

  // ── Helper: extract tenantId from JWT ─────────────────────────────────────
  //
  // Security note: In a full multi-tenant deployment, `tenantId` should come
  // from a verified JWT claim (e.g. `tenant_id`). In the current
  // single-tenant setup we use a shared `default` tenant so that any admin
  // can create a request and any other admin can approve it. Non-admin users
  // get their own user-scoped tenant, limiting their visibility to their own
  // requests.
  //
  const getTenantId = (req: AuthenticatedRequest): string => {
    if (req.user!.role === 'admin' || req.user!.role === 'auditor') {
      return 'default';
    }
    return req.user!.id;
  };

  // ── Helper: serialize service errors into the standard error envelope ─────
  const handleServiceError = (
    err: unknown,
    res: Response,
    requestId: string,
  ): boolean => {
    if (
      err instanceof OverrideRequestNotFoundError ||
      err instanceof OverrideRequestSelfApprovalError ||
      err instanceof OverrideRequestExpiredError ||
      err instanceof OverrideRequestInvalidTransitionError ||
      err instanceof OverrideRequestAlreadyAppliedError
    ) {
      res.status((err as { statusCode: number }).statusCode).json({
        error: {
          code: (err as { code: string }).code,
          message: err.message,
          requestId,
        },
      });
      return true;
    }
    return false;
  };

  // ── GET / — list override requests ────────────────────────────────────────
  router.get(
    '/',
    requireAuth,
    requireRole('admin', 'auditor'),
    validateQuery(listOverrideRequestsQuerySchema),
    (req: Request, res: Response, next: NextFunction) => {
      try {
        const authReq = req as AuthenticatedRequest;
        const tenantId = getTenantId(authReq);
        const query = req.query as {
          status?: string;
          requesterId?: string;
          resourceType?: string;
          resourceId?: string;
          limit?: number;
          offset?: number;
        };

        const result = getService().list({
          tenantId,
          status: query.status as import('./overrideRequest.types').OverrideRequestStatus | undefined,
          requesterId: query.requesterId,
          resourceType: query.resourceType,
          resourceId: query.resourceId,
          limit: query.limit,
          offset: query.offset,
        });

        res.status(200).json({ data: result });
      } catch (err) {
        next(err);
      }
    },
  );

  // ── POST / — create a new override request ────────────────────────────────
  router.post(
    '/',
    requireAuth,
    validateRequest(createOverrideRequestBodySchema),
    (req: Request, res: Response, next: NextFunction) => {
      try {
        const authReq = req as AuthenticatedRequest;
        const tenantId = getTenantId(authReq);
        const requesterId = authReq.user!.id;
        const requestId = String(res.locals.requestId ?? 'unknown');

        const body = req.body as import('./overrideRequest.schemas').CreateOverrideRequestBody;

        // Clamp TTL to [1 minute, 7 days]
        let ttlMs: number | undefined = body.ttlMs;
        if (ttlMs !== undefined) {
          ttlMs = Math.max(60_000, Math.min(7 * 24 * 60 * 60 * 1000, ttlMs));
        }

        const request = getService().create({
          tenantId,
          requesterId,
          resourceType: body.resourceType,
          resourceId: body.resourceId,
          action: body.action,
          reason: body.reason,
          ttlMs,
          metadata: body.metadata,
        });

        log.info('Override request created via HTTP', {
          requestId,
          overrideId: request.id,
        });

        res.status(201).json({ data: request });
      } catch (err) {
        next(err);
      }
    },
  );

  // ── GET /:id — get a single override request ──────────────────────────────
  router.get(
    '/:id',
    requireAuth,
    validateParams(overrideRequestParamsSchema),
    (req: Request, res: Response, next: NextFunction) => {
      try {
        const authReq = req as AuthenticatedRequest;
        const tenantId = getTenantId(authReq);
        const { id } = req.params;

        const request = getService().getById(id, tenantId);

        res.status(200).json({ data: request });
      } catch (err) {
        const requestId = String(res.locals.requestId ?? 'unknown');
        if (handleServiceError(err, res, requestId)) return;
        next(err);
      }
    },
  );

  // ── POST /:id/approve — approve an override request ───────────────────────
  router.post(
    '/:id/approve',
    requireAuth,
    requireRole('admin'),
    validateParams(overrideRequestParamsSchema),
    (req: Request, res: Response, next: NextFunction) => {
      try {
        const authReq = req as AuthenticatedRequest;
        const tenantId = getTenantId(authReq);
        const approverId = authReq.user!.id;
        const { id } = req.params;
        const requestId = String(res.locals.requestId ?? 'unknown');

        const request = getService().approve({
          requestId: id,
          tenantId,
          approverId,
        });

        log.info('Override request approved via HTTP', {
          requestId,
          overrideId: id,
          approverId,
        });

        res.status(200).json({ data: request });
      } catch (err) {
        const requestId = String(res.locals.requestId ?? 'unknown');
        if (handleServiceError(err, res, requestId)) return;
        next(err);
      }
    },
  );

  // ── POST /:id/reject — reject an override request ─────────────────────────
  router.post(
    '/:id/reject',
    requireAuth,
    requireRole('admin'),
    // Single combined parse: validateParams alone would clobber req.body
    validateSchema(z.object({
      params: overrideRequestParamsSchema,
      body: rejectOverrideRequestBodySchema,
    })),
    (req: Request, res: Response, next: NextFunction) => {
      try {
        const authReq = req as AuthenticatedRequest;
        const tenantId = getTenantId(authReq);
        const approverId = authReq.user!.id;
        const { id } = req.params;
        const requestId = String(res.locals.requestId ?? 'unknown');
        const body = req.body as import('./overrideRequest.schemas').RejectOverrideRequestBody;

        const request = getService().reject({
          requestId: id,
          tenantId,
          approverId,
          rejectionReason: body.rejectionReason,
        });

        log.info('Override request rejected via HTTP', {
          requestId,
          overrideId: id,
          approverId,
        });

        res.status(200).json({ data: request });
      } catch (err) {
        const requestId = String(res.locals.requestId ?? 'unknown');
        if (handleServiceError(err, res, requestId)) return;
        next(err);
      }
    },
  );

  // ── POST /:id/apply — apply an approved override request ──────────────────
  router.post(
    '/:id/apply',
    requireAuth,
    requireRole('admin'),
    validateParams(overrideRequestParamsSchema),
    (req: Request, res: Response, next: NextFunction) => {
      try {
        const authReq = req as AuthenticatedRequest;
        const tenantId = getTenantId(authReq);
        const actorId = authReq.user!.id;
        const { id } = req.params;
        const requestId = String(res.locals.requestId ?? 'unknown');

        const request = getService().apply({
          requestId: id,
          tenantId,
          actorId,
        });

        log.info('Override request applied via HTTP', {
          requestId,
          overrideId: id,
          actorId,
        });

        res.status(200).json({ data: request });
      } catch (err) {
        const requestId = String(res.locals.requestId ?? 'unknown');
        if (handleServiceError(err, res, requestId)) return;
        next(err);
      }
    },
  );

  return router;
}
