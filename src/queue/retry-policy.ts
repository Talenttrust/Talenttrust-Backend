/**
 * Retry Policy Configuration
 * 
 * Centralized retry and backoff policy configuration for BullMQ jobs.
 * Provides sensible defaults while allowing per-job-type overrides.
 */

import { JobType } from './types';
import { queueConfig } from './config';
import { logger } from '../logger';

/**
 * Retry policy configuration interface
 */
export interface RetryPolicy {
  /** Maximum number of retry attempts */
  attempts: number;
  /** Backoff strategy for retries */
  backoff: {
    type: 'exponential' | 'fixed' | 'custom';
    delay: number;
    /** Optional multiplier for exponential backoff */
    multiplier?: number;
    /** Optional jitter to prevent thundering herd */
    jitter?: number;
  };
  /** Whether to remove job on successful completion */
  removeOnComplete: number | boolean;
  /** Whether to remove job on final failure */
  removeOnFail: number | boolean;
  /** Optional custom retry condition function */
  retryCondition?: (error: Error, attempts: number) => boolean;
}

/**
 * Default retry policies for different job types
 * Each job type can have its own optimized retry strategy
 */
export const DEFAULT_RETRY_POLICIES: Record<JobType, RetryPolicy> = {
  [JobType.EMAIL_NOTIFICATION]: {
    attempts: 5,
    backoff: {
      type: 'exponential',
      delay: 1000,
      multiplier: 2,
      jitter: 0.1,
    },
    removeOnComplete: 100,
    removeOnFail: 50,
  },
  
  [JobType.CONTRACT_PROCESSING]: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000,
      multiplier: 2,
      jitter: 0.2,
    },
    removeOnComplete: 100,
    removeOnFail: 100,
  },
  
  [JobType.REPUTATION_UPDATE]: {
    attempts: 2,
    backoff: {
      type: 'fixed',
      delay: 5000,
    },
    removeOnComplete: 200,
    removeOnFail: 200,
  },
  
  [JobType.BLOCKCHAIN_SYNC]: {
    attempts: 8,
    backoff: {
      type: 'exponential',
      delay: 5000,
      multiplier: 1.5,
      jitter: 0.3,
    },
    removeOnComplete: 50,
    removeOnFail: 25,
  },

  [JobType.REPUTATION_RECOMPUTE]: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000,
      multiplier: 2,
      jitter: 0.2,
    },
    removeOnComplete: 100,
    removeOnFail: 100,
  },
};

/**
 * Fallback retry policy for unknown job types
 */
export const FALLBACK_RETRY_POLICY: RetryPolicy = {
  attempts: queueConfig.defaultJobOptions.attempts,
  backoff: {
    type: 'exponential',
    delay: queueConfig.defaultJobOptions.backoff.delay,
    multiplier: 2,
    jitter: 0.1,
  },
  removeOnComplete: queueConfig.defaultJobOptions.removeOnComplete,
  removeOnFail: queueConfig.defaultJobOptions.removeOnFail,
};

/**
 * Maximum allowed retry attempts to prevent infinite retries
 */
export const MAX_RETRY_ATTEMPTS = 10;

/**
 * Maximum allowed backoff delay to prevent excessive delays
 */
export const MAX_BACKOFF_DELAY = 300000; // 5 minutes

/**
 * Minimum allowed backoff delay (in ms) for overrides.
 */
export const MIN_BACKOFF_DELAY = 1; // 1 ms

/**
 * Minimum allowed backoff multiplier for exponential overrides.
 */
export const MIN_BACKOFF_MULTIPLIER = 1;

/**
 * Maximum allowed backoff multiplier for exponential overrides.
 * Combined with MAX_BACKOFF_DELAY this keeps backoff growth bounded and
 * prevents a hostile/misconfigured `RETRY_POLICY_*_MULTIPLIER` from causing an
 * exponential-backoff explosion that effectively stalls a job type.
 */
export const MAX_BACKOFF_MULTIPLIER = 10;

/**
 * Clamp a numeric value into the inclusive [min, max] range, logging a warning
 * when the original value had to be adjusted.
 */
function clampWithWarning(
  value: number,
  min: number,
  max: number,
  context: { jobType: string; field: string }
): number {
  const clamped = Math.min(Math.max(value, min), max);
  if (clamped !== value) {
    logger.warn('Retry policy override clamped to safe bounds', {
      ...context,
      provided: value,
      clamped,
      min,
      max,
    });
  }
  return clamped;
}

/**
 * Environment variable overrides for retry policies
 */
export interface RetryPolicyOverrides {
  [key: string]: Partial<RetryPolicy>;
}

/**
 * Load retry policy overrides from environment variables.
 *
 * Format: `RETRY_POLICY_{JOB_TYPE}_{PROPERTY}=value`
 * (e.g. `RETRY_POLICY_EMAIL_NOTIFICATION_MULTIPLIER=2`).
 *
 * All numeric overrides are validated and clamped to safe bounds so that no
 * environment value can produce an unbounded backoff explosion:
 *  - `ATTEMPTS`   → `(0, MAX_RETRY_ATTEMPTS]`
 *  - `DELAY`      → `[MIN_BACKOFF_DELAY, MAX_BACKOFF_DELAY]`
 *  - `MULTIPLIER` → `[MIN_BACKOFF_MULTIPLIER, MAX_BACKOFF_MULTIPLIER]`
 *  - `JITTER`     → `[0, 1]`
 *
 * Incoherent combinations are rejected: a `multiplier` is only meaningful for
 * `exponential` backoff, so it is dropped (with a warning) when the resolved
 * backoff type is `fixed`. Out-of-range values are clamped and a warning is
 * emitted via the structured logger rather than throwing in the hot path.
 *
 * @returns Partial retry policies keyed by job type, to be merged over the
 *          built-in {@link DEFAULT_RETRY_POLICIES} defaults.
 */
export function loadRetryPolicyOverrides(): RetryPolicyOverrides {
  const overrides: RetryPolicyOverrides = {};
  
  Object.values(JobType).forEach(jobType => {
    const prefix = `RETRY_POLICY_${jobType.toUpperCase().replace('-', '_')}_`;
    
    // Check for environment variable overrides
    const attempts = process.env[`${prefix}ATTEMPTS`];
    const delay = process.env[`${prefix}DELAY`];
    const multiplier = process.env[`${prefix}MULTIPLIER`];
    const jitter = process.env[`${prefix}JITTER`];
    
        
    if (attempts || delay || multiplier || jitter) {
      overrides[jobType] = {};
      
      if (attempts) {
        const parsedAttempts = parseInt(attempts, 10);
        if (!isNaN(parsedAttempts) && parsedAttempts > 0) {
          overrides[jobType].attempts = Math.min(parsedAttempts, MAX_RETRY_ATTEMPTS);
        }
      }
      
      if (delay) {
        const parsedDelay = parseInt(delay, 10);
        if (!isNaN(parsedDelay) && parsedDelay > 0) {
          const clampedDelay = clampWithWarning(parsedDelay, MIN_BACKOFF_DELAY, MAX_BACKOFF_DELAY, {
            jobType,
            field: 'delay',
          });
          if (!overrides[jobType].backoff) {
            overrides[jobType].backoff = { type: 'exponential', delay: clampedDelay };
          } else {
            overrides[jobType].backoff = {
              ...overrides[jobType].backoff,
              delay: clampedDelay,
            };
          }
        }
      }

      if (multiplier) {
        const parsedMultiplier = parseFloat(multiplier);
        if (!isNaN(parsedMultiplier) && parsedMultiplier > 0) {
          const clampedMultiplier = clampWithWarning(
            parsedMultiplier,
            MIN_BACKOFF_MULTIPLIER,
            MAX_BACKOFF_MULTIPLIER,
            { jobType, field: 'multiplier' }
          );
          if (!overrides[jobType].backoff) {
            overrides[jobType].backoff = { type: 'exponential', delay: 2000, multiplier: clampedMultiplier };
          } else {
            overrides[jobType].backoff = {
              ...overrides[jobType].backoff,
              multiplier: clampedMultiplier,
            };
          }
        }
      }

      if (jitter) {
        const parsedJitter = parseFloat(jitter);
        if (!isNaN(parsedJitter) && parsedJitter >= 0 && parsedJitter <= 1) {
          if (!overrides[jobType].backoff) {
            overrides[jobType].backoff = { type: 'exponential', delay: 2000, jitter: parsedJitter };
          } else {
            overrides[jobType].backoff = {
              ...overrides[jobType].backoff,
              jitter: parsedJitter,
            };
          }
        }
      }
    }

    // Coherence guard: a `multiplier` only makes sense for exponential backoff.
    // If the resolved override declares a `fixed` backoff that still carries a
    // multiplier, drop it so the resulting policy is internally consistent.
    const backoff = overrides[jobType]?.backoff;
    if (backoff && backoff.type === 'fixed' && backoff.multiplier !== undefined) {
      logger.warn('Dropping multiplier from incoherent fixed-backoff override', {
        jobType,
        multiplier: backoff.multiplier,
      });
      const { multiplier: _dropped, ...rest } = backoff;
      overrides[jobType].backoff = rest;
    }

    // Discard entries that ended up empty because every candidate value was
    // invalid (NaN, non-positive, or out of the accepted range). A truthy but
    // unparseable env var (e.g. `MULTIPLIER=not-a-number` or `MULTIPLIER=-2`)
    // must not leave behind a phantom `{}` override for the job type.
    if (overrides[jobType] && Object.keys(overrides[jobType]).length === 0) {
      delete overrides[jobType];
    }
  });

  return overrides;
}
