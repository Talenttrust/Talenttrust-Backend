/**
 * Retry Policy Configuration
 * 
 * Centralized retry and backoff policy configuration for BullMQ jobs.
 * Provides sensible defaults while allowing per-job-type overrides.
 */

import { JobType } from './types';

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
  attempts: 3,
  backoff: {
    type: 'exponential',
    delay: 2000,
    multiplier: 2,
    jitter: 0.1,
  },
  removeOnComplete: 100,
  removeOnFail: 1000,
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
 * Environment variable overrides for retry policies
 */
export interface RetryPolicyOverrides {
  [key: string]: Partial<RetryPolicy>;
}

/**
 * Load retry policy overrides from environment variables
 * Format: RETRY_POLICY_{JOB_TYPE}_{PROPERTY}=value
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
          if (!overrides[jobType].backoff) {
            overrides[jobType].backoff = { type: 'exponential', delay: Math.min(parsedDelay, MAX_BACKOFF_DELAY) };
          } else {
            overrides[jobType].backoff = {
              ...overrides[jobType].backoff,
              delay: Math.min(parsedDelay, MAX_BACKOFF_DELAY),
            };
          }
        }
      }
      
      if (multiplier) {
        const parsedMultiplier = parseFloat(multiplier);
        if (!isNaN(parsedMultiplier) && parsedMultiplier > 0) {
          if (!overrides[jobType].backoff) {
            overrides[jobType].backoff = { type: 'exponential', delay: 2000, multiplier: parsedMultiplier };
          } else {
            overrides[jobType].backoff = {
              ...overrides[jobType].backoff,
              multiplier: parsedMultiplier,
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
  });
  
  return overrides;
}
