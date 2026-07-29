/**
 * @title Reputation Profile Types
 * @dev NatSpec: Types and interfaces for the Freelancer Reputation Profile API.
 */

export interface Review {
  reviewerId: string;
  rating: number;      // 1-5 scale
  comment?: string;
  createdAt: string;   // ISO 8601 date string
}

export interface ReputationProfile {
  freelancerId: string;
  score: number;       // Average of all ratings, 0.0 - 5.0
  jobsCompleted: number;
  totalRatings: number;
  reviews: Review[];
  lastUpdated: string; // ISO 8601 date string
  weightedScore: number;    // Recency-weighted score (0.0 - 5.0 range)
  scoreAlgorithm: string;   // Algorithm identifier, e.g. "exp-decay-v1"
}

/**
 * Paginated reputation profile returned when cursor-based pagination is active.
 * Extends {@link ReputationProfile} with opaque-cursor navigation fields.
 */
export interface PaginatedReputationProfile extends ReputationProfile {
  /** Opaque cursor to pass for the next page of reviews, or null on the last page. */
  nextCursor: string | null;
  /** Convenience flag; true when `nextCursor` is non-null. */
  hasNextPage: boolean;
  /** Page size used for this request (clamped to [1, 100]). */
  limit: number;
}

export interface UpdateReputationPayload {
  reviewerId: string;
  rating: number;
  comment?: string;
  jobCompleted?: boolean;
  contextId?: string;
}

// ── Request DTOs ────────────────────────────────────────────────────────────

export interface GetProfileParamsDTO {
  id: string;
}

export interface CreateRatingBodyDTO {
  reviewerId: string;
  contextId: string;
  rating: number;
  comment?: string;
}

// ── Response DTOs ────────────────────────────────────────────────────────────

export interface ReviewResponseDTO {
  reviewerId: string;
  rating: number;
  comment?: string;
  createdAt: string;
}

export interface ReputationProfileResponseDTO {
  freelancerId: string;
  score: number;
  jobsCompleted: number;
  totalRatings: number;
  reviews: ReviewResponseDTO[];
  lastUpdated: string;
  weightedScore: number;
  scoreAlgorithm: string;
}

export interface ApiSuccessResponseDTO<T> {
  status: 'success';
  data: T;
}

export interface ApiErrorDetailDTO {
  code: string;
  message: string;
  requestId?: string;
}

export interface ApiErrorResponseDTO {
  error: ApiErrorDetailDTO;
}

// ── Mapping Functions ────────────────────────────────────────────────────────

export function reviewToResponseDTO(review: Review): ReviewResponseDTO {
  return {
    reviewerId: review.reviewerId,
    rating: review.rating,
    comment: review.comment,
    createdAt: review.createdAt,
  };
}

export function profileToResponseDTO(profile: ReputationProfile): ReputationProfileResponseDTO {
  return {
    freelancerId: profile.freelancerId,
    score: profile.score,
    jobsCompleted: profile.jobsCompleted,
    totalRatings: profile.totalRatings,
    reviews: profile.reviews.map(reviewToResponseDTO),
    lastUpdated: profile.lastUpdated,
    weightedScore: profile.weightedScore,
    scoreAlgorithm: profile.scoreAlgorithm,
  };
}

export function createRatingBodyToPayload(dto: CreateRatingBodyDTO): UpdateReputationPayload {
  return {
    reviewerId: dto.reviewerId,
    rating: dto.rating,
    comment: dto.comment,
    contextId: dto.contextId,
  };
}
