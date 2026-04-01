import { ReputationService } from './reputation.service';
import { reputationStore } from '../models/reputation.store';
import { UpdateReputationPayload } from '../types/reputation';

describe('ReputationService', () => {
  const freelancerId = 'user-123';

  beforeEach(() => {
    reputationStore.clear();
  });

  describe('getProfile', () => {
    it('should return a default profile if none exists', () => {
      const profile = ReputationService.getProfile(freelancerId);
      expect(profile).toBeDefined();
      expect(profile.freelancerId).toBe(freelancerId);
      expect(profile.score).toBe(0.0);
      expect(profile.totalRatings).toBe(0);
      expect(profile.reviews.length).toBe(0);
    });

    it('should throw an error if freelancerId is missing', () => {
      expect(() => ReputationService.getProfile('')).toThrow('Freelancer ID is required');
    });

    it('should return the existing profile', () => {
      // Create it via update
      ReputationService.updateProfile(freelancerId, {
        reviewerId: 'client-1',
        rating: 4,
        jobCompleted: true
      });

      const profile = ReputationService.getProfile(freelancerId);
      expect(profile.score).toBe(4);
      expect(profile.jobsCompleted).toBe(1);
    });
  });

  describe('updateProfile', () => {
    it('should throw error if freelancerId is missing', () => {
      expect(() => {
        ReputationService.updateProfile('', { reviewerId: 'xx', rating: 5 });
      }).toThrow('Freelancer ID is required');
    });

    it('should throw error if rating is invalid', () => {
      expect(() => {
        ReputationService.updateProfile(freelancerId, { reviewerId: 'xx', rating: 6 });
      }).toThrow('Rating must be between 1 and 5');
    });

    it('should throw error if reviewerId is missing', () => {
      expect(() => {
        ReputationService.updateProfile(freelancerId, { reviewerId: '', rating: 5 });
      }).toThrow('Reviewer ID is required');
    });

    it('should correctly calculate the average score and update jobs completed', () => {
      // 1st review
      let profile = ReputationService.updateProfile(freelancerId, {
        reviewerId: 'client-A',
        rating: 4,
        comment: 'Good',
        jobCompleted: true
      });
      expect(profile.score).toBe(4);
      expect(profile.totalRatings).toBe(1);
      expect(profile.jobsCompleted).toBe(1);

      // 2nd review
      profile = ReputationService.updateProfile(freelancerId, {
        reviewerId: 'client-B',
        rating: 5,
        jobCompleted: false
      });
      expect(profile.score).toBe(4.5);
      expect(profile.totalRatings).toBe(2);
      expect(profile.jobsCompleted).toBe(1); // Didn't complete a job
    });
  });
});
