/**
 * @module milestones/divergence/scheduler
 * @description Periodic scheduler for milestone divergence scan jobs.
 *
 * Mirrors the reputation recompute scheduler pattern: a lightweight service
 * that enqueues `MILESTONE_DIVERGENCE_SCAN` jobs on an interval. The scan job
 * itself is bounded, so scheduling a run every `intervalMinutes` walks the
 * full contract set incrementally (each run compares up to `maxContracts`).
 *
 * The scheduler is **not** auto-started on boot; operators opt in via
 * `MILESTONE_DIVERGENCE_SCAN_ENABLED=true` (see `src/index.ts`) or trigger a
 * run on demand through the admin endpoint.
 */

import { QueueManager } from '../../queue/queue-manager';
import { JobType } from '../../queue/types';
import { logger } from '../../logger';
import { DEFAULT_MAX_CONTRACTS_PER_RUN } from './scanner';

export interface DivergenceSchedulerConfig {
  enabled: boolean;
  /** Interval between scheduled runs, in minutes. */
  intervalMinutes: number;
  /** Contracts compared per run (bounded by the scanner's own cap). */
  maxContracts: number;
}

export const DIVERGENCE_SCHEDULER_ENV = {
  ENABLED: 'MILESTONE_DIVERGENCE_SCAN_ENABLED',
  INTERVAL_MINUTES: 'MILESTONE_DIVERGENCE_SCAN_INTERVAL_MINUTES',
  MAX_CONTRACTS: 'MILESTONE_DIVERGENCE_SCAN_MAX_CONTRACTS',
} as const;

function parsePositiveIntEnv(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export class MilestoneDivergenceSchedulerService {
  private readonly queueManager: QueueManager;
  private config: DivergenceSchedulerConfig;
  private isRunning = false;
  private timeoutHandle: Promise<void> | null = null;

  constructor(config: Partial<DivergenceSchedulerConfig> = {}) {
    this.queueManager = QueueManager.getInstance();
    this.config = {
      enabled:
        config.enabled ??
        process.env[DIVERGENCE_SCHEDULER_ENV.ENABLED] === 'true',
      intervalMinutes:
        config.intervalMinutes ??
        parsePositiveIntEnv(
          process.env[DIVERGENCE_SCHEDULER_ENV.INTERVAL_MINUTES],
          60 * 24,
        ),
      maxContracts:
        config.maxContracts ??
        parsePositiveIntEnv(
          process.env[DIVERGENCE_SCHEDULER_ENV.MAX_CONTRACTS],
          DEFAULT_MAX_CONTRACTS_PER_RUN,
        ),
    };
  }

  /** Starts the periodic scheduler (idempotent; no-op when disabled). */
  public async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Milestone divergence scheduler is already running');
      return;
    }
    if (!this.config.enabled) {
      logger.info('Milestone divergence scheduler is disabled');
      return;
    }

    await this.queueManager.initializeQueue(JobType.MILESTONE_DIVERGENCE_SCAN);
    this.isRunning = true;
    logger.info('Milestone divergence scheduler started', {
      intervalMinutes: this.config.intervalMinutes,
      maxContracts: this.config.maxContracts,
    });

    await this.scheduleScanJob();
    this.scheduleNextRun();
  }

  /** Stops the periodic scheduler. */
  public stop(): void {
    if (!this.isRunning) {
      logger.warn('Milestone divergence scheduler is not running');
      return;
    }
    this.isRunning = false;
    this.timeoutHandle = null;
    logger.info('Milestone divergence scheduler stopped');
  }

  public isActive(): boolean {
    return this.isRunning;
  }

  public getConfig(): DivergenceSchedulerConfig {
    return { ...this.config };
  }

  /** Enqueues a single scan job; returns its id or null on failure. */
  public async scheduleScanJob(): Promise<string | null> {
    try {
      const result = await this.queueManager.addJob(
        JobType.MILESTONE_DIVERGENCE_SCAN,
        {
          maxContracts: this.config.maxContracts,
        },
        { tenantId: 'default' },
      );
      const jobId = (result as { jobId?: string }).jobId ?? String(result);
      logger.info('Scheduled milestone divergence scan job', {
        jobId,
        maxContracts: this.config.maxContracts,
      });
      return jobId;
    } catch (error) {
      logger.error('Failed to schedule milestone divergence scan job', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return null;
    }
  }

  private scheduleNextRun(): void {
    if (!this.isRunning) return;
    const intervalMs = this.config.intervalMinutes * 60 * 1000;
    const started = Date.now();
    this.timeoutHandle = new Promise<void>((resolve) => {
      const check = (): void => {
        if (!this.isRunning) {
          resolve();
          return;
        }
        if (Date.now() - started >= intervalMs) {
          void this.scheduleScanJob();
          this.scheduleNextRun();
          resolve();
          return;
        }
        setImmediate(check);
      };
      setImmediate(check);
    });
  }
}

/** Singleton instance (mirrors the reputation scheduler pattern). */
export const milestoneDivergenceSchedulerService =
  new MilestoneDivergenceSchedulerService();
