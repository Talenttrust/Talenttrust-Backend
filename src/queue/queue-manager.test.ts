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

      const jobId = await queueManager.addJob(JobType.EMAIL_NOTIFICATION, payload);
      expect(jobId).toBeDefined();
      expect(typeof jobId).toBe('string');
    });

    it('should add a job with priority', async () => {
      const payload = {
        to: 'urgent@example.com',
        subject: 'Urgent',
        body: 'High priority',
      };

      const jobId = await queueManager.addJob(
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

      const jobId = await queueManager.addJob(
        JobType.EMAIL_NOTIFICATION,
        payload,
        { delay: 5000 }
      );
      expect(jobId).toBeDefined();
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

      const jobId = await queueManager.addJob(JobType.EMAIL_NOTIFICATION, payload);
      
      // Wait a bit for job to be processed
      await new Promise((resolve) => setTimeout(resolve, 500));

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
});
