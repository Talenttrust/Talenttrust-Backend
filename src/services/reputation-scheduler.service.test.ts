/**
 * Reputation Scheduler Service Tests
 */

import { ReputationSchedulerService } from './reputation-scheduler.service';
import { QueueManager } from '../queue/queue-manager';
import { JobType } from '../queue/types';

// Mock dependencies
jest.mock('../queue/queue-manager');
jest.mock('../logger', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  },
}));

describe('ReputationSchedulerService', () => {
  let scheduler: ReputationSchedulerService;
  let mockQueueManager: jest.Mocked<QueueManager>;

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Create a mock QueueManager instance
    mockQueueManager = {
      getInstance: jest.fn(() => mockQueueManager),
      initializeQueue: jest.fn().mockResolvedValue(undefined),
      addJob: jest.fn().mockResolvedValue('test-job-id'),
    } as any;

    // Mock the singleton getInstance to return our mock
    (QueueManager.getInstance as jest.Mock).mockReturnValue(mockQueueManager);

    scheduler = new ReputationSchedulerService();
  });

  describe('constructor', () => {
    it('should initialize with default configuration', () => {
      const config = scheduler.getConfig();
      
      expect(config.enabled).toBe(true);
      expect(config.intervalMinutes).toBe(60 * 24); // Daily
      expect(config.batchSize).toBe(100);
      expect(config.forceRecompute).toBe(false);
      expect(config.resumeFromCheckpoint).toBe(true);
    });

    it('should accept custom configuration', () => {
      const customScheduler = new ReputationSchedulerService({
        enabled: false,
        intervalMinutes: 60,
        batchSize: 50,
        forceRecompute: true,
        resumeFromCheckpoint: false,
      });

      const config = customScheduler.getConfig();
      
      expect(config.enabled).toBe(false);
      expect(config.intervalMinutes).toBe(60);
      expect(config.batchSize).toBe(50);
      expect(config.forceRecompute).toBe(true);
      expect(config.resumeFromCheckpoint).toBe(false);
    });
  });

  describe('start', () => {
    it('should start the scheduler when enabled', async () => {
      await scheduler.start();

      expect(mockQueueManager.initializeQueue).toHaveBeenCalledWith(JobType.REPUTATION_RECOMPUTE);
      expect(mockQueueManager.addJob).toHaveBeenCalledWith(
        JobType.REPUTATION_RECOMPUTE,
        expect.objectContaining({
          batchSize: 100,
          forceRecompute: false,
          resumeFromCheckpoint: true,
        })
      );
      expect(scheduler.isActive()).toBe(true);
    });

    it('should not start when disabled', async () => {
      const disabledScheduler = new ReputationSchedulerService({ enabled: false });
      
      await disabledScheduler.start();

      expect(mockQueueManager.initializeQueue).not.toHaveBeenCalled();
      expect(disabledScheduler.isActive()).toBe(false);
    });

    it('should warn when already running', async () => {
      await scheduler.start();
      await scheduler.start(); // Start again

      expect(scheduler.isActive()).toBe(true);
    });
  });

  describe('stop', () => {
    it('should stop the scheduler', async () => {
      await scheduler.start();
      expect(scheduler.isActive()).toBe(true);

      scheduler.stop();
      expect(scheduler.isActive()).toBe(false);
    });

    it('should warn when not running', () => {
      scheduler.stop(); // Stop without starting

      expect(scheduler.isActive()).toBe(false);
    });
  });

  describe('scheduleRecomputeJob', () => {
    it('should schedule a recompute job with current config', async () => {
      await scheduler.scheduleRecomputeJob();

      expect(mockQueueManager.addJob).toHaveBeenCalledWith(
        JobType.REPUTATION_RECOMPUTE,
        {
          batchSize: 100,
          forceRecompute: false,
          resumeFromCheckpoint: true,
        }
      );
    });

    it('should handle job scheduling errors gracefully', async () => {
      mockQueueManager.addJob.mockRejectedValue(new Error('Queue error'));

      const result = await scheduler.scheduleRecomputeJob();

      expect(result).toBeNull();
    });
  });

  describe('triggerManualRecompute', () => {
    it('should trigger manual recompute with custom options', async () => {
      await scheduler.triggerManualRecompute({
        batchSize: 50,
        forceRecompute: true,
        resumeFromCheckpoint: false,
      });

      expect(mockQueueManager.addJob).toHaveBeenCalledWith(
        JobType.REPUTATION_RECOMPUTE,
        {
          batchSize: 50,
          forceRecompute: true,
          resumeFromCheckpoint: false,
        }
      );
    });

    it('should use default options when none provided', async () => {
      await scheduler.triggerManualRecompute();

      expect(mockQueueManager.addJob).toHaveBeenCalledWith(
        JobType.REPUTATION_RECOMPUTE,
        {
          batchSize: 100,
          forceRecompute: true, // Default true for manual triggers
          resumeFromCheckpoint: true,
        }
      );
    });
  });

  describe('updateConfig', () => {
    it('should update configuration', () => {
      scheduler.updateConfig({
        intervalMinutes: 120,
        batchSize: 200,
      });

      const config = scheduler.getConfig();
      expect(config.intervalMinutes).toBe(120);
      expect(config.batchSize).toBe(200);
    });

    it('should restart scheduler when interval changes', async () => {
      await scheduler.start();
      expect(scheduler.isActive()).toBe(true);

      // Clear the mock to track new calls
      jest.clearAllMocks();

      scheduler.updateConfig({ intervalMinutes: 60 });

      // Should have restarted the scheduler
      expect(scheduler.isActive()).toBe(true);
    });
  });

  describe('getStatus', () => {
    it('should return correct status when running', async () => {
      await scheduler.start();

      const status = scheduler.getStatus();

      expect(status.isRunning).toBe(true);
      expect(status.config).toBeDefined();
      expect(status.nextRunIn).toBe(60 * 24); // Default interval
    });

    it('should return correct status when not running', () => {
      const status = scheduler.getStatus();

      expect(status.isRunning).toBe(false);
      expect(status.config).toBeDefined();
      expect(status.nextRunIn).toBeUndefined();
    });
  });

  describe('isActive', () => {
    it('should return false initially', () => {
      expect(scheduler.isActive()).toBe(false);
    });

    it('should return true after starting', async () => {
      await scheduler.start();
      expect(scheduler.isActive()).toBe(true);
    });

    it('should return false after stopping', async () => {
      await scheduler.start();
      scheduler.stop();
      expect(scheduler.isActive()).toBe(false);
    });
  });
});
