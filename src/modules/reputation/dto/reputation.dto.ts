import { z } from '../../../docs/setup-zod';
import { registry } from '../../../docs/openapi-registry';

/**
 * Validates that a comment does not contain excessive repetitive content.
 * Spam detection: rejects if any single character comprises >50% of the text.
 */
function isNotSpamComment(comment: string | undefined): boolean {
  if (!comment || comment.trim().length === 0) {
    return true; // Empty comments handled by other validations
  }

  const charCount: Record<string, number> = {};
  for (const char of comment) {
    charCount[char] = (charCount[char] || 0) + 1;
  }
  
  const maxCharCount = Math.max(...Object.values(charCount));
  const repetitionRatio = maxCharCount / comment.length;
  
  // Reject if any character comprises more than 50% of the text
  return repetitionRatio <= 0.5;
}

/**
 * Route params schema for reputation endpoints.
 *
 * Validates the `:id` path parameter on both GET and PUT /api/v1/reputation/:id.
 * Express only routes to this handler when `:id` is non-empty, but we still
 * enforce an explicit non-empty-string constraint here so that the validation
 * layer documents and owns that invariant rather than relying on implicit
 * routing behaviour.
 */
export const reputationParamsSchema = z.object({
  id: z.string().min(1, 'id is required').openapi({ example: 'freelancer-uuid-here' }),
});

/**
 * DTO schema for submitting a reputation rating.
 *
 * Rating constraints:
 *  - Must be an integer (no decimals)
 *  - Minimum value: 1 (lowest possible rating)
 *  - Maximum value: 5 (highest possible rating)
 *  - NaN and Infinity are explicitly rejected by `.finite()`
 *
 * These constraints mirror the service-layer decay math, which only
 * guarantees range preservation when all input ratings are in [1, 5].
 * Out-of-range or non-integer values are rejected at the boundary here
 * before they can reach score computation.
 */
export const updateReputationSchema = z.object({
  reviewerId: z.string().min(1, 'reviewerId is required').openapi({ 
    example: '123e4567-e89b-12d3-a456-426614174000' 
  }),
  contextId: z.string().uuid('contextId must be a valid UUID').openapi({ 
    example: '550e8400-e29b-41d4-a716-446655440000' 
  }),
  /**
   * Integer rating in the range [1, 5].
   * NaN, Infinity, decimals, and values outside [1, 5] are rejected with a 400.
   */
  rating: z.number()
    .finite('Rating must be a finite number')
    .int('Rating must be an integer')
    .min(1, 'Rating must be at least 1')
    .max(5, 'Rating must be at most 5')
    .openapi({
      example: 5,
      description: 'Integer rating value between 1 (lowest) and 5 (highest), inclusive.',
    }),
  comment: z.string()
    .max(1000, 'Comment must not exceed 1000 characters')
    .refine(
      (val: string) => isNotSpamComment(val),
      'Comment contains excessive repetitive content'
    )
    .optional()
    .openapi({ example: 'Excellent freelancer, highly recommended!' }),
});

/**
 * Response schema for a single review entry within a reputation profile.
 * Used for documentation and type inference only — not enforced at runtime
 * on the outbound response.
 */
export const reviewSchema = z.object({
  reviewerId: z.string().openapi({ example: 'reviewer-uuid' }),
  rating: z.number().int().min(1).max(5).openapi({ example: 4 }),
  comment: z.string().optional().openapi({ example: 'Great work!' }),
  createdAt: z.string().datetime().openapi({ example: '2024-01-01T00:00:00.000Z' }),
});

/**
 * Response schema for the reputation profile returned by GET /api/v1/reputation/:id.
 *
 * This schema documents and provides TypeScript types for the response payload.
 * It is not enforced at runtime on the outbound response (the service layer owns
 * the shape), but it serves as a contract for consumers and can be used to
 * validate test expectations.
 */
export const reputationProfileResponseSchema = z.object({
  freelancerId: z.string().openapi({ example: 'freelancer-uuid' }),
  score: z.number().min(0).max(5).openapi({ example: 4.25 }),
  jobsCompleted: z.number().int().min(0).openapi({ example: 10 }),
  totalRatings: z.number().int().min(0).openapi({ example: 5 }),
  reviews: z.array(reviewSchema),
  lastUpdated: z.string().datetime().openapi({ example: '2024-01-01T00:00:00.000Z' }),
  weightedScore: z.number().min(0).max(5).openapi({ example: 4.10 }),
  scoreAlgorithm: z.string().openapi({ example: 'exp-decay-v1' }),
});

export const MAX_BULK_BATCH_SIZE = 50;

export const bulkRatingItemSchema = z.object({
  reviewerId: z.string().min(1, 'reviewerId is required'),
  targetId: z.string().min(1, 'targetId is required'),
  contextId: z.string().uuid('contextId must be a valid UUID'),
  rating: z.number()
    .finite('Rating must be a finite number')
    .int('Rating must be an integer')
    .min(1, 'Rating must be at least 1')
    .max(5, 'Rating must be at most 5'),
  comment: z.string()
    .max(1000, 'Comment must not exceed 1000 characters')
    .refine(
      (val: string) => isNotSpamComment(val),
      'Comment contains excessive repetitive content'
    )
    .optional(),
});

export const bulkReputationSchema = z.object({
  body: z.object({
    items: z.array(bulkRatingItemSchema)
      .min(1, 'At least one item is required')
      .max(MAX_BULK_BATCH_SIZE, `Batch size must not exceed ${MAX_BULK_BATCH_SIZE}`),
  }),
});

/**
 * DTO schema for submitting a manual reputation correction.
 *
 * This endpoint is strictly separated from ordinary event ingestion pathways.
 * It requires:
 * - A mandatory reason (10-5000 characters) explaining the correction
 * - A mandatory reference (e.g., ticket number, dispute ID, escalation ID)
 * - A valid contextId (UUID) linking to the associated contract
 *
 * Security:
 * - References containing URLs with credentials, tokens, or secrets are rejected
 * - Only authorized operator roles (admin, support, moderator, superadmin) may call this endpoint
 * - All corrections are audited with WARNING severity and full provenance
 */
export const correctReputationSchema = z.object({
  reason: z.string()
    .min(10, 'Reason must be at least 10 characters')
    .max(5000, 'Reason must not exceed 5000 characters')
    .openapi({ example: 'Correction due to verified dispute resolution in favor of freelancer' }),
  reference: z.string()
    .min(1, 'Reference is required')
    .max(255, 'Reference must not exceed 255 characters')
    .refine(
      (val: string) => !/https?:\/\/[^:]+:[^@]+@/i.test(val),
      'Reference must not contain URLs with embedded credentials'
    )
    .refine(
      (val: string) => !/https?:\/\/[^\s]+\?(?:.*[&?])?(?:token|key|secret|password|auth|access_token|api_key)=[^&\s]+/i.test(val),
      'Reference must not contain URLs with token/query parameters'
    )
    .openapi({ example: 'DISP-2024-001234' }),
  contextId: z.string().uuid('contextId must be a valid UUID').openapi({
    example: '550e8400-e29b-41d4-a716-446655440000',
  }),
});

/**
 * Response schema for a reputation correction entry.
 */
export const reputationCorrectionResponseSchema = z.object({
  id: z.string().uuid().openapi({ example: '123e4567-e89b-12d3-a456-426614174000' }),
  targetId: z.string().openapi({ example: 'freelancer-uuid' }),
  contextId: z.string().uuid().openapi({ example: 'contract-uuid' }),
  reason: z.string().openapi({ example: 'Correction due to verified dispute resolution' }),
  reference: z.string().openapi({ example: 'DISP-2024-001234' }),
  beforeScore: z.number().min(0).max(5).openapi({ example: 3.5 }),
  afterScore: z.number().min(0).max(5).openapi({ example: 4.0 }),
  beforeWeighted: z.number().min(0).max(5).openapi({ example: 3.45 }),
  afterWeighted: z.number().min(0).max(5).openapi({ example: 3.95 }),
  beforeTotal: z.number().int().min(0).openapi({ example: 10 }),
  afterTotal: z.number().int().min(0).openapi({ example: 10 }),
  operatorId: z.string().openapi({ example: 'admin-uuid' }),
  operatorRole: z.string().openapi({ example: 'admin' }),
  createdAt: z.string().datetime().openapi({ example: '2024-01-15T10:30:00.000Z' }),
});

/** Inferred TypeScript types from the schemas above. */
export type ReputationParamsDto = z.infer<typeof reputationParamsSchema>;
export type UpdateReputationDto = z.infer<typeof updateReputationSchema>;
export type CorrectReputationDto = z.infer<typeof correctReputationSchema>;
export type ReputationProfileResponseDto = z.infer<typeof reputationProfileResponseSchema>;
export type ReputationCorrectionResponseDto = z.infer<typeof reputationCorrectionResponseSchema>;

registry.register('UpdateReputation', updateReputationSchema);
registry.register('ReputationProfileResponse', reputationProfileResponseSchema);
registry.register('CorrectReputation', correctReputationSchema);
registry.register('ReputationCorrectionResponse', reputationCorrectionResponseSchema);
