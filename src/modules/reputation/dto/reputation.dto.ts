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

registry.register('UpdateReputation', updateReputationSchema);
