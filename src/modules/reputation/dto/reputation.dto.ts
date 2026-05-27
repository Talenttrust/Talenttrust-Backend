import { z } from 'zod';
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

export const updateReputationSchema = z.object({
  reviewerId: z.string().min(1, 'reviewerId is required').openapi({ 
    example: '123e4567-e89b-12d3-a456-426614174000' 
  }),
  contextId: z.string().uuid('contextId must be a valid UUID').openapi({ 
    example: '550e8400-e29b-41d4-a716-446655440000' 
  }),
  rating: z.number()
    .int('Rating must be an integer')
    .min(1, 'Rating must be at least 1')
    .max(5, 'Rating must be at most 5')
    .openapi({ example: 5 }),
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
