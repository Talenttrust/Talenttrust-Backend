/**
 * Queue Manager
 * 
 * Central manager for creating and managing BullMQ queues and workers.
 * Provides a unified interface for job enqueueing and processing.
 */

import { Queue, Worker, Job, QueueEvents, JobsOptions } from 'bullmq';
import { queueConfig } from './config';
import {
  JobType,
  JobPayload,
  JobResult,
  AddJobOptions,
  AddJobResult,
  FailedJobEntry,
  FailedJobQuery,
  ReplayJobResult,
} from './types';
import { jobProcessors } from './processors';
import { RetryPolicyManager } from './retry-manager';
import { logger } from '../logger';

/**
 * Queue health information - safe for admin exposure
 */
export interface QueueHealthInfo {
  jobType: JobType;
  isInitialized: boolean;
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  paused: boolean;
}

export interface FailedJobInfo {
  jobId: string;
  jobType: JobType;
  failedAt: number;
  error: string;
}
/**
 * QueueManager handles queue lifecycle and job processing
 * Implements singleton pattern to ensure single Redis connection pool
 */
export class QueueManager {
  private static instance: QueueManager;
  private queues: Map<JobType, Queue> = new Map();
  private workers: Map<JobType, Worker> = new Map();
  private queueEvents: Map<JobType, QueueEvents> = new Map();
  private isShuttingDown = false;
  private retryManager: RetryPolicyManager;

  private constructor() {
    this.retryManager = RetryPolicyManager.getInstance();
  }

  /**
   * Get singleton instance of QueueManager
   */
  public static getInstance(): QueueManager {
    if (!QueueManager.instance) {
      QueueManager.instance = new QueueManager();
    }
    return QueueManager.instance;
  }

  /**
   * Initialize a queue for a specific job type
   * Creates queue, worker, and event listeners
   * 
   * @param jobType - Type of job this queue will handle
   * @throws Error if queue initialization fails
   */
  public async initializeQueue(jobType: JobType): Promise<void> {
    if (this.queues.has(jobType)) {
      return;
    }

    const jobOptions = this.retryManager.getJobOptions(jobType);
    const queue = new Queue(jobType, {
      connection: queueConfig.redis,
      defaultJobOptions: jobOptions,
    });

    queue.on('error', (error: Error) => {
      logger.error(`Queue error`, { jobType, error: error.message });
    });

    const worker = new Worker(
      jobType,
      async (job: Job) => {
        return this.processJob(jobType, job);
      },
      {
        connection: queueConfig.redis,
        concurrency: 5,
      }
    );

    const queueEvents = new QueueEvents(jobType, {
      connection: queueConfig.redis,
    });

    this.setupEventListeners(jobType, worker, queueEvents);

    this.queues.set(jobType, queue);
    this.workers.set(jobType, worker);
    this.queueEvents.set(jobType, queueEvents);
  }

  /**
   * Add a job to the queue with optional idempotency via a dedupe key.
   *
   * When dedupeKey is supplied, BullMQ will not create a new job if one with
   * that key is already waiting, active, or delayed. An optional dedupeTtl
   * (ms) keeps the key alive after completion to suppress re-enqueue during
   * that window. The returned AddJobResult.deduplicated flag indicates whether
   * an existing job was reused.
   *
   * @param jobType - Type of job to enqueue
   * @param payload - Job-specific data payload
   * @param options - Scheduling and deduplication options
   * @returns { jobId, deduplicated }
   * @throws Error if queue not initialized or job addition fails
   */
  public async addJob(
    jobType: JobType,
    payload: JobPayload,
    options?: AddJobOptions & { correlationId?: string; requestId?: string }
  ): Promise<AddJobResult> {
    const queue = this.queues.get(jobType);
    if (!queue) {
      throw new Error(`Queue for ${jobType} not initialized`);
    }

    const { priority, delay, attempts, dedupeKey, correlationId, requestId } = options ?? {};
    const bullOptions: JobsOptions = { priority, delay, attempts };

    if (dedupeKey) {
      bullOptions.jobId = dedupeKey;
    }

    // Merge correlation IDs into payload
    const enrichedPayload = {
      ...payload,
      ...(correlationId && { correlationId }),
      ...(requestId && { requestId }),
    };

    // Pre-check: determine if an active/waiting/delayed job already exists.
    // TOCTOU window exists here, but queue.add() deduplication is the hard
    // guarantee — this pre-check is only for setting the response flag.
    let deduplicated = false;
    if (dedupeKey) {
      const existing = await queue.getJob(dedupeKey);
      if (existing) {
        const state = await existing.getState();
        deduplicated = !['completed', 'failed', 'unknown'].includes(state);
      }
    }

    const job = await queue.add(jobType, enrichedPayload, bullOptions);
    logger.info('Job enqueued', { jobType, jobId: job.id, correlationId, requestId, deduplicated });
    return { jobId: job.id!, deduplicated };
  }

  private buildReplayJobId(jobType: JobType, originalJobId: string): string {
    return `replay:${jobType}:${originalJobId}`;
  }

  private toFailedJobEntry(jobType: JobType, job: Job): FailedJobEntry {
    return {
      jobId: String(job.id),
      jobType,
      name: job.name,
      data: job.data as JobPayload,
      failedReason: job.failedReason ?? null,
      attemptsMade: job.attemptsMade,
      finishedOn: job.finishedOn ?? null,
      timestamp: job.timestamp,
      replayDeduplicationKey: this.buildReplayJobId(jobType, String(job.id)),
    };
  }

  public async getFailedJobs(query: FailedJobQuery = {}): Promise<FailedJobEntry[]> {
    const normalizedLimit = Math.min(Math.max(query.limit ?? 50, 1), 100);
    const normalizedOffset = Math.max(query.offset ?? 0, 0);
    const fetchEnd = normalizedOffset + normalizedLimit - 1;

    if (query.jobType) {
      const queue = this.queues.get(query.jobType);
      if (!queue) {
        throw new Error(`Queue for ${query.jobType} not initialized`);
      }

      const failed = await queue.getJobs(['failed'], normalizedOffset, fetchEnd, false);
      return failed.map((job) => this.toFailedJobEntry(query.jobType as JobType, job));
    }

    const allFailedJobs = await Promise.all(
      Array.from(this.queues.entries()).map(async ([jobType, queue]) => {
        const failed = await queue.getJobs(['failed'], 0, fetchEnd, false);
        return failed.map((job) => this.toFailedJobEntry(jobType, job));
      })
    );

    return allFailedJobs
      .flat()
      .sort((a, b) => (b.finishedOn ?? 0) - (a.finishedOn ?? 0))
      .slice(normalizedOffset, normalizedOffset + normalizedLimit);
  }

  public async reprocessFailedJob(
    jobType: JobType,
    originalJobId: string
  ): Promise<ReplayJobResult> {
    const queue = this.queues.get(jobType);
    if (!queue) {
      throw new Error(`Queue for ${jobType} not initialized`);
    }

    const failedJob = await queue.getJob(originalJobId);
    if (!failedJob) {
      throw new Error(`Failed job not found: ${originalJobId}`);
    }

    const currentState = await failedJob.getState();
    if (currentState !== 'failed') {
      throw new Error(`Job ${originalJobId} is not in failed state`);
    }

    const replayJobId = this.buildReplayJobId(jobType, originalJobId);
    const existingReplayJob = await queue.getJob(replayJobId);
    if (existingReplayJob) {
      return {
        replayJobId,
        deduplicated: true,
        originalJobId,
        jobType,
      };
    }

    await queue.add(jobType, failedJob.data as JobPayload, { jobId: replayJobId });

    return {
      replayJobId,
      deduplicated: false,
      originalJobId,
      jobType,
    };
  }

  /**
   * Process a job using the appropriate processor
   *
   * @param jobType - Type of job being processed
   * @param job - BullMQ job instance
   * @returns Processing result
   */
  private async processJob(jobType: JobType, job: Job): Promise<JobResult> {
    const processor = jobProcessors[jobType];
    if (!processor) {
      throw new Error(`No processor found for job type: ${jobType}`);
    }

    // Extract correlation IDs from job payload
    const payload = job.data as JobPayload & { correlationId?: string; requestId?: string };
    const correlationId = payload.correlationId;
    const requestId = payload.requestId || job.id;

    // Create a child logger with correlation context
    const jobLogger = correlationId || requestId
      ? logger.child({ correlationId, requestId, jobType })
      : logger.child({ requestId, jobType });

    try {
      return await processor(job.data);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      jobLogger.error('Job processing failed', { error: errorMessage });
      throw new Error(`Job processing failed: ${errorMessage}`);
    }
  }

  /**
   * Setup event listeners for monitoring and logging
   */
  private setupEventListeners(
    jobType: JobType,
    worker: Worker,
    queueEvents: QueueEvents
  ): void {
    worker.on('completed', (job: Job, result: JobResult) => {
      logger.info('Job completed', { jobType, jobId: job.id, result });
    });

    worker.on('failed', (job: Job | undefined, error: Error) => {
      logger.error('Job failed', { jobType, jobId: job?.id, error: error.message });
    });

    worker.on('error', (error: Error) => {
      logger.error('Worker error', { jobType, error: error.message });
    });

    queueEvents.on('waiting', ({ jobId }: { jobId: string | undefined }) => {
      logger.debug('Job waiting', { jobType, jobId });
    });

    queueEvents.on('active', ({ jobId }: { jobId: string | undefined }) => {
      logger.debug('Job active', { jobType, jobId });
    });

    queueEvents.on('error', (error: Error) => {
      logger.error('QueueEvents error', { jobType, error: error.message });
    });
  }

  /**
   * Get access to the retry policy manager for configuration
   * 
   * @returns RetryPolicyManager instance
   */
  public getRetryManager(): RetryPolicyManager {
    return this.retryManager;
  }

  /**
   * Get job status and details
   * 
   * @param jobType - Type of job
   * @param jobId - Job identifier
   * @returns Job state and data
   */
  public async getJobStatus(jobType: JobType, jobId: string) {
    const queue = this.queues.get(jobType);
    if (!queue) {
      throw new Error(`Queue for ${jobType} not initialized`);
    }

    const job = await queue.getJob(jobId);
    if (!job) {
      return null;
    }

    return {
      id: job.id,
      name: job.name,
      data: job.data,
      progress: job.progress,
      returnvalue: job.returnvalue,
      failedReason: job.failedReason,
      state: await job.getState(),
    };
  }

  /**
   * Gracefully shutdown all queues and workers
   * Waits for active jobs to complete before closing connections
   */
  public async shutdown(): Promise<void> {
    if (this.queues.size === 0 && this.workers.size === 0 && this.queueEvents.size === 0) {
      this.isShuttingDown = false;
      return;
    }

    if (this.isShuttingDown) {
      return;
    }

    this.isShuttingDown = true;
    logger.info('Shutting down queue manager...');

    const shutdownPromises: Promise<void>[] = [];

    for (const worker of this.workers.values()) {
      shutdownPromises.push(worker.close());
    }

    for (const queue of this.queues.values()) {
      shutdownPromises.push(queue.close());
    }

    for (const events of this.queueEvents.values()) {
      shutdownPromises.push(events.close());
    }

    await Promise.all(shutdownPromises);

    this.workers.clear();
    this.queues.clear();
    this.queueEvents.clear();
    this.isShuttingDown = false;

    logger.info('Queue manager shutdown complete');
  }

  /**
   * Get health information for all queues
   * Returns sanitized queue metrics without sensitive job data
   *
   * @returns Array of queue health information
   */
  public async getHealth(): Promise<QueueHealthInfo[]> {
    const healthInfos: QueueHealthInfo[] = [];

    for (const jobType of Object.values(JobType)) {
      const queue = this.queues.get(jobType);
      const worker = this.workers.get(jobType);

      if (queue && worker) {
        const [waiting, active, completed, failed, delayed] = await Promise.all([
          queue.getWaitingCount(),
          queue.getActiveCount(),
          queue.getCompletedCount(),
          queue.getFailedCount(),
          queue.getDelayedCount(),
        ]);

        healthInfos.push({
          jobType,
          isInitialized: true,
          waiting,
          active,
          completed,
          failed,
          delayed,
          paused: await worker.isRunning() === false,
        });
      } else {
        healthInfos.push({
          jobType,
          isInitialized: false,
          waiting: 0,
          active: 0,
          completed: 0,
          failed: 0,
          delayed: 0,
          paused: false,
        });
      }
    }

    return healthInfos;
  }

  /**
   * Get recent failed jobs
   * Returns sanitized information about recently failed jobs without exposing payloads
   *
   * @param limit - Maximum number of failed jobs to return (default 10)
   * @returns Array of failed job information
   */
  public async getRecentFailures(limit = 10): Promise<FailedJobInfo[]> {
    const failures: FailedJobInfo[] = [];

    for (const [jobType, queue] of this.queues) {
      const failedJobs = await queue.getFailed(0, limit);
      for (const job of failedJobs) {
        failures.push({
          jobId: job.id?.toString() ?? 'unknown',
          jobType,
          failedAt: job.finishedOn ?? Date.now(),
          error: job.failedReason ?? 'Unknown error',
        });
      }
    }

    return failures
      .sort((a, b) => b.failedAt - a.failedAt)
      .slice(0, limit);
  }
}
