import { ReputationProfile, UpdateReputationPayload, Review } from '../types/reputation';
import { reputationStore } from '../models/reputation.store';

/**
 * @title Reputation Service
 * @dev NatSpec: Business logic for retrieving and updating freelancer reputation profiles.
 */
export class ReputationService {
  /**
   * @notice Retrieves a freelancer's reputation profile or creates a default one if it doesn't exist
   * @param freelancerId The unique identifier of the freelancer
   * @return A valid ReputationProfile object
   */
  public static getProfile(freelancerId: string): ReputationProfile {
    if (!freelancerId) {
      throw new Error('Freelancer ID is required');
    }

    let profile = reputationStore.get(freelancerId);
    if (!profile) {
      // Return a default profile instead of throwing 404, assuming first time access
      profile = {
        freelancerId,
        score: 0.0,
        jobsCompleted: 0,
        totalRatings: 0,
        reviews: [],
        lastUpdated: new Date().toISOString(),
      };
      // Do not implicitly save here; only save on update. 
      // This pattern is common - if no rating, return empty state.
    }
    return profile;
  }

  /**
   * @notice Updates a freelancer's reputation profile with a new review
   * @param freelancerId The unique identifier of the freelancer
   * @param payload The review and optional job completion flag
   * @return The updated ReputationProfile object
   */
  public static updateProfile(freelancerId: string, payload: UpdateReputationPayload): ReputationProfile {
    if (!freelancerId) {
      throw new Error('Freelancer ID is required');
    }

    if (payload.rating < 1 || payload.rating > 5) {
      throw new Error('Rating must be between 1 and 5');
    }

    if (!payload.reviewerId) {
      throw new Error('Reviewer ID is required');
    }

    // Get current profile or create initial state
    const profile = this.getProfile(freelancerId);

    // Create new review
    const newReview: Review = {
      reviewerId: payload.reviewerId,
      rating: payload.rating,
      comment: payload.comment,
      createdAt: new Date().toISOString(),
    };

    // Update reviews array
    profile.reviews.push(newReview);

    // Update aggregate stats
    const totalScore = profile.reviews.reduce((acc, curr) => acc + curr.rating, 0);
    profile.totalRatings = profile.reviews.length;
    profile.score = parseFloat((totalScore / profile.totalRatings).toFixed(2));
    
    if (payload.jobCompleted) {
      profile.jobsCompleted += 1;
    }

    profile.lastUpdated = new Date().toISOString();

    // Persist to store
    reputationStore.set(profile);

    return profile;
  }
}
