import {
  reviewToResponseDTO,
  profileToResponseDTO,
  createRatingBodyToPayload,
} from './reputation';
import type { Review, ReputationProfile, CreateRatingBodyDTO } from './reputation';

describe('reviewToResponseDTO', () => {
  it('maps a full review with optional comment', () => {
    const review: Review = {
      reviewerId: 'reviewer-1',
      rating: 4,
      comment: 'Great work',
      createdAt: '2024-01-01T00:00:00.000Z',
    };

    const result = reviewToResponseDTO(review);

    expect(result).toEqual({
      reviewerId: 'reviewer-1',
      rating: 4,
      comment: 'Great work',
      createdAt: '2024-01-01T00:00:00.000Z',
    });
  });

  it('maps a review without optional comment', () => {
    const review: Review = {
      reviewerId: 'reviewer-2',
      rating: 5,
      createdAt: '2024-02-01T00:00:00.000Z',
    };

    const result = reviewToResponseDTO(review);

    expect(result.comment).toBeUndefined();
    expect(result).toEqual({
      reviewerId: 'reviewer-2',
      rating: 5,
      createdAt: '2024-02-01T00:00:00.000Z',
    });
  });

  it('does not mutate the original review', () => {
    const review: Review = {
      reviewerId: 'reviewer-1',
      rating: 3,
      createdAt: '2024-01-01T00:00:00.000Z',
    };

    const result = reviewToResponseDTO(review);

    expect(result).not.toBe(review);
    expect(result.reviewerId).toBe(review.reviewerId);
  });
});

describe('profileToResponseDTO', () => {
  const profile: ReputationProfile = {
    freelancerId: 'freelancer-1',
    score: 4.2,
    jobsCompleted: 10,
    totalRatings: 15,
    reviews: [
      { reviewerId: 'reviewer-1', rating: 5, comment: 'Excellent', createdAt: '2024-01-01T00:00:00.000Z' },
      { reviewerId: 'reviewer-2', rating: 4, createdAt: '2024-02-01T00:00:00.000Z' },
    ],
    lastUpdated: '2024-03-01T00:00:00.000Z',
    weightedScore: 4.5,
    scoreAlgorithm: 'exp-decay-v1',
  };

  it('maps all top-level fields', () => {
    const result = profileToResponseDTO(profile);

    expect(result.freelancerId).toBe('freelancer-1');
    expect(result.score).toBe(4.2);
    expect(result.jobsCompleted).toBe(10);
    expect(result.totalRatings).toBe(15);
    expect(result.lastUpdated).toBe('2024-03-01T00:00:00.000Z');
    expect(result.weightedScore).toBe(4.5);
    expect(result.scoreAlgorithm).toBe('exp-decay-v1');
  });

  it('maps nested reviews using reviewToResponseDTO', () => {
    const result = profileToResponseDTO(profile);

    expect(result.reviews).toHaveLength(2);
    expect(result.reviews[0].reviewerId).toBe('reviewer-1');
    expect(result.reviews[0].comment).toBe('Excellent');
    expect(result.reviews[1].reviewerId).toBe('reviewer-2');
    expect(result.reviews[1].comment).toBeUndefined();
  });

  it('does not mutate the original profile', () => {
    const result = profileToResponseDTO(profile);

    expect(result).not.toBe(profile);
    expect(result.reviews).not.toBe(profile.reviews);
  });

  it('handles a profile with empty reviews', () => {
    const emptyReviewsProfile: ReputationProfile = {
      ...profile,
      reviews: [],
    };

    const result = profileToResponseDTO(emptyReviewsProfile);

    expect(result.reviews).toEqual([]);
  });

  it('handles a profile with no optional comment fields in reviews', () => {
    const noCommentsProfile: ReputationProfile = {
      ...profile,
      reviews: [
        { reviewerId: 'reviewer-1', rating: 3, createdAt: '2024-01-01T00:00:00.000Z' },
      ],
    };

    const result = profileToResponseDTO(noCommentsProfile);

    expect(result.reviews).toHaveLength(1);
    expect(result.reviews[0].comment).toBeUndefined();
  });
});

describe('createRatingBodyToPayload', () => {
  it('maps all fields from CreateRatingBodyDTO to UpdateReputationPayload', () => {
    const dto: CreateRatingBodyDTO = {
      reviewerId: 'reviewer-1',
      contextId: '550e8400-e29b-41d4-a716-446655440000',
      rating: 4,
      comment: 'Solid work',
    };

    const result = createRatingBodyToPayload(dto);

    expect(result).toEqual({
      reviewerId: 'reviewer-1',
      rating: 4,
      comment: 'Solid work',
      contextId: '550e8400-e29b-41d4-a716-446655440000',
    });
  });

  it('handles missing optional comment', () => {
    const dto: CreateRatingBodyDTO = {
      reviewerId: 'reviewer-1',
      contextId: '550e8400-e29b-41d4-a716-446655440000',
      rating: 5,
    };

    const result = createRatingBodyToPayload(dto);

    expect(result.comment).toBeUndefined();
    expect(result).toEqual({
      reviewerId: 'reviewer-1',
      rating: 5,
      contextId: '550e8400-e29b-41d4-a716-446655440000',
    });
  });

  it('includes contextId in the payload', () => {
    const dto: CreateRatingBodyDTO = {
      reviewerId: 'reviewer-1',
      contextId: '550e8400-e29b-41d4-a716-446655440000',
      rating: 3,
    };

    const result = createRatingBodyToPayload(dto);

    expect(result.contextId).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(result).not.toHaveProperty('jobCompleted');
  });
});
