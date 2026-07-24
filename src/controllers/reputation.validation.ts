export interface ValidReputationRatingPayload {
  reviewerId: string;
  rating: number;
  [key: string]: unknown;
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
    Boolean(candidate.reviewerId) &&
    typeof rating === 'number' &&
    Number.isFinite(rating) &&
    Number.isInteger(rating) &&
    rating >= 1 &&
    rating <= 5
  );
}
