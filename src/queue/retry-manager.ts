/**
 * Retry Policy Manager
 * 
 * Centralized manager for retry policies with validation and override support.
 * Ensures consistent retry behavior across all job types while preventing
 * unbounded retries and job storms.
 */

import { JobType } from './types';
import { 
  RetryPolicy, 
  DEFAULT_RETRY_POLICIES, 
  FALLBACK_RETRY_POLICY, 
  MAX_RETRY_ATTEMPTS, 
  MAX_BACKOFF_DELAY,
  RetryPolicyOverrides,
  loadRetryPolicyOverrides 
} from './retry-policy';

/**
 * Validation errors for retry policies
 */
export class RetryPolicyValidationError extends Error {
  constructor(message: string) {
    super(`Retry Policy Validation Error: ${message}`);
    this.name = 'RetryPolicyValidationError';
  }
}

/**
 * Retry Policy Manager
 * 
 * Provides centralized access to retry policies with validation,
 * environment overrides, and safety checks.
 */
export class RetryPolicyManager {
  private static instance: RetryPolicyManager;
  private policies: Map<JobType, RetryPolicy> = new Map();
  private overrides: RetryPolicyOverrides = {};

  private constructor() {
    this.initializePolicies();
  }

  /**
   * Get singleton instance of RetryPolicyManager
   */
  public static getInstance(): RetryPolicyManager {
    if (!RetryPolicyManager.instance) {
      RetryPolicyManager.instance = new RetryPolicyManager();
    }
    return RetryPolicyManager.instance;
  }

  /**
   * Initialize default policies and load environment overrides
   */
  private initializePolicies(): void {
    // Load default policies
    Object.entries(DEFAULT_RETRY_POLICIES).forEach(([jobType, policy]) => {
      this.policies.set(jobType as JobType, this.validatePolicy(policy));
    });

    // Load environment overrides
    this.overrides = loadRetryPolicyOverrides();
    
    // Apply overrides
    Object.entries(this.overrides).forEach(([jobType, override]) => {
      const currentPolicy = this.policies.get(jobType as JobType) || FALLBACK_RETRY_POLICY;
      const mergedPolicy = { ...currentPolicy, ...override };
      
      // Handle nested backoff overrides
      if (override.backoff) {
        mergedPolicy.backoff = { ...currentPolicy.backoff, ...override.backoff };
      }
      
      this.policies.set(jobType as JobType, this.validatePolicy(mergedPolicy));
    });
  }

  /**
   * Get retry policy for a specific job type
   * 
   * @param jobType - Type of job
   * @returns Validated retry policy
   */
  public getRetryPolicy(jobType: JobType): RetryPolicy {
    const policy = this.policies.get(jobType);
    
    if (!policy) {
      // Use fallback policy for unknown job types
      // In production, consider adding proper logging here
      return this.validatePolicy(FALLBACK_RETRY_POLICY);
    }
    
    return policy;
  }

  /**
   * Get retry policy formatted for BullMQ job options
   * 
   * @param jobType - Type of job
   * @returns BullMQ-compatible job options
   */
  public getJobOptions(jobType: JobType) {
    const policy = this.getRetryPolicy(jobType);
    
    return {
      attempts: policy.attempts,
      backoff: {
        type: policy.backoff.type,
        delay: policy.backoff.delay,
        ...(policy.backoff.multiplier && { multiplier: policy.backoff.multiplier }),
        ...(policy.backoff.jitter && { jitter: policy.backoff.jitter }),
      },
      removeOnComplete: policy.removeOnComplete,
      removeOnFail: policy.removeOnFail,
    };
  }

  /**
   * Register a custom retry policy for a job type
   * 
   * @param jobType - Type of job
   * @param policy - Custom retry policy
   * @throws RetryPolicyValidationError if policy is invalid
   */
  public registerRetryPolicy(jobType: JobType, policy: RetryPolicy): void {
    const validatedPolicy = this.validatePolicy(policy);
    this.policies.set(jobType, validatedPolicy);
  }

  /**
   * Update retry policy for a job type (partial update)
   * 
   * @param jobType - Type of job
   * @param updates - Partial policy updates
   * @throws RetryPolicyValidationError if updates are invalid
   */
  public updateRetryPolicy(jobType: JobType, updates: Partial<RetryPolicy>): void {
    const currentPolicy = this.getRetryPolicy(jobType);
    const updatedPolicy = { ...currentPolicy, ...updates };
    
    // Handle nested backoff updates
    if (updates.backoff) {
      updatedPolicy.backoff = { ...currentPolicy.backoff, ...updates.backoff };
    }
    
    this.policies.set(jobType, this.validatePolicy(updatedPolicy));
  }

  /**
   * Validate retry policy against safety constraints
   * 
   * @param policy - Policy to validate
   * @returns Validated policy
   * @throws RetryPolicyValidationError if policy is invalid
   */
  private validatePolicy(policy: RetryPolicy): RetryPolicy {
    const errors: string[] = [];

    // Validate attempts
    if (typeof policy.attempts !== 'number' || policy.attempts < 0) {
      errors.push('attempts must be a non-negative number');
    } else if (policy.attempts > MAX_RETRY_ATTEMPTS) {
      errors.push(`attempts cannot exceed ${MAX_RETRY_ATTEMPTS} (prevents infinite retries)`);
    }

    // Validate backoff
    if (!policy.backoff) {
      errors.push('backoff configuration is required');
    } else {
      // Validate delay
      if (typeof policy.backoff.delay !== 'number' || policy.backoff.delay < 0) {
        errors.push('backoff.delay must be a non-negative number');
      } else if (policy.backoff.delay > MAX_BACKOFF_DELAY) {
        errors.push(`backoff.delay cannot exceed ${MAX_BACKOFF_DELAY}ms (prevents excessive delays)`);
      }

      // Validate backoff type
      if (!['exponential', 'fixed', 'custom'].includes(policy.backoff.type)) {
        errors.push('backoff.type must be one of: exponential, fixed, custom');
      }

      // Validate multiplier (only for exponential backoff)
      if (policy.backoff.type === 'exponential' && policy.backoff.multiplier !== undefined) {
        if (typeof policy.backoff.multiplier !== 'number' || policy.backoff.multiplier <= 0) {
          errors.push('backoff.multiplier must be a positive number for exponential backoff');
        } else if (policy.backoff.multiplier > 10) {
          errors.push('backoff.multiplier cannot exceed 10 (prevents explosive growth)');
        }
      }

      // Validate jitter
      if (policy.backoff.jitter !== undefined) {
        if (typeof policy.backoff.jitter !== 'number' || policy.backoff.jitter < 0 || policy.backoff.jitter > 1) {
          errors.push('backoff.jitter must be a number between 0 and 1');
        }
      }
    }

    // Validate removeOnComplete
    if (typeof policy.removeOnComplete !== 'number' && typeof policy.removeOnComplete !== 'boolean') {
      errors.push('removeOnComplete must be a number or boolean');
    } else if (typeof policy.removeOnComplete === 'number' && policy.removeOnComplete < 0) {
      errors.push('removeOnComplete cannot be negative');
    }

    // Validate removeOnFail
    if (typeof policy.removeOnFail !== 'number' && typeof policy.removeOnFail !== 'boolean') {
      errors.push('removeOnFail must be a number or boolean');
    } else if (typeof policy.removeOnFail === 'number' && policy.removeOnFail < 0) {
      errors.push('removeOnFail cannot be negative');
    }

    if (errors.length > 0) {
      throw new RetryPolicyValidationError(errors.join('; '));
    }

    return policy;
  }

  /**
   * Get all registered retry policies
   * 
   * @returns Map of job types to their retry policies
   */
  public getAllPolicies(): Map<JobType, RetryPolicy> {
    return new Map(this.policies);
  }

  /**
   * Check if a job type has a custom retry policy
   * 
   * @param jobType - Type of job
   * @returns True if custom policy exists
   */
  public hasCustomPolicy(jobType: JobType): boolean {
    const defaultPolicy = DEFAULT_RETRY_POLICIES[jobType];
    const currentPolicy = this.policies.get(jobType);
    
    if (!defaultPolicy || !currentPolicy) {
      return false;
    }
    
    return JSON.stringify(defaultPolicy) !== JSON.stringify(currentPolicy);
  }

  /**
   * Reset a job type to its default retry policy
   * 
   * @param jobType - Type of job
   */
  public resetToDefault(jobType: JobType): void {
    const defaultPolicy = DEFAULT_RETRY_POLICIES[jobType];
    if (defaultPolicy) {
      this.policies.set(jobType, this.validatePolicy(defaultPolicy));
    }
  }

  /**
   * Get statistics about retry policies
   * 
   * @returns Policy statistics
   */
  public getStatistics(): {
    totalPolicies: number;
    customPolicies: number;
    policiesByType: Record<JobType, { attempts: number; backoffType: string; hasCustomPolicy: boolean }>;
  } {
    const policiesByType: Record<JobType, { attempts: number; backoffType: string; hasCustomPolicy: boolean }> = {} as any;
    let customPolicies = 0;

    Object.values(JobType).forEach(jobType => {
      const policy = this.getRetryPolicy(jobType);
      const hasCustom = this.hasCustomPolicy(jobType);
      
      policiesByType[jobType] = {
        attempts: policy.attempts,
        backoffType: policy.backoff.type,
        hasCustomPolicy: hasCustom,
      };
      
      if (hasCustom) {
        customPolicies++;
      }
    });

    return {
      totalPolicies: Object.keys(JobType).length,
      customPolicies,
      policiesByType,
    };
  }
}
