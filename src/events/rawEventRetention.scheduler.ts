/**
 * @module events/rawEventRetention.scheduler
 * @description Periodic scheduler for the raw event retention job.
 *
 * Mirrors the reputation recompute scheduler pattern: enqueues
 * `RAW_EVENT_RETENTION` jobs on an interval so raw payloads are archived and
 * purged on a schedule. Each run is bounded (`maxPerRun`), so the job never
 * sweeps the entire table at once.
 *
 * The scheduler is opt-in via `RAW_EVENT_RETENTION_ENABLED=true`
 * (see `src/index.ts`); operators can also trigger a run on demand through
 * the jobs API.
 */

import { QueueManager } from '../queue/queue-manager';
import { JobType } from '../queue/types';
import { logger } from '../logger';
import { loadRawEventRetentionConfig } from './rawEventRetention';

export interface RawEventRetentionSchedulerConfig {
  enabled: boolean;
  /** Interval between scheduled runs, in minutes. */
  intervalMinutes: number;
}

export const RAW_EVENT_RETENTION_SCHEDULER_ENV = {
  INTERVAL_MINUTES: 'RAW_EVENT_RETENTION_INTERVAL_MINUTES',
} as const;

function parsePositiveIntEnv(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export class RawEventRetentionSchedulerService {
  private readonly queueManager: QueueManager;
  private config: RawEventRetentionSchedulerConfig;
  private isRunning = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(config: Partial<RawEventRetentionSchedulerConfig> = {}) {
    this.queueManager = QueueManager.getInstance();
    const retentionConfig = loadRawEventRetentionConfig();
    this.config = {
      enabled:
        config.enabled ?? retentionConfig.enabled,
      intervalMinutes:
        config.intervalMinutes ??
        parsePositiveIntEnv(
          process.env[RAW_EVENT_RETENTION_SCHEDULER_ENV.INTERVAL_MINUTES],
          60 * 24,
        ),
    };
  }

  /** Starts the periodic scheduler (idempotent; no-op when disabled). */
  public async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Raw event retention scheduler is already running');
      return;
    }
    if (!this.config.enabled) {
      logger.info('Raw event retention scheduler is disabled');
      return;
    }

    await this.queueManager.initializeQueue(JobType.RAW_EVENT_RETENTION);
    this.isRunning = true;
    logger.info('Raw event retention scheduler started', {
      intervalMinutes: this.config.intervalMinutes,
    });

    await this.scheduleRetentionJob();
    this.timer = setInterval(() => {
      void this.scheduleRetentionJob();
    }, this.config.intervalMinutes * 60 * 1000);
    // Never keep the process alive solely for the retention timer.
    this.timer.unref?.();
  }

  /** Stops the periodic scheduler. */
  public stop(): void {
    if (!this.isRunning) return;
    this.isRunning = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    logger.info('Raw event retention scheduler stopped');
  }

  public isActive(): boolean {
    return this.isRunning;
  }

  public getConfig(): RawEventRetentionSchedulerConfig {
    return { ...this.config };
  }

  /** Enqueues a single retention job; returns its id or null on failure. */
  public async scheduleRetentionJob(): Promise<string | null> {
    try {
      const result = await this.queueManager.addJob(JobType.RAW_EVENT_RETENTION, {});
      const jobId = (result as { jobId?: string }).jobId ?? String(result);
      logger.info('Scheduled raw event retention job', { jobId });
      return jobId;
    } catch (error) {
      logger.error('Failed to schedule raw event retention job', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return null;
    }
  }
}

/** Singleton instance (mirrors the reputation scheduler pattern). */
export const rawEventRetentionSchedulerService =
  new RawEventRetentionSchedulerService();
