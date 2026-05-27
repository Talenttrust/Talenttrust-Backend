/**
 * Reputation Checkpoint Store Tests
 */

import { reputationCheckpointStore, RecomputeCheckpoint } from './reputation-checkpoint.store';

describe('ReputationCheckpointStore', () => {
  beforeEach(() => {
    // Clear all checkpoints before each test
    reputationCheckpointStore.clear();
  });

  describe('createCheckpoint', () => {
    it('should create a new checkpoint with correct initial values', () => {
      const jobId = 'test-job-1';
      const totalFreelancers = 100;
      
      const checkpoint = reputationCheckpointStore.createCheckpoint(jobId, totalFreelancers);
      
      expect(checkpoint.jobId).toBe(jobId);
      expect(checkpoint.totalFreelancers).toBe(totalFreelancers);
      expect(checkpoint.totalProcessed).toBe(0);
      expect(checkpoint.status).toBe('running');
      expect(checkpoint.startTime).toBeDefined();
      expect(checkpoint.lastUpdateTime).toBeDefined();
    });

    it('should store the checkpoint in the store', () => {
      const jobId = 'test-job-2';
      
      reputationCheckpointStore.createCheckpoint(jobId, 50);
      
      const retrieved = reputationCheckpointStore.getCheckpoint(jobId);
      expect(retrieved).toBeDefined();
      expect(retrieved?.jobId).toBe(jobId);
    });
  });

  describe('getCheckpoint', () => {
    it('should return undefined for non-existent checkpoint', () => {
      const result = reputationCheckpointStore.getCheckpoint('non-existent');
      expect(result).toBeUndefined();
    });

    it('should return the correct checkpoint', () => {
      const jobId = 'test-job-3';
      const created = reputationCheckpointStore.createCheckpoint(jobId, 75);
      
      const retrieved = reputationCheckpointStore.getCheckpoint(jobId);
      
      expect(retrieved).toEqual(created);
    });
  });

  describe('updateProgress', () => {
    it('should update checkpoint progress correctly', () => {
      const jobId = 'test-job-4';
      reputationCheckpointStore.createCheckpoint(jobId, 10);
      
      const updated = reputationCheckpointStore.updateProgress(jobId, 'freelancer-1');
      
      expect(updated.lastProcessedFreelancerId).toBe('freelancer-1');
      expect(updated.totalProcessed).toBe(1);
      expect(updated.lastUpdateTime).toBeDefined();
    });

    it('should throw error for non-existent checkpoint', () => {
      expect(() => {
        reputationCheckpointStore.updateProgress('non-existent', 'freelancer-1');
      }).toThrow('Checkpoint not found for job: non-existent');
    });

    it('should increment totalProcessed on multiple updates', () => {
      const jobId = 'test-job-5';
      reputationCheckpointStore.createCheckpoint(jobId, 10);
      
      reputationCheckpointStore.updateProgress(jobId, 'freelancer-1');
      reputationCheckpointStore.updateProgress(jobId, 'freelancer-2');
      
      const checkpoint = reputationCheckpointStore.getCheckpoint(jobId);
      expect(checkpoint?.totalProcessed).toBe(2);
      expect(checkpoint?.lastProcessedFreelancerId).toBe('freelancer-2');
    });
  });

  describe('markCompleted', () => {
    it('should mark checkpoint as completed', () => {
      const jobId = 'test-job-6';
      reputationCheckpointStore.createCheckpoint(jobId, 10);
      
      const updated = reputationCheckpointStore.markCompleted(jobId);
      
      expect(updated.status).toBe('completed');
      expect(updated.lastUpdateTime).toBeDefined();
    });

    it('should throw error for non-existent checkpoint', () => {
      expect(() => {
        reputationCheckpointStore.markCompleted('non-existent');
      }).toThrow('Checkpoint not found for job: non-existent');
    });
  });

  describe('markFailed', () => {
    it('should mark checkpoint as failed with error message', () => {
      const jobId = 'test-job-7';
      reputationCheckpointStore.createCheckpoint(jobId, 10);
      const errorMessage = 'Test error';
      
      const updated = reputationCheckpointStore.markFailed(jobId, errorMessage);
      
      expect(updated.status).toBe('failed');
      expect(updated.error).toBe(errorMessage);
      expect(updated.lastUpdateTime).toBeDefined();
    });

    it('should throw error for non-existent checkpoint', () => {
      expect(() => {
        reputationCheckpointStore.markFailed('non-existent', 'error');
      }).toThrow('Checkpoint not found for job: non-existent');
    });
  });

  describe('deleteCheckpoint', () => {
    it('should delete existing checkpoint', () => {
      const jobId = 'test-job-8';
      reputationCheckpointStore.createCheckpoint(jobId, 10);
      
      reputationCheckpointStore.deleteCheckpoint(jobId);
      
      const retrieved = reputationCheckpointStore.getCheckpoint(jobId);
      expect(retrieved).toBeUndefined();
    });
  });

  describe('getActiveCheckpoints', () => {
    it('should return running checkpoints', () => {
      const job1 = 'test-job-9';
      const job2 = 'test-job-10';
      
      reputationCheckpointStore.createCheckpoint(job1, 10);
      reputationCheckpointStore.createCheckpoint(job2, 10);
      reputationCheckpointStore.markCompleted(job2);
      
      const active = reputationCheckpointStore.getActiveCheckpoints();
      
      expect(active).toHaveLength(1);
      expect(active[0].jobId).toBe(job1);
      expect(active[0].status).toBe('running');
    });

    it('should return paused checkpoints', () => {
      const jobId = 'test-job-11';
      reputationCheckpointStore.createCheckpoint(jobId, 10);
      
      // Manually set status to paused (simulating a paused state)
      const checkpoint = reputationCheckpointStore.getCheckpoint(jobId);
      if (checkpoint) {
        checkpoint.status = 'paused';
      }
      
      const active = reputationCheckpointStore.getActiveCheckpoints();
      
      expect(active).toHaveLength(1);
      expect(active[0].status).toBe('paused');
    });

    it('should not return completed checkpoints', () => {
      const job1 = 'test-job-12';
      const job2 = 'test-job-13';
      
      reputationCheckpointStore.createCheckpoint(job1, 10);
      reputationCheckpointStore.createCheckpoint(job2, 10);
      reputationCheckpointStore.markCompleted(job1);
      reputationCheckpointStore.markFailed(job2, 'error');
      
      const active = reputationCheckpointStore.getActiveCheckpoints();
      
      expect(active).toHaveLength(0);
    });
  });

  describe('hasCheckpoint', () => {
    it('should return true for existing checkpoint', () => {
      const jobId = 'test-job-14';
      reputationCheckpointStore.createCheckpoint(jobId, 10);
      
      expect(reputationCheckpointStore.hasCheckpoint(jobId)).toBe(true);
    });

    it('should return false for non-existent checkpoint', () => {
      expect(reputationCheckpointStore.hasCheckpoint('non-existent')).toBe(false);
    });
  });

  describe('clear', () => {
    it('should clear all checkpoints', () => {
      reputationCheckpointStore.createCheckpoint('job1', 10);
      reputationCheckpointStore.createCheckpoint('job2', 10);
      reputationCheckpointStore.createCheckpoint('job3', 10);
      
      reputationCheckpointStore.clear();
      
      expect(reputationCheckpointStore.getCheckpoint('job1')).toBeUndefined();
      expect(reputationCheckpointStore.getCheckpoint('job2')).toBeUndefined();
      expect(reputationCheckpointStore.getCheckpoint('job3')).toBeUndefined();
      expect(reputationCheckpointStore.getActiveCheckpoints()).toHaveLength(0);
    });
  });

  describe('Integration Test - Complete Workflow', () => {
    it('should handle complete recompute workflow', () => {
      const jobId = 'integration-test-job';
      const totalFreelancers = 5;
      const freelancerIds = ['f1', 'f2', 'f3', 'f4', 'f5'];
      
      // Create checkpoint
      const checkpoint = reputationCheckpointStore.createCheckpoint(jobId, totalFreelancers);
      expect(checkpoint.totalProcessed).toBe(0);
      
      // Process each freelancer
      freelancerIds.forEach((freelancerId, index) => {
        reputationCheckpointStore.updateProgress(jobId, freelancerId);
        
        const updated = reputationCheckpointStore.getCheckpoint(jobId);
        expect(updated?.totalProcessed).toBe(index + 1);
        expect(updated?.lastProcessedFreelancerId).toBe(freelancerId);
      });
      
      // Mark as completed
      reputationCheckpointStore.markCompleted(jobId);
      
      const final = reputationCheckpointStore.getCheckpoint(jobId);
      expect(final?.status).toBe('completed');
      expect(final?.totalProcessed).toBe(totalFreelancers);
      
      // Should not be in active checkpoints
      expect(reputationCheckpointStore.getActiveCheckpoints()).toHaveLength(0);
    });

    it('should handle failure scenario', () => {
      const jobId = 'failure-test-job';
      
      reputationCheckpointStore.createCheckpoint(jobId, 10);
      reputationCheckpointStore.updateProgress(jobId, 'freelancer-1');
      reputationCheckpointStore.updateProgress(jobId, 'freelancer-2');
      
      // Simulate failure
      const errorMessage = 'Database connection lost';
      reputationCheckpointStore.markFailed(jobId, errorMessage);
      
      const failed = reputationCheckpointStore.getCheckpoint(jobId);
      expect(failed?.status).toBe('failed');
      expect(failed?.error).toBe(errorMessage);
      expect(failed?.totalProcessed).toBe(2);
      
      // Should not be in active checkpoints
      expect(reputationCheckpointStore.getActiveCheckpoints()).toHaveLength(0);
    });
  });
});
