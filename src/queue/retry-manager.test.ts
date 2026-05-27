/**
 * Retry Policy Manager Tests
 * 
 * Comprehensive tests for retry policy management, validation,
 * and per-job-type overrides.
 */

import { RetryPolicyManager, RetryPolicyValidationError } from './retry-manager';
import { JobType } from './types';
import { DEFAULT_RETRY_POLICIES, MAX_RETRY_ATTEMPTS, MAX_BACKOFF_DELAY } from './retry-policy';

// Mock environment variables
const originalEnv = process.env;

describe('RetryPolicyManager', () => {
  let retryManager: RetryPolicyManager;

  beforeEach(() => {
    // Reset environment variables
    process.env = { ...originalEnv };
    // Reset singleton instance
    (RetryPolicyManager as any).instance = undefined;
    retryManager = RetryPolicyManager.getInstance();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('Singleton Pattern', () => {
    it('should return the same instance', () => {
      const instance1 = RetryPolicyManager.getInstance();
      const instance2 = RetryPolicyManager.getInstance();
      expect(instance1).toBe(instance2);
    });
  });

  describe('Default Policies', () => {
    it('should load default retry policies for all job types', () => {
      Object.values(JobType).forEach(jobType => {
        const policy = retryManager.getRetryPolicy(jobType);
        expect(policy).toBeDefined();
        expect(policy.attempts).toBeGreaterThan(0);
        expect(policy.backoff).toBeDefined();
        expect(policy.backoff.delay).toBeGreaterThan(0);
      });
    });

    it('should have appropriate default policies for different job types', () => {
      const emailPolicy = retryManager.getRetryPolicy(JobType.EMAIL_NOTIFICATION);
      expect(emailPolicy.attempts).toBe(5);
      expect(emailPolicy.backoff.type).toBe('exponential');
      expect(emailPolicy.backoff.delay).toBe(1000);
      expect(emailPolicy.backoff.multiplier).toBe(2);
      expect(emailPolicy.backoff.jitter).toBe(0.1);

      const contractPolicy = retryManager.getRetryPolicy(JobType.CONTRACT_PROCESSING);
      expect(contractPolicy.attempts).toBe(3);
      expect(contractPolicy.backoff.type).toBe('exponential');
      expect(contractPolicy.backoff.delay).toBe(2000);

      const reputationPolicy = retryManager.getRetryPolicy(JobType.REPUTATION_UPDATE);
      expect(reputationPolicy.attempts).toBe(2);
      expect(reputationPolicy.backoff.type).toBe('fixed');

      const blockchainPolicy = retryManager.getRetryPolicy(JobType.BLOCKCHAIN_SYNC);
      expect(blockchainPolicy.attempts).toBe(8);
      expect(blockchainPolicy.backoff.type).toBe('exponential');
    });
  });

  describe('Job Options Generation', () => {
    it('should generate BullMQ-compatible job options', () => {
      const jobOptions = retryManager.getJobOptions(JobType.EMAIL_NOTIFICATION);
      
      expect(jobOptions).toHaveProperty('attempts');
      expect(jobOptions).toHaveProperty('backoff');
      expect(jobOptions).toHaveProperty('removeOnComplete');
      expect(jobOptions).toHaveProperty('removeOnFail');
      
      expect(jobOptions.backoff).toHaveProperty('type');
      expect(jobOptions.backoff).toHaveProperty('delay');
    });

    it('should include multiplier and jitter when specified', () => {
      const jobOptions = retryManager.getJobOptions(JobType.EMAIL_NOTIFICATION);
      
      expect(jobOptions.backoff).toHaveProperty('multiplier');
      expect(jobOptions.backoff).toHaveProperty('jitter');
    });

    it('should not include multiplier and jitter for fixed backoff', () => {
      const jobOptions = retryManager.getJobOptions(JobType.REPUTATION_UPDATE);
      
      expect(jobOptions.backoff.type).toBe('fixed');
      expect(jobOptions.backoff).not.toHaveProperty('multiplier');
      expect(jobOptions.backoff).not.toHaveProperty('jitter');
    });
  });

  describe('Custom Policy Registration', () => {
    it('should allow registering custom retry policies', () => {
      const customPolicy = {
        attempts: 1,
        backoff: {
          type: 'fixed' as const,
          delay: 500,
        },
        removeOnComplete: true,
        removeOnFail: false,
      };

      retryManager.registerRetryPolicy(JobType.EMAIL_NOTIFICATION, customPolicy);
      
      const retrievedPolicy = retryManager.getRetryPolicy(JobType.EMAIL_NOTIFICATION);
      expect(retrievedPolicy.attempts).toBe(1);
      expect(retrievedPolicy.backoff.type).toBe('fixed');
      expect(retrievedPolicy.backoff.delay).toBe(500);
    });

    it('should allow partial policy updates', () => {
      const originalPolicy = retryManager.getRetryPolicy(JobType.EMAIL_NOTIFICATION);
      
      retryManager.updateRetryPolicy(JobType.EMAIL_NOTIFICATION, {
        attempts: 7,
      });
      
      const updatedPolicy = retryManager.getRetryPolicy(JobType.EMAIL_NOTIFICATION);
      expect(updatedPolicy.attempts).toBe(7);
      // Other properties should remain unchanged
      expect(updatedPolicy.backoff.type).toBe(originalPolicy.backoff.type);
      expect(updatedPolicy.removeOnComplete).toBe(originalPolicy.removeOnComplete);
    });

    it('should allow nested backoff updates', () => {
      retryManager.updateRetryPolicy(JobType.EMAIL_NOTIFICATION, {
        backoff: {
          type: 'exponential',
          delay: 3000,
          multiplier: 3,
        },
      });
      
      const updatedPolicy = retryManager.getRetryPolicy(JobType.EMAIL_NOTIFICATION);
      expect(updatedPolicy.backoff.delay).toBe(3000);
      expect(updatedPolicy.backoff.multiplier).toBe(3);
      // Other backoff properties should remain unchanged
      expect(updatedPolicy.backoff.type).toBe('exponential');
      expect(updatedPolicy.backoff.jitter).toBe(0.1);
    });
  });

  describe('Policy Validation', () => {
    it('should reject invalid attempts', () => {
      expect(() => {
        retryManager.registerRetryPolicy(JobType.EMAIL_NOTIFICATION, {
          attempts: -1,
          backoff: { type: 'fixed', delay: 1000 },
          removeOnComplete: true,
          removeOnFail: false,
        });
      }).toThrow(RetryPolicyValidationError);

      expect(() => {
        retryManager.registerRetryPolicy(JobType.EMAIL_NOTIFICATION, {
          attempts: MAX_RETRY_ATTEMPTS + 1,
          backoff: { type: 'fixed', delay: 1000 },
          removeOnComplete: true,
          removeOnFail: false,
        });
      }).toThrow(RetryPolicyValidationError);
    });

    it('should reject invalid backoff configuration', () => {
      expect(() => {
        retryManager.registerRetryPolicy(JobType.EMAIL_NOTIFICATION, {
          attempts: 3,
          backoff: { type: 'invalid' as any, delay: 1000 },
          removeOnComplete: true,
          removeOnFail: false,
        });
      }).toThrow(RetryPolicyValidationError);

      expect(() => {
        retryManager.registerRetryPolicy(JobType.EMAIL_NOTIFICATION, {
          attempts: 3,
          backoff: { type: 'fixed', delay: -1 },
          removeOnComplete: true,
          removeOnFail: false,
        });
      }).toThrow(RetryPolicyValidationError);

      expect(() => {
        retryManager.registerRetryPolicy(JobType.EMAIL_NOTIFICATION, {
          attempts: 3,
          backoff: { type: 'fixed', delay: MAX_BACKOFF_DELAY + 1 },
          removeOnComplete: true,
          removeOnFail: false,
        });
      }).toThrow(RetryPolicyValidationError);
    });

    it('should reject invalid multiplier for exponential backoff', () => {
      expect(() => {
        retryManager.registerRetryPolicy(JobType.EMAIL_NOTIFICATION, {
          attempts: 3,
          backoff: { type: 'exponential', delay: 1000, multiplier: 0 },
          removeOnComplete: true,
          removeOnFail: false,
        });
      }).toThrow(RetryPolicyValidationError);

      expect(() => {
        retryManager.registerRetryPolicy(JobType.EMAIL_NOTIFICATION, {
          attempts: 3,
          backoff: { type: 'exponential', delay: 1000, multiplier: 11 },
          removeOnComplete: true,
          removeOnFail: false,
        });
      }).toThrow(RetryPolicyValidationError);
    });

    it('should reject invalid jitter values', () => {
      expect(() => {
        retryManager.registerRetryPolicy(JobType.EMAIL_NOTIFICATION, {
          attempts: 3,
          backoff: { type: 'exponential', delay: 1000, jitter: -0.1 },
          removeOnComplete: true,
          removeOnFail: false,
        });
      }).toThrow(RetryPolicyValidationError);

      expect(() => {
        retryManager.registerRetryPolicy(JobType.EMAIL_NOTIFICATION, {
          attempts: 3,
          backoff: { type: 'exponential', delay: 1000, jitter: 1.1 },
          removeOnComplete: true,
          removeOnFail: false,
        });
      }).toThrow(RetryPolicyValidationError);
    });

    it('should reject invalid removeOnComplete and removeOnFail values', () => {
      expect(() => {
        retryManager.registerRetryPolicy(JobType.EMAIL_NOTIFICATION, {
          attempts: 3,
          backoff: { type: 'fixed', delay: 1000 },
          removeOnComplete: -1,
          removeOnFail: false,
        });
      }).toThrow(RetryPolicyValidationError);

      expect(() => {
        retryManager.registerRetryPolicy(JobType.EMAIL_NOTIFICATION, {
          attempts: 3,
          backoff: { type: 'fixed', delay: 1000 },
          removeOnComplete: true,
          removeOnFail: 'invalid' as any,
        });
      }).toThrow(RetryPolicyValidationError);
    });
  });

  describe('Environment Variable Overrides', () => {
    beforeEach(() => {
      // Reset singleton before each environment variable test
      (RetryPolicyManager as any).instance = undefined;
    });

    it('should load retry policy overrides from environment variables', () => {
      process.env.RETRY_POLICY_EMAIL_NOTIFICATION_ATTEMPTS = '7';
      process.env.RETRY_POLICY_EMAIL_NOTIFICATION_DELAY = '1500';
      process.env.RETRY_POLICY_EMAIL_NOTIFICATION_MULTIPLIER = '2.5';
      process.env.RETRY_POLICY_EMAIL_NOTIFICATION_JITTER = '0.2';

      const newRetryManager = RetryPolicyManager.getInstance();

      const policy = newRetryManager.getRetryPolicy(JobType.EMAIL_NOTIFICATION);
      expect(policy.attempts).toBe(7);
      expect(policy.backoff.delay).toBe(1500);
      expect(policy.backoff.multiplier).toBe(2.5);
      expect(policy.backoff.jitter).toBe(0.2);
    });

    it('should cap environment values at safety limits', () => {
      process.env.RETRY_POLICY_EMAIL_NOTIFICATION_ATTEMPTS = '20';
      process.env.RETRY_POLICY_EMAIL_NOTIFICATION_DELAY = '400000';

      const newRetryManager = RetryPolicyManager.getInstance();

      const policy = newRetryManager.getRetryPolicy(JobType.EMAIL_NOTIFICATION);
      expect(policy.attempts).toBe(MAX_RETRY_ATTEMPTS);
      expect(policy.backoff.delay).toBe(MAX_BACKOFF_DELAY);
    });

    it('should ignore invalid environment variable values', () => {
      process.env.RETRY_POLICY_EMAIL_NOTIFICATION_ATTEMPTS = 'invalid';
      process.env.RETRY_POLICY_EMAIL_NOTIFICATION_DELAY = 'invalid';

      const newRetryManager = RetryPolicyManager.getInstance();

      const policy = newRetryManager.getRetryPolicy(JobType.EMAIL_NOTIFICATION);
      // Should fall back to default values
      expect(policy.attempts).toBe(DEFAULT_RETRY_POLICIES[JobType.EMAIL_NOTIFICATION].attempts);
      expect(policy.backoff.delay).toBe(DEFAULT_RETRY_POLICIES[JobType.EMAIL_NOTIFICATION].backoff.delay);
    });
  });

  describe('Policy Management', () => {
    it('should detect custom policies', () => {
      expect(retryManager.hasCustomPolicy(JobType.EMAIL_NOTIFICATION)).toBe(false);
      
      retryManager.updateRetryPolicy(JobType.EMAIL_NOTIFICATION, { attempts: 1 });
      expect(retryManager.hasCustomPolicy(JobType.EMAIL_NOTIFICATION)).toBe(true);
    });

    it('should reset policies to defaults', () => {
      retryManager.updateRetryPolicy(JobType.EMAIL_NOTIFICATION, { attempts: 1 });
      expect(retryManager.getRetryPolicy(JobType.EMAIL_NOTIFICATION).attempts).toBe(1);
      
      retryManager.resetToDefault(JobType.EMAIL_NOTIFICATION);
      expect(retryManager.getRetryPolicy(JobType.EMAIL_NOTIFICATION).attempts).toBe(
        DEFAULT_RETRY_POLICIES[JobType.EMAIL_NOTIFICATION].attempts
      );
    });

    it('should provide policy statistics', () => {
      const stats = retryManager.getStatistics();
      
      expect(stats).toHaveProperty('totalPolicies');
      expect(stats).toHaveProperty('customPolicies');
      expect(stats).toHaveProperty('policiesByType');
      
      expect(stats.totalPolicies).toBe(Object.keys(JobType).length);
      expect(stats.customPolicies).toBe(0);
      
      Object.values(JobType).forEach(jobType => {
        expect(stats.policiesByType[jobType]).toBeDefined();
        expect(stats.policiesByType[jobType]).toHaveProperty('attempts');
        expect(stats.policiesByType[jobType]).toHaveProperty('backoffType');
        expect(stats.policiesByType[jobType]).toHaveProperty('hasCustomPolicy');
      });
    });
  });

  describe('Fallback Behavior', () => {
    it('should use fallback policy for unknown job types', () => {
      // Create a mock unknown job type
      const unknownJobType = 'unknown-job' as JobType;
      const policy = retryManager.getRetryPolicy(unknownJobType);
      
      expect(policy).toBeDefined();
      expect(policy.attempts).toBeGreaterThan(0);
      expect(policy.backoff).toBeDefined();
    });
  });
});
