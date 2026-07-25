import { ReputationCheckpointStore } from './reputation-checkpoint.store';

describe('ReputationCheckpointStore - Snapshot and Restore', () => {
  let store: ReputationCheckpointStore;

  beforeEach(() => {
    store = new ReputationCheckpointStore();
  });

  afterEach(() => {
    store.clear();
  });

  // ── Snapshot (Write) Tests ────────────────────────────────────────

  describe('createCheckpoint - Snapshot', () => {
    it('should create a checkpoint with correct initial state', () => {
      const checkpoint = store.createCheckpoint('job-001', 100);

      expect(checkpoint.jobId).toBe('job-001');
      expect(checkpoint.totalProcessed).toBe(0);
      expect(checkpoint.totalFreelancers).toBe(100);
      expect(checkpoint.status).toBe('running');
      expect(checkpoint.error).toBeUndefined();
      expect(checkpoint.startTime).toBeDefined();
      expect(checkpoint.lastUpdateTime).toBeDefined();
    });

    it('should create checkpoint with valid ISO timestamp', () => {
      const checkpoint = store.createCheckpoint('job-002', 50);
      const startTime = new Date(checkpoint.startTime);

      expect(startTime.getTime()).toBeLessThanOrEqual(Date.now());
      expect(startTime.getTime()).toBeGreaterThan(Date.now() - 2000);
    });

    it('should allow optional freelancerId on creation', () => {
      const checkpoint = store.createCheckpoint('job-003', 75);

      expect(checkpoint.lastProcessedFreelancerId).toBeUndefined();
    });
  });

  // ── Restore (Read) Tests ──────────────────────────────────────────

  describe('getCheckpoint - Restore', () => {
    it('should restore checkpoint identically to written snapshot', () => {
      const created = store.createCheckpoint('job-snap-001', 100);
      const restored = store.getCheckpoint('job-snap-001');

      expect(restored).toEqual(created);
    });

    it('should return undefined when checkpoint does not exist', () => {
      const restored = store.getCheckpoint('non-existent-job');

      expect(restored).toBeUndefined();
    });

    it('should restore checkpoint after multiple operations', () => {
      const jobId = 'job-snap-002';
      store.createCheckpoint(jobId, 50);
      store.updateProgress(jobId, 'freelancer-1');
      store.updateProgress(jobId, 'freelancer-2');

      const restored = store.getCheckpoint(jobId);

      expect(restored?.totalProcessed).toBe(2);
      expect(restored?.lastProcessedFreelancerId).toBe('freelancer-2');
      expect(restored?.status).toBe('running');
    });
  });

  // ── Overwrite Tests ──────────────────────────────────────────────

  describe('Overwrite Behavior', () => {
    it('should replace prior snapshot when overwriting', () => {
      const jobId = 'job-overwrite-001';
      const checkpoint1 = store.createCheckpoint(jobId, 100);

      store.updateProgress(jobId, 'freelancer-1');
      const checkpoint2 = store.getCheckpoint(jobId);

      expect(checkpoint2?.totalProcessed).toBe(1);
      expect(checkpoint2?.lastProcessedFreelancerId).toBe('freelancer-1');
      expect(new Date(checkpoint2!.lastUpdateTime).getTime()).toBeGreaterThanOrEqual(
        new Date(checkpoint1.lastUpdateTime).getTime()
      );
    });

    it('should maintain jobId and totalFreelancers across overwrites', () => {
      const jobId = 'job-overwrite-002';
      const initialCheckpoint = store.createCheckpoint(jobId, 150);

      store.updateProgress(jobId, 'freelancer-1');
      store.updateProgress(jobId, 'freelancer-2');
      const finalCheckpoint = store.getCheckpoint(jobId);

      expect(finalCheckpoint?.jobId).toBe(initialCheckpoint.jobId);
      expect(finalCheckpoint?.totalFreelancers).toBe(initialCheckpoint.totalFreelancers);
    });

    it('should properly overwrite status transitions', () => {
      const jobId = 'job-status-001';
      store.createCheckpoint(jobId, 50);
      expect(store.getCheckpoint(jobId)?.status).toBe('running');

      store.markCompleted(jobId);
      expect(store.getCheckpoint(jobId)?.status).toBe('completed');

      store.createCheckpoint(jobId, 50);
      expect(store.getCheckpoint(jobId)?.status).toBe('running');
    });
  });

  // ── Restore Without Checkpoint Tests ──────────────────────────────

  describe('Restore When No Checkpoint Exists', () => {
    it('should return undefined instead of throwing', () => {
      expect(() => {
        store.getCheckpoint('missing-job');
      }).not.toThrow();
    });

    it('should throw when updating non-existent checkpoint', () => {
      expect(() => {
        store.updateProgress('non-existent-job', 'freelancer-1');
      }).toThrow('Checkpoint not found for job: non-existent-job');
    });

    it('should throw when marking non-existent checkpoint as completed', () => {
      expect(() => {
        store.markCompleted('non-existent-job');
      }).toThrow('Checkpoint not found for job: non-existent-job');
    });

    it('should throw when marking non-existent checkpoint as failed', () => {
      expect(() => {
        store.markFailed('non-existent-job', 'test error');
      }).toThrow('Checkpoint not found for job: non-existent-job');
    });
  });

  // ── Concurrent Write Tests ────────────────────────────────────────

  describe('Concurrent Writes Resolve to Consistent State', () => {
    it('should maintain consistent state with sequential updates', () => {
      const jobId = 'job-concurrent-001';
      store.createCheckpoint(jobId, 100);

      const freelancerIds = Array.from({ length: 10 }, (_, i) => `freelancer-${i + 1}`);

      freelancerIds.forEach((id) => {
        store.updateProgress(jobId, id);
      });

      const final = store.getCheckpoint(jobId);

      expect(final?.totalProcessed).toBe(10);
      expect(final?.lastProcessedFreelancerId).toBe('freelancer-10');
      expect(final?.status).toBe('running');
    });

    it('should handle rapid status transitions consistently', () => {
      const jobId = 'job-concurrent-002';
      const checkpoint = store.createCheckpoint(jobId, 50);

      store.updateProgress(jobId, 'freelancer-1');
      const afterUpdate = store.getCheckpoint(jobId);

      expect(new Date(afterUpdate!.lastUpdateTime).getTime()).toBeGreaterThanOrEqual(
        new Date(checkpoint.lastUpdateTime).getTime()
      );

      store.markCompleted(jobId);
      const completed = store.getCheckpoint(jobId);

      expect(completed?.status).toBe('completed');
      expect(new Date(completed!.lastUpdateTime).getTime()).toBeGreaterThanOrEqual(
        new Date(afterUpdate!.lastUpdateTime).getTime()
      );
    });

    it('should not lose data during concurrent checkpoint operations', () => {
      const jobIds = Array.from({ length: 5 }, (_, i) => `job-concurrent-${i + 1}`);

      jobIds.forEach((jobId) => {
        store.createCheckpoint(jobId, 100);
      });

      jobIds.forEach((jobId, index) => {
        for (let i = 0; i < index + 1; i++) {
          store.updateProgress(jobId, `freelancer-${i}`);
        }
      });

      jobIds.forEach((jobId, index) => {
        const checkpoint = store.getCheckpoint(jobId);
        expect(checkpoint?.totalProcessed).toBe(index + 1);
      });
    });
  });

  // ── Edge Case Tests ───────────────────────────────────────────────

  describe('Edge Cases', () => {
    it('should handle zero freelancers', () => {
      const checkpoint = store.createCheckpoint('job-zero', 0);

      expect(checkpoint.totalFreelancers).toBe(0);
      expect(checkpoint.totalProcessed).toBe(0);
    });

    it('should handle large freelancer counts', () => {
      const largeCount = 1_000_000;
      const checkpoint = store.createCheckpoint('job-large', largeCount);

      expect(checkpoint.totalFreelancers).toBe(largeCount);
    });

    it('should track progress up to total count', () => {
      const jobId = 'job-progress-001';
      store.createCheckpoint(jobId, 5);

      for (let i = 1; i <= 5; i++) {
        store.updateProgress(jobId, `freelancer-${i}`);
      }

      const checkpoint = store.getCheckpoint(jobId);
      expect(checkpoint?.totalProcessed).toBe(5);
    });

    it('should allow progress exceeding total count', () => {
      const jobId = 'job-overflow-001';
      store.createCheckpoint(jobId, 5);

      for (let i = 1; i <= 10; i++) {
        store.updateProgress(jobId, `freelancer-${i}`);
      }

      const checkpoint = store.getCheckpoint(jobId);
      expect(checkpoint?.totalProcessed).toBe(10);
    });

    it('should preserve error message in failed checkpoint', () => {
      const jobId = 'job-error-001';
      const errorMsg = 'Database connection failed';
      store.createCheckpoint(jobId, 50);
      store.markFailed(jobId, errorMsg);

      const checkpoint = store.getCheckpoint(jobId);

      expect(checkpoint?.error).toBe(errorMsg);
      expect(checkpoint?.status).toBe('failed');
    });

    it('should contain no secrets in serialized checkpoint', () => {
      const jobId = 'job-sensitive-001';
      const checkpoint = store.createCheckpoint(jobId, 100);
      store.updateProgress(jobId, 'freelancer-1');

      const serialized = JSON.stringify(checkpoint);

      expect(serialized).not.toContain('password');
      expect(serialized).not.toContain('secret');
      expect(serialized).not.toContain('token');
      expect(serialized).not.toContain('key');
    });
  });

  // ── Checkpoint Lifecycle Tests ────────────────────────────────────

  describe('Checkpoint Lifecycle', () => {
    it('should delete checkpoint and prevent restoration', () => {
      const jobId = 'job-delete-001';
      store.createCheckpoint(jobId, 50);

      expect(store.hasCheckpoint(jobId)).toBe(true);

      store.deleteCheckpoint(jobId);

      expect(store.hasCheckpoint(jobId)).toBe(false);
      expect(store.getCheckpoint(jobId)).toBeUndefined();
    });

    it('should return active checkpoints correctly', () => {
      store.createCheckpoint('job-active-001', 50);
      store.createCheckpoint('job-active-002', 50);
      store.createCheckpoint('job-completed', 50);

      store.markCompleted('job-completed');

      const active = store.getActiveCheckpoints();

      expect(active.length).toBe(2);
      expect(active.map((c: any) => c.jobId)).toContain('job-active-001');
      expect(active.map((c: any) => c.jobId)).toContain('job-active-002');
      expect(active.map((c: any) => c.jobId)).not.toContain('job-completed');
    });

    it('should clear all checkpoints', () => {
      store.createCheckpoint('job-clear-001', 50);
      store.createCheckpoint('job-clear-002', 50);
      store.createCheckpoint('job-clear-003', 50);

      store.clear();

      expect(store.getActiveCheckpoints()).toHaveLength(0);
      expect(store.hasCheckpoint('job-clear-001')).toBe(false);
    });
  });

  // ── Timestamp Consistency Tests ───────────────────────────────────

  describe('Timestamp Consistency', () => {
    it('should update lastUpdateTime on progress changes', () => {
      const jobId = 'job-time-001';
      const checkpoint1 = store.createCheckpoint(jobId, 50);
      const time1 = new Date(checkpoint1.lastUpdateTime).getTime();

      const checkpoint2 = store.updateProgress(jobId, 'freelancer-1');
      const time2 = new Date(checkpoint2.lastUpdateTime).getTime();

      expect(time2).toBeGreaterThanOrEqual(time1);
    });

    it('should maintain startTime across updates', () => {
      const jobId = 'job-time-002';
      const created = store.createCheckpoint(jobId, 50);
      const startTime = created.startTime;

      store.updateProgress(jobId, 'freelancer-1');
      store.updateProgress(jobId, 'freelancer-2');

      const final = store.getCheckpoint(jobId);

      expect(final?.startTime).toBe(startTime);
    });
  });
});