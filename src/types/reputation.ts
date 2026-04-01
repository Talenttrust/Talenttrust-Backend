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
}

export interface UpdateReputationPayload {
  reviewerId: string;
  rating: number;
  comment?: string;
  jobCompleted?: boolean;
}
