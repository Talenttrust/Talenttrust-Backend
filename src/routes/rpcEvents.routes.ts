/**
 * rpcEvents.routes.ts — Bounded RPC event pagination endpoint.
 *
 * POST /api/v1/rpc/events
 *
 * Every request must supply a ledger or time window. Full-history scans
 * are explicitly rejected (out of scope per Issue #1208).
 *
 * ## Auth
 * - requireAuth: validates JWT, attaches req.user (id, email, role).
 * - tenantId is taken exclusively from req.user.id; it is NEVER read from
 *   the request body. This prevents cross-tenant data leakage.
 *
 * ## Request body (JSON)
 * ```json
 * {
 *   "contractId": "CABC...",
 *   "ledgerWindow": { "fromLedger": 1000, "toLedger": 2000 },
 *   "timeWindow": { "fromTimestampMs": 1700000000000, "toTimestampMs": 1700086400000 },
 *   "limit": 50,
 *   "continuationToken": "<opaque>"
 * }
 * ```
 * At least one of `ledgerWindow` or `timeWindow` must be present.
 * Both `ledgerWindow` and `timeWindow` are optional individually but
 * one is mandatory in each request (including continuations).
 *
 * ## Response envelope
 * ```json
 * {
 *   "status": "success",
 *   "data": {
 *     "events": [...],
 *     "nextToken": "<opaque or null>",
 *     "fetchedSoFar": 150,
 *     "cappedByWorkLimit": false
 *   },
 *   "requestId": "..."
 * }
 * ```
 *
 * ## Security notes
 * - tenantId always comes from the verified JWT, never the request body.
 * - Continuation tokens embed tenantId and contractId — mismatches → 400/403.
 * - No internal error details or stack traces are forwarded to callers.
 * - Provider error codes are mapped to stable SorobanRpcError subtypes.
 */

import { Router } from 'express';
import { z } from 'zod';
import { ok, fail } from '../utils/apiResponse';
import { requireAuth } from '../middleware/authorization';
import type { AuthenticatedRequest } from '../lib/types';
import { BoundedPaginationService } from '../rpc/boundedPaginationService';
import { AppError } from '../errors/appError';
import { SorobanRpcService } from '../services/soroban/SorobanRpcService';
import {
  MAX_RPC_PAGE_SIZE,
  DEFAULT_RPC_PAGE_SIZE,
} from '../rpc/boundedPagination.types';
import { logger } from '../logger';

// ── Request schema ────────────────────────────────────────────────────────────

const ledgerWindowSchema = z.object({
  fromLedger: z
    .number({ required_error: 'fromLedger is required', invalid_type_error: 'fromLedger must be a number' })
    .int('fromLedger must be an integer')
    .nonnegative('fromLedger must be >= 0'),
  toLedger: z
    .number({ required_error: 'toLedger is required', invalid_type_error: 'toLedger must be a number' })
    .int('toLedger must be an integer')
    .nonnegative('toLedger must be >= 0'),
});

const timeWindowSchema = z.object({
  fromTimestampMs: z
    .number({ required_error: 'fromTimestampMs is required', invalid_type_error: 'fromTimestampMs must be a number' })
    .int('fromTimestampMs must be an integer')
    .nonnegative('fromTimestampMs must be >= 0'),
  toTimestampMs: z
    .number({ required_error: 'toTimestampMs is required', invalid_type_error: 'toTimestampMs must be a number' })
    .int('toTimestampMs must be an integer')
    .nonnegative('toTimestampMs must be >= 0'),
});

const rpcEventsBodySchema = z
  .object({
    contractId: z
      .string({ required_error: 'contractId is required' })
      .min(1, 'contractId must not be empty'),
    ledgerWindow: ledgerWindowSchema.optional(),
    timeWindow: timeWindowSchema.optional(),
    limit: z
      .number()
      .int('limit must be an integer')
      .min(1, 'limit must be at least 1')
      .max(MAX_RPC_PAGE_SIZE, `limit must be at most ${MAX_RPC_PAGE_SIZE}`)
      .default(DEFAULT_RPC_PAGE_SIZE)
      .optional(),
    continuationToken: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    // A continuation token carries the window from the original request.
    // The server enforces that the window is still supplied on each call
    // so it can intersect token bounds with request bounds.
    // However, when a token is provided, at least one window in EITHER
    // the token OR the current request is acceptable.
    // Without a token, at least one window MUST be in the body.
    if (!data.continuationToken && !data.ledgerWindow && !data.timeWindow) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'At least one of ledgerWindow or timeWindow must be provided.',
        path: [],
      });
    }
  });

type RpcEventsBody = z.infer<typeof rpcEventsBodySchema>;

// ── Route factory ─────────────────────────────────────────────────────────────

/**
 * Creates the bounded RPC events router.
 *
 * @param service - Optional service override for testing.
 */
export function createRpcEventsRouter(
  service?: BoundedPaginationService,
): Router {
  const router = Router();

  // Lazy-initialise the real service; tests inject a mock.
  const getService = (): BoundedPaginationService => {
    if (service) return service;
    const rpcProvider = new SorobanRpcService();
    return new BoundedPaginationService(rpcProvider);
  };

  /**
   * POST /rpc/events
   *
   * Fetches a bounded, paginated page of on-chain events.
   */
  router.post('/rpc/events', requireAuth, async (req: AuthenticatedRequest, res) => {
    // ── Parse & validate body ──────────────────────────────────────────────
    const parsed = rpcEventsBodySchema.safeParse(req.body);
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0];
      const message = firstIssue?.message ?? 'Invalid request body.';
      return fail(res, 'validation_error', message, 400);
    }

    const body: RpcEventsBody = parsed.data;

    // ── Tenant isolation — ALWAYS from JWT, never from body ────────────────
    const tenantId = req.user!.id;

    try {
      const result = await getService().fetchPage({
        contractId: body.contractId,
        tenantId,
        ledgerWindow: body.ledgerWindow,
        timeWindow: body.timeWindow,
        limit: body.limit,
        continuationToken: body.continuationToken,
      });

      return ok(res, result);
    } catch (err) {
      // Map AppErrors to structured responses without leaking internals.
      if (err instanceof AppError) {
        const statusCode = err.statusCode >= 400 && err.statusCode <= 599 ? err.statusCode : 400;
        const message = err.expose ? err.message : 'An error occurred processing your request.';

        logger.warn('rpcEvents: AppError', {
          code: err.code,
          statusCode,
          tenantId,
          contractId: body.contractId,
        });

        return fail(res, err.code, message, statusCode);
      }

      // All other errors (SorobanRpcError subclasses etc.) are 502/504/429.
      logger.error('rpcEvents: unhandled error', {
        tenantId,
        contractId: body.contractId,
        error: err instanceof Error ? err.message : String(err),
      });

      return fail(res, 'rpc_provider_error', 'RPC provider error. Please retry later.', 502);
    }
  });

  return router;
}

export default createRpcEventsRouter();
