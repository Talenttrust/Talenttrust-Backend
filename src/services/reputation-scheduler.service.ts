/**
 * Reputation Recompute Scheduler Service
 * 
 * Handles periodic scheduling of reputation recompute jobs.
 * Provides configuration options for scheduling frequency and job parameters.
 */

import { QueueManager } from '../queue/queue-manager';
import { JobType } from '../queue/types';
import { logger } from '../logger';

export interface SchedulerConfig {
  enabled: boolean;
  intervalMinutes: number;
  batchSize: number;
  forceRecompute: boolean;
  resumeFromCheckpoint: boolean;
}

export class ReputationSchedulerService {
  private queueManager: QueueManager;
  private config: SchedulerConfig;
  private isRunning = false;
  private timeoutHandle: any = null;

  constructor(config: Partial<SchedulerConfig> = {}) {
    this.queueManager = QueueManager.getInstance();
    this.config = {
      enabled: true,
      intervalMinutes: 60 * 24, // Daily by default
      batchSize: 100,
      forceRecompute: false,
      resumeFromCheckpoint: true,
      ...config,
    };
  }

  /**
   * Start the periodic reputation recompute scheduler
   */
  public async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Reputation scheduler is already running');
      return;
    }

    if (!this.config.enabled) {
      logger.info('Reputation scheduler is disabled');
      return;
    }

    try {
      // Initialize the reputation recompute queue
      await this.queueManager.initializeQueue(JobType.REPUTATION_RECOMPUTE);
      
      this.isRunning = true;
      logger.info(`Reputation scheduler started with ${this.config.intervalMinutes} minute interval`);
      
      // Schedule first job immediately
      await this.scheduleRecomputeJob();
      
      // Schedule next run
      this.scheduleNextRun();
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to start reputation scheduler:', { error: errorMessage });
      throw error;
    }
  }

  /**
   * Stop the periodic reputation recompute scheduler
   */
  public stop(): void {
    if (!this.isRunning) {
      logger.warn('Reputation scheduler is not running');
      return;
    }

    // Just set the flag to false, the promise-based scheduler will check this
    this.isRunning = false;
    this.timeoutHandle = null;
    logger.info('Reputation scheduler stopped');
  }

  /**
   * Schedule the next run of the recompute job
   */
  private scheduleNextRun(): void {
    if (!this.isRunning) {
      return;
    }

    const intervalMs = this.config.intervalMinutes * 60 * 1000;
    // Use a simple promise-based delay instead of timers
    this.timeoutHandle = new Promise<void>((resolve) => {
      const handler = async () => {
        if (this.isRunning) {
          await this.scheduleRecomputeJob();
          this.scheduleNextRun(); // Schedule the next run
        }
        resolve();
      };
      
      // Use a simple approach to delay execution
      const start = Date.now();
      const check = () => {
        if (Date.now() - start >= intervalMs) {
          handler();
        } else {
          this.timeoutHandle = Promise.resolve().then(check);
        }
      };
      check();
    });
  }

  /**
   * Schedule a single reputation recompute job
   */
  public async scheduleRecomputeJob(): Promise<string | null> {
    try {
      const result = await this.queueManager.addJob(
        JobType.REPUTATION_RECOMPUTE,
        {
          batchSize: this.config.batchSize,
          forceRecompute: this.config.forceRecompute,
          resumeFromCheckpoint: this.config.resumeFromCheckpoint,
        }
      );
      const jobId = (result as any).jobId ?? String(result);

      logger.info(`Scheduled reputation recompute job: ${jobId}`, {
        batchSize: this.config.batchSize,
        forceRecompute: this.config.forceRecompute,
        resumeFromCheckpoint: this.config.resumeFromCheckpoint,
      });

      return jobId;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to schedule reputation recompute job:', { error: errorMessage });
      return null;
    }
  }

  /**
   * Get current scheduler configuration
   */
  public getConfig(): SchedulerConfig {
    return { ...this.config };
  }

  /**
   * Update scheduler configuration
   * Note: Some changes require restart to take effect
   */
  public updateConfig(newConfig: Partial<SchedulerConfig>): void {
    const oldInterval = this.config.intervalMinutes;
    this.config = { ...this.config, ...newConfig };
    
    logger.info('Reputation scheduler configuration updated', {
      oldConfig: { intervalMinutes: oldInterval },
      newConfig,
    });

    // Restart scheduler if interval changed and it's running
    if (newConfig.intervalMinutes && newConfig.intervalMinutes !== oldInterval && this.isRunning) {
      logger.info('Restarting scheduler with new interval');
      this.stop();
      this.start();
    }
  }

  /**
   * Check if scheduler is running
   */
  public isActive(): boolean {
    return this.isRunning;
  }

  /**
   * Get scheduler status information
   */
  public getStatus(): {
    isRunning: boolean;
    config: SchedulerConfig;
    nextRunIn?: number; // minutes until next run
  } {
    const status = {
      isRunning: this.isRunning,
      config: this.getConfig(),
    } as any;

    if (this.isRunning && this.timeoutHandle) {
      status.nextRunIn = this.config.intervalMinutes;
    }

    return status;
  }

  /**
   * Manually trigger a reputation recompute job
   */
  public async triggerManualRecompute(options: {
    batchSize?: number;
    forceRecompute?: boolean;
    resumeFromCheckpoint?: boolean;
  } = {}): Promise<string | null> {
    logger.info('Manually triggering reputation recompute job', options);

    const result = await this.queueManager.addJob(
      JobType.REPUTATION_RECOMPUTE,
      {
        batchSize: options.batchSize || this.config.batchSize,
        forceRecompute: options.forceRecompute ?? true,
        resumeFromCheckpoint: options.resumeFromCheckpoint ?? this.config.resumeFromCheckpoint,
      }
    );
    return (result as any).jobId ?? String(result);
  }
}

// Export singleton instance
export const reputationSchedulerService = new ReputationSchedulerService();
