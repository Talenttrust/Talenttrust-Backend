export interface ValidReputationRatingPayload {
  reviewerId: string;
  rating: number;
  [key: string]: unknown;
}

export interface ValidBulkRatingItem {
  reviewerId: string;
  targetId: string;
  contextId: string;
  rating: number;
  comment?: string;
}

/**
 * Defense-in-depth validation shared by reputation rating handlers.
 *
 * Route middleware remains the primary validation layer. This preserves the
 * existing handler rules when middleware is bypassed: reviewerId must be
 * truthy and rating must be a finite integer from 1 to 5.
 */
export function isValidReputationRatingPayload(
  payload: unknown,
): payload is ValidReputationRatingPayload {
  if (!payload || typeof payload !== 'object') {
    return false;
  }

  const candidate = payload as Record<string, unknown>;
  const rating = candidate.rating;

  return (
    typeof candidate.reviewerId === 'string' &&
    Boolean(candidate.reviewerId) &&
    typeof rating === 'number' &&
    Number.isFinite(rating) &&
    Number.isInteger(rating) &&
    rating >= 1 &&
    rating <= 5
  );
}

/**
 * Validates a single bulk rating item.
 * Ensures reviewerId, targetId, contextId are truthy strings and rating
 * is a finite integer in [1, 5].
 */
export function isValidReputationBulkItem(
  item: unknown,
): item is ValidBulkRatingItem {
  if (!item || typeof item !== 'object') {
    return false;
  }

  const candidate = item as Record<string, unknown>;
  const rating = candidate.rating;

  return (
    Boolean(candidate.reviewerId) &&
    Boolean(candidate.targetId) &&
    Boolean(candidate.contextId) &&
    typeof rating === 'number' &&
    Number.isFinite(rating) &&
    Number.isInteger(rating) &&
    rating >= 1 &&
    rating <= 5
  );
}
