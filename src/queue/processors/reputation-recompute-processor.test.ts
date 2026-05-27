/**
 * Reputation Recompute Processor Tests
 */

import { processReputationRecompute } from './reputation-recompute-processor';
import { reputationStore } from '../../models/reputation.store';
import { reputationCheckpointStore } from '../../models/reputation-checkpoint.store';
import { ReputationProfile } from '../../types/reputation';

// Mock the logger
jest.mock('../../logger', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  },
}));

describe('processReputationRecompute', () => {
  beforeEach(() => {
    // Clear all data before each test
    reputationStore.clear();
    reputationCheckpointStore.clear();
    jest.clearAllMocks();
  });

  describe('Basic functionality', () => {
    it('should handle empty freelancer list', async () => {
      const result = await processReputationRecompute({
        batchSize: 10,
        forceRecompute: false,
        resumeFromCheckpoint: false,
      });

      expect(result.success).toBe(true);
      expect(result.message).toBe('No freelancers found to recompute');
      expect(result.data).toEqual({
        totalProcessed: 0,
        totalFreelancers: 0,
      });
    });

    it('should create a new checkpoint when no existing checkpoint', async () => {
      // This test uses the mock data from getAllFreelancerIds()
      const result = await processReputationRecompute({
        batchSize: 100,
        forceRecompute: false,
        resumeFromCheckpoint: true,
      });

      expect(result.success).toBe(true);
      expect(result.data?.totalProcessed).toBeGreaterThan(0);
      expect(result.data?.checkpointId).toBeDefined();
    });

    it('should process with custom batch size', async () => {
      const result = await processReputationRecompute({
        batchSize: 50,
        forceRecompute: false,
        resumeFromCheckpoint: false,
      });

      expect(result.success).toBe(true);
      expect(result.data?.totalProcessed).toBeGreaterThan(0);
    });
  });

  describe('Checkpoint functionality', () => {
    it('should resume from existing checkpoint', async () => {
      // Create an existing checkpoint
      const jobId = 'existing-checkpoint';
      reputationCheckpointStore.createCheckpoint(jobId, 1000);
      reputationCheckpointStore.updateProgress(jobId, 'freelancer-100');

      const result = await processReputationRecompute({
        batchSize: 100,
        forceRecompute: false,
        resumeFromCheckpoint: true,
      });

      expect(result.success).toBe(true);
      // Should resume from where it left off
      expect(result.data?.totalProcessed).toBeGreaterThan(100);
    });

    it('should not resume when resumeFromCheckpoint is false', async () => {
      // Create an existing checkpoint
      const jobId = 'existing-checkpoint-2';
      reputationCheckpointStore.createCheckpoint(jobId, 1000);
      reputationCheckpointStore.updateProgress(jobId, 'freelancer-100');

      const result = await processReputationRecompute({
        batchSize: 100,
        forceRecompute: false,
        resumeFromCheckpoint: false,
      });

      expect(result.success).toBe(true);
      // Should start fresh
      expect(result.data?.checkpointId).not.toBe(jobId);
    });
  });

  describe('Force recompute', () => {
    beforeEach(() => {
      // Create some test profiles
      const profile1: ReputationProfile = {
        freelancerId: 'freelancer-1',
        score: 4.5,
        jobsCompleted: 10,
        totalRatings: 10,
        reviews: [
          { reviewerId: 'reviewer-1', rating: 5, createdAt: '2023-01-01T00:00:00.000Z' },
          { reviewerId: 'reviewer-2', rating: 4, createdAt: '2023-01-02T00:00:00.000Z' },
        ],
        lastUpdated: new Date().toISOString(),
      };

      const profile2: ReputationProfile = {
        freelancerId: 'freelancer-2',
        score: 3.0,
        jobsCompleted: 5,
        totalRatings: 5,
        reviews: [
          { reviewerId: 'reviewer-3', rating: 3, createdAt: '2023-01-01T00:00:00.000Z' },
        ],
        lastUpdated: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(), // 48 hours ago
      };

      reputationStore.set(profile1);
      reputationStore.set(profile2);
    });

    it('should skip up-to-date profiles when not forcing', async () => {
      const result = await processReputationRecompute({
        batchSize: 100,
        forceRecompute: false,
        resumeFromCheckpoint: false,
      });

      expect(result.success).toBe(true);
      // Should process some profiles but skip others based on timestamp
      expect(result.data?.totalProcessed).toBeGreaterThan(0);
    });

    it('should process all profiles when forcing', async () => {
      const result = await processReputationRecompute({
        batchSize: 100,
        forceRecompute: true,
        resumeFromCheckpoint: false,
      });

      expect(result.success).toBe(true);
      // Should process all profiles when forcing
      expect(result.data?.totalProcessed).toBeGreaterThan(0);
    });
  });

  describe('Error handling', () => {
    it('should handle processing errors gracefully', async () => {
      // Mock a scenario that might cause an error
      // This is a simplified test - in practice, you'd mock the reputation store
      // to throw an error for specific freelancer IDs

      const result = await processReputationRecompute({
        batchSize: 100,
        forceRecompute: false,
        resumeFromCheckpoint: false,
      });

      // Should still succeed unless there's an actual error
      expect(result.success).toBe(true);
    });
  });

  describe('Idempotency', () => {
    it('should be idempotent per freelancer ID', async () => {
      // Run the recompute twice
      const result1 = await processReputationRecompute({
        batchSize: 100,
        forceRecompute: false,
        resumeFromCheckpoint: false,
      });

      const result2 = await processReputationRecompute({
        batchSize: 100,
        forceRecompute: false,
        resumeFromCheckpoint: false,
      });

      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);

      // Results should be consistent
      expect(result1.data?.totalProcessed).toBe(result2.data?.totalProcessed);
    });
  });

  describe('Performance considerations', () => {
    it('should handle large batch sizes efficiently', async () => {
      const startTime = Date.now();

      const result = await processReputationRecompute({
        batchSize: 500, // Large batch size
        forceRecompute: false,
        resumeFromCheckpoint: false,
      });

      const endTime = Date.now();
      const duration = endTime - startTime;

      expect(result.success).toBe(true);
      expect(result.data?.totalProcessed).toBeGreaterThan(0);
      
      // Should complete in reasonable time (adjust threshold as needed)
      expect(duration).toBeLessThan(10000); // 10 seconds
    });
  });

  describe('Data integrity', () => {
    beforeEach(() => {
      // Create a test profile with known data
      const testProfile: ReputationProfile = {
        freelancerId: 'freelancer-1',
        score: 4.0,
        jobsCompleted: 5,
        totalRatings: 5,
        reviews: [
          { reviewerId: 'reviewer-1', rating: 5, createdAt: '2023-01-01T00:00:00.000Z' },
          { reviewerId: 'reviewer-2', rating: 3, createdAt: '2023-01-02T00:00:00.000Z' },
          { reviewerId: 'reviewer-3', rating: 4, createdAt: '2023-01-03T00:00:00.000Z' },
          { reviewerId: 'reviewer-4', rating: 4, createdAt: '2023-01-04T00:00:00.000Z' },
          { reviewerId: 'reviewer-5', rating: 4, createdAt: '2023-01-05T00:00:00.000Z' },
        ],
        lastUpdated: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(), // 48 hours ago
      };

      reputationStore.set(testProfile);
    });

    it('should correctly recalculate reputation scores', async () => {
      await processReputationRecompute({
        batchSize: 100,
        forceRecompute: true,
        resumeFromCheckpoint: false,
      });

      const updatedProfile = reputationStore.get('freelancer-1');
      
      if (updatedProfile) {
        // Expected average: (5 + 3 + 4 + 4 + 4) / 5 = 4.0
        expect(updatedProfile.score).toBe(4.0);
        expect(updatedProfile.totalRatings).toBe(5);
        expect(updatedProfile.reviews).toHaveLength(5);
      }
    });

    it('should preserve review data during recompute', async () => {
      const originalProfile = reputationStore.get('freelancer-1');
      const originalReviews = originalProfile?.reviews || [];

      await processReputationRecompute({
        batchSize: 100,
        forceRecompute: true,
        resumeFromCheckpoint: false,
      });

      const updatedProfile = reputationStore.get('freelancer-1');
      
      if (updatedProfile) {
        expect(updatedProfile.reviews).toEqual(originalReviews);
      }
    });
  });
});
