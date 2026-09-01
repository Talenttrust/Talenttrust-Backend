/**
 * @module modules/overrideRequests/overrideRequest.schemas
 * @description Zod validation schemas for the override request API.
 *
 * All schemas strip unknown fields (`.strict()` is intentionally avoided;
 * unknown fields are silently stripped to be forward-compatible while still
 * preventing injection via unexpected body fields).
 */

import { z } from 'zod';

/** Minimum / maximum character counts for the reason field (mirrors DB CHECK). */
const REASON_MIN = 10;
const REASON_MAX = 5000;

/**
 * POST /api/v1/override-requests — create a new request.
 */
export const createOverrideRequestBodySchema = z.object({
  resourceType: z
    .string()
    .min(1, 'resourceType is required')
    .max(100, 'resourceType must be at most 100 characters'),

  resourceId: z
    .string()
    .min(1, 'resourceId is required')
    .max(255, 'resourceId must be at most 255 characters'),

  action: z
    .string()
    .min(1, 'action is required')
    .max(100, 'action must be at most 100 characters'),

  reason: z
    .string()
    .min(REASON_MIN, `reason must be at least ${REASON_MIN} characters`)
    .max(REASON_MAX, `reason must be at most ${REASON_MAX} characters`),

  /**
   * Optional TTL override in milliseconds.
   * Clamped to [1 minute, 7 days] at the service layer.
   * Defaults to 24 hours when omitted.
   */
  ttlMs: z
    .number()
    .int('ttlMs must be an integer')
    .positive('ttlMs must be positive')
    .optional(),

  /**
   * Arbitrary structured context for this request.
   * Must be sanitised by the caller — do not put raw PII or secrets here.
   */
  metadata: z.record(z.unknown()).optional(),
});

export type CreateOverrideRequestBody = z.infer<typeof createOverrideRequestBodySchema>;

/**
 * POST /api/v1/override-requests/:id/approve
 */
export const approveOverrideRequestBodySchema = z.object({});

/**
 * POST /api/v1/override-requests/:id/reject
 */
export const rejectOverrideRequestBodySchema = z.object({
  rejectionReason: z
    .string()
    .max(2000, 'rejectionReason must be at most 2000 characters')
    .optional(),
});

export type RejectOverrideRequestBody = z.infer<typeof rejectOverrideRequestBodySchema>;

/**
 * POST /api/v1/override-requests/:id/apply
 */
export const applyOverrideRequestBodySchema = z.object({});

/**
 * Path parameter schema — :id must be a non-empty string.
 */
export const overrideRequestParamsSchema = z.object({
  id: z.string().min(1, 'id is required'),
});

/**
 * Query string schema for GET /api/v1/override-requests
 */
export const listOverrideRequestsQuerySchema = z.object({
  status: z
    .enum(['requested', 'approved', 'rejected', 'applied', 'expired'])
    .optional(),

  requesterId: z.string().optional(),

  resourceType: z.string().optional(),

  resourceId: z.string().optional(),

  limit: z
    .string()
    .regex(/^\d+$/, 'limit must be a non-negative integer')
    .transform(Number)
    .pipe(z.number().int().min(1).max(200))
    .optional(),

  offset: z
    .string()
    .regex(/^\d+$/, 'offset must be a non-negative integer')
    .transform(Number)
    .pipe(z.number().int().min(0))
    .optional(),
});

export type ListOverrideRequestsQuery = z.infer<typeof listOverrideRequestsQuerySchema>;
