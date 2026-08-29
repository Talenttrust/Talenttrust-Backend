/**
 * Queue Configuration
 * 
 * Centralized configuration for Redis connection and queue settings.
 * Supports environment-based configuration for different deployment environments.
 */

import { ConnectionOptions } from 'bullmq';
import { z } from 'zod';
import { JobType } from './types';
import { DEFAULT_FAIR_WEIGHTS, DEFAULT_MAX_WAIT_MS, FairSchedulerConfig } from './fair-scheduler';

export const DEFAULT_JOB_TIMEOUT_MS = 30000;

/** Default interval between fair-scheduler rebalance passes per queue. */
export const DEFAULT_FAIR_REBALANCE_INTERVAL_MS = 5000;

/**
 * Zod schema for validating queue tuning environment variables.
 * Ensures concurrency, retry options, backoff settings, and cleanup limits
 * are typed with sensible bounds (e.g. positive integers, correct ranges).
 * 
 * @security
 *  - Secrets (e.g. REDIS_PASSWORD) must not be printed or leaked in validation error messages.
 */
export const queueConfigSchema = z.object({
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.string()
    .default('6379')
    .transform((val) => val === '' ? 6379 : parseInt(val, 10))
    .pipe(z.number().int().min(1).max(65535)),
  REDIS_PASSWORD: z.string().optional(),
  
  QUEUE_CONCURRENCY: z.string()
    .default('5')
    .transform((val) => val === '' ? 5 : parseInt(val, 10))
    .pipe(z.number().int().positive("QUEUE_CONCURRENCY must be a positive integer").max(100, "QUEUE_CONCURRENCY cannot exceed 100")),
  
  QUEUE_DEFAULT_ATTEMPTS: z.string()
    .default('3')
    .transform((val) => val === '' ? 3 : parseInt(val, 10))
    .pipe(z.number().int().nonnegative("QUEUE_DEFAULT_ATTEMPTS must be a non-negative integer").max(10, "QUEUE_DEFAULT_ATTEMPTS cannot exceed 10")),

  QUEUE_BACKOFF_DELAY: z.string()
    .default('2000')
    .transform((val) => val === '' ? 2000 : parseInt(val, 10))
    .pipe(z.number().int().positive("QUEUE_BACKOFF_DELAY must be a positive integer").max(60000, "QUEUE_BACKOFF_DELAY cannot exceed 60000")),

  QUEUE_REMOVE_ON_COMPLETE: z.string()
    .default('100')
    .transform((val) => {
      if (val === 'true') return true;
      if (val === 'false') return false;
      const parsed = parseInt(val, 10);
      return isNaN(parsed) ? val : parsed;
    })
    .pipe(z.union([z.number().int().nonnegative(), z.boolean()])),

  QUEUE_REMOVE_ON_FAIL: z.string()
    .default('1000')
    .transform((val) => {
      if (val === 'true') return true;
      if (val === 'false') return false;
      const parsed = parseInt(val, 10);
      return isNaN(parsed) ? val : parsed;
    })
    .pipe(z.union([z.number().int().nonnegative(), z.boolean()])),

  /**
   * Maximum wait bound for the weighted fair scheduler: a job waiting at least
   * this long is promoted to the front of the queue unconditionally, so no
   * priority stream can starve others indefinitely.
   */
  QUEUE_FAIR_MAX_WAIT_MS: z.string()
    .default(String(DEFAULT_MAX_WAIT_MS))
    .transform((val) => val === '' ? DEFAULT_MAX_WAIT_MS : parseInt(val, 10))
    .pipe(z.number().int().positive("QUEUE_FAIR_MAX_WAIT_MS must be a positive integer").max(86400000, "QUEUE_FAIR_MAX_WAIT_MS cannot exceed 86400000")),

  /**
   * Interval at which the queue manager recomputes fair priorities for waiting
   * jobs (weighted fairness plus max-wait promotion). Bounded to avoid hot loops.
   */
  QUEUE_FAIR_REBALANCE_INTERVAL_MS: z.string()
    .default(String(DEFAULT_FAIR_REBALANCE_INTERVAL_MS))
    .transform((val) => val === '' ? DEFAULT_FAIR_REBALANCE_INTERVAL_MS : parseInt(val, 10))
    .pipe(z.number().int().positive("QUEUE_FAIR_REBALANCE_INTERVAL_MS must be a positive integer").max(3600000, "QUEUE_FAIR_REBALANCE_INTERVAL_MS cannot exceed 3600000")),
});

export type QueueEnvConfig = z.infer<typeof queueConfigSchema>;

export interface QueueConfig {
  redis: ConnectionOptions;
  concurrency: number;
  jobTimeout: {
    defaultMs: number;
    perJobTypeMs: Partial<Record<JobType, number>>;
  };
  defaultJobOptions: {
    attempts: number;
    backoff: {
      type: 'exponential';
      delay: number;
    };
    removeOnComplete: number | boolean;
    removeOnFail: number | boolean;
  };
  /**
   * Weighted fair scheduling bounds. `weights` are compile-time constants
   * (service share proportional to weight); `maxWaitMs` and the rebalance
   * interval are operator-tunable via environment variables.
   */
  fairScheduling: FairSchedulerConfig & { rebalanceIntervalMs: number };
}

/**
 * Validates the provided environment object against the queueConfigSchema.
 * Fails fast on invalid configuration.
 * 
 * @security
 *  - Avoids leaking the actual values in error messages.
 * 
 * @param env - The environment object to validate (defaults to process.env)
 * @returns The validated and typed configuration
 * @throws {Error} If validation fails and running in a test environment
 */
export function validateQueueConfig(env: NodeJS.ProcessEnv = process.env): QueueEnvConfig {
  const result = queueConfigSchema.safeParse(env);

  if (!result.success) {
    const errors = result.error.errors.map((err) => {
      const path = err.path.join('.');
      return `Field "${path}": ${err.message}`;
    });

    const errorMsg = `Queue configuration validation failed:\n${errors.join('\n')}`;
    console.error(`[FATAL] ${errorMsg}`);

    const isTest = process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID;
    if (!isTest) {
      process.exit(1);
    } else {
      throw new Error(errorMsg);
    }
  }

  return result.data;
}

// Parse once at startup
const parsed = validateQueueConfig(process.env);

/**
 * Get Redis connection configuration from environment variables
 * Falls back to localhost defaults for development
 */
export function getRedisConfig(): ConnectionOptions {
  return {
    host: parsed.REDIS_HOST,
    port: parsed.REDIS_PORT,
    password: parsed.REDIS_PASSWORD,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  };
}

/** Default per-job attempt timeout in milliseconds (30 seconds). */
const DEFAULT_JOB_TIMEOUT_MS = 30_000;

function parsePositiveTimeout(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function envKeyForJobTimeout(jobType: JobType): string {
  return `QUEUE_JOB_TIMEOUT_${jobType.toUpperCase().replace(/-/g, '_')}_MS`;
}

function loadJobTimeoutOverrides(defaultMs: number): Partial<Record<JobType, number>> {
  const overrides: Partial<Record<JobType, number>> = {};

  Object.values(JobType).forEach((jobType) => {
    const value = process.env[envKeyForJobTimeout(jobType)];
    if (value !== undefined) {
      overrides[jobType] = parsePositiveTimeout(value, defaultMs);
    }
  });

  return overrides;
}

export function getJobTimeoutMs(jobType: JobType): number {
  return queueConfig.jobTimeout.perJobTypeMs[jobType] ?? queueConfig.jobTimeout.defaultMs;
}

/**
 * Centralized queue configuration object.
 * Validated at startup to ensure fail-fast behavior.
 */
const defaultJobTimeoutMs = parsePositiveTimeout(
  process.env.QUEUE_JOB_TIMEOUT_MS,
  DEFAULT_JOB_TIMEOUT_MS,
);

export const queueConfig: QueueConfig = {
  redis: getRedisConfig(),
  concurrency: parsed.QUEUE_CONCURRENCY,
  jobTimeout: {
    defaultMs: defaultJobTimeoutMs,
    perJobTypeMs: loadJobTimeoutOverrides(defaultJobTimeoutMs),
  },
  defaultJobOptions: {
    attempts: parsed.QUEUE_DEFAULT_ATTEMPTS,
    backoff: {
      type: 'exponential',
      delay: parsed.QUEUE_BACKOFF_DELAY,
    },
    removeOnComplete: parsed.QUEUE_REMOVE_ON_COMPLETE,
    removeOnFail: parsed.QUEUE_REMOVE_ON_FAIL,
  },
  fairScheduling: {
    weights: DEFAULT_FAIR_WEIGHTS,
    maxWaitMs: parsed.QUEUE_FAIR_MAX_WAIT_MS,
    rebalanceIntervalMs: parsed.QUEUE_FAIR_REBALANCE_INTERVAL_MS,
  },
};

