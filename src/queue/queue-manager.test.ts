/**
 * Queue Manager Tests
 * 
 * Integration and unit tests for the QueueManager class.
 * Tests queue initialization, job enqueueing, and lifecycle management.
 */

import { QueueManager } from './queue-manager';
import { JobType } from './types';

describe('QueueManager', () => {
  let queueManager: QueueManager;

  async function waitForJobToFail(jobId: string): Promise<void> {
    const maxAttempts = 30;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const status = await queueManager.getJobStatus(JobType.EMAIL_NOTIFICATION, jobId);
      if (status?.state === 'failed') {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Job ${jobId} did not fail within timeout`);
  }

  beforeEach(() => {
    queueManager = QueueManager.getInstance();
  });

  afterEach(async () => {
    await queueManager.shutdown();
  });

  describe('Singleton Pattern', () => {
    it('should return the same instance', () => {
      const instance1 = QueueManager.getInstance();
      const instance2 = QueueManager.getInstance();
      expect(instance1).toBe(instance2);
    });
  });

  describe('Queue Initialization', () => {
    it('should initialize a queue for a job type', async () => {
      await expect(
        queueManager.initializeQueue(JobType.EMAIL_NOTIFICATION)
      ).resolves.not.toThrow();
    });

    it('should handle multiple initializations of the same queue', async () => {
      await queueManager.initializeQueue(JobType.EMAIL_NOTIFICATION);
      await expect(
        queueManager.initializeQueue(JobType.EMAIL_NOTIFICATION)
      ).resolves.not.toThrow();
    });

    it('should initialize all job types', async () => {
      const initPromises = Object.values(JobType).map((type) =>
        queueManager.initializeQueue(type)
      );
      await expect(Promise.all(initPromises)).resolves.not.toThrow();
    });
  });

  describe('Job Enqueueing', () => {
    beforeEach(async () => {
      await queueManager.initializeQueue(JobType.EMAIL_NOTIFICATION);
    });

    it('should add a job to the queue', async () => {
      const payload = {
        to: 'test@example.com',
        subject: 'Test Email',
        body: 'This is a test',
      };

      const { jobId, deduplicated } = await queueManager.addJob(JobType.EMAIL_NOTIFICATION, payload);
      expect(jobId).toBeDefined();
      expect(typeof jobId).toBe('string');
      expect(deduplicated).toBe(false);
    });

    it('should add a job with priority', async () => {
      const payload = {
        to: 'urgent@example.com',
        subject: 'Urgent',
        body: 'High priority',
      };

      const { jobId } = await queueManager.addJob(
        JobType.EMAIL_NOTIFICATION,
        payload,
        { priority: 1 }
      );
      expect(jobId).toBeDefined();
    });

    it('should add a delayed job', async () => {
      const payload = {
        to: 'delayed@example.com',
        subject: 'Delayed',
        body: 'Send later',
      };

      const { jobId } = await queueManager.addJob(
        JobType.EMAIL_NOTIFICATION,
        payload,
        { delay: 50 }
      );
      expect(jobId).toBeDefined();
    });

    it('should return same jobId for duplicate dedupeKey', async () => {
      const payload = {
        to: 'dedup@example.com',
        subject: 'Dedup Test',
        body: 'First submission',
      };
      const dedupeKey = 'email-dedup-test-001';

      const first = await queueManager.addJob(JobType.EMAIL_NOTIFICATION, payload, { dedupeKey, delay: 5000 });
      const second = await queueManager.addJob(JobType.EMAIL_NOTIFICATION, payload, { dedupeKey, delay: 5000 });

      expect(first.jobId).toBe(dedupeKey);
      expect(second.jobId).toBe(dedupeKey);
      expect(first.deduplicated).toBe(false);
      expect(second.deduplicated).toBe(true);
    });

    it('should allow re-enqueue after job completes', async () => {
      const payload = {
        to: 'requeue@example.com',
        subject: 'Re-enqueue Test',
        body: 'First run',
      };
      const dedupeKey = 'email-requeue-test-001';

      const first = await queueManager.addJob(JobType.EMAIL_NOTIFICATION, payload, { dedupeKey });
      // Wait for job to be processed
      await new Promise((resolve) => setTimeout(resolve, 300));

      const second = await queueManager.addJob(JobType.EMAIL_NOTIFICATION, payload, { dedupeKey });
      expect(first.jobId).toBe(dedupeKey);
      // After completion, second enqueue should not be flagged as deduplicated
      expect(second.deduplicated).toBe(false);
    });

    it('should throw error when queue not initialized', async () => {
      await expect(
        queueManager.addJob(JobType.CONTRACT_PROCESSING, {
          contractId: 'test',
          action: 'create',
        })
      ).rejects.toThrow('Queue for contract-processing not initialized');
    });
  });

  describe('Job Status', () => {
    beforeEach(async () => {
      await queueManager.initializeQueue(JobType.EMAIL_NOTIFICATION);
    });

    it('should get job status', async () => {
      const payload = {
        to: 'status@example.com',
        subject: 'Status Test',
        body: 'Check status',
      };

      const { jobId } = await queueManager.addJob(JobType.EMAIL_NOTIFICATION, payload);

      await new Promise((resolve) => setTimeout(resolve, 150));

      const status = await queueManager.getJobStatus(
        JobType.EMAIL_NOTIFICATION,
        jobId
      );
      expect(status).toBeDefined();
      expect(status?.id).toBe(jobId);
    });

    it('should return null for non-existent job', async () => {
      const status = await queueManager.getJobStatus(
        JobType.EMAIL_NOTIFICATION,
        'non-existent-id'
      );
      expect(status).toBeNull();
    });

    it('should throw error when queue not initialized', async () => {
      await expect(
        queueManager.getJobStatus(JobType.BLOCKCHAIN_SYNC, 'some-id')
      ).rejects.toThrow('Queue for blockchain-sync not initialized');
    });
  });

  describe('Graceful Shutdown', () => {
    it('should shutdown without errors', async () => {
      await queueManager.initializeQueue(JobType.EMAIL_NOTIFICATION);
      await expect(queueManager.shutdown()).resolves.not.toThrow();
    });

    it('should handle multiple shutdown calls', async () => {
      await queueManager.initializeQueue(JobType.EMAIL_NOTIFICATION);
      await queueManager.shutdown();
      await expect(queueManager.shutdown()).resolves.not.toThrow();
    });
  });

  describe('DLQ Operations', () => {
    beforeEach(async () => {
      await queueManager.initializeQueue(JobType.EMAIL_NOTIFICATION);
    });

    it('should list failed jobs', async () => {
      const { jobId: failedJobId } = await queueManager.addJob(
        JobType.EMAIL_NOTIFICATION,
        {
          to: 'not-an-email',
          subject: 'DLQ test',
          body: 'should fail',
        },
        { attempts: 1 }
      );

      await waitForJobToFail(failedJobId);

      const failedJobs = await queueManager.getFailedJobs({
        jobType: JobType.EMAIL_NOTIFICATION,
        limit: 20,
      });

      const target = failedJobs.find((entry) => entry.jobId === failedJobId);
      expect(target).toBeDefined();
      expect(target?.jobType).toBe(JobType.EMAIL_NOTIFICATION);
      expect(target?.replayDeduplicationKey).toBe(
        `replay:${JobType.EMAIL_NOTIFICATION}:${failedJobId}`
      );
    });

    it('should reprocess failed jobs with dedupe', async () => {
      const { jobId: failedJobId } = await queueManager.addJob(
        JobType.EMAIL_NOTIFICATION,
        {
          to: 'still-invalid',
          subject: 'Replay test',
          body: 'should fail',
        },
        { attempts: 1 }
      );

      await waitForJobToFail(failedJobId);

      const firstReplay = await queueManager.reprocessFailedJob(
        JobType.EMAIL_NOTIFICATION,
        failedJobId
      );
      expect(firstReplay.deduplicated).toBe(false);
      expect(firstReplay.replayJobId).toBe(
        `replay:${JobType.EMAIL_NOTIFICATION}:${failedJobId}`
      );

      const secondReplay = await queueManager.reprocessFailedJob(
        JobType.EMAIL_NOTIFICATION,
        failedJobId
      );
      expect(secondReplay.deduplicated).toBe(true);
      expect(secondReplay.replayJobId).toBe(firstReplay.replayJobId);
    });
  });
});
