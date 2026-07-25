/**
 * Queue Configuration Tests
 * 
 * Tests for queue configuration, fail-fast validation, and Redis connection settings.
 */

import { validateQueueConfig } from './config';

describe('Queue Configuration', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('getRedisConfig', () => {
    it('should return default localhost config', () => {
      delete process.env.REDIS_HOST;
      delete process.env.REDIS_PORT;
      delete process.env.REDIS_PASSWORD;

      const { getRedisConfig } = require('./config');
      const config = getRedisConfig();

      expect(config.host).toBe('localhost');
      expect(config.port).toBe(6379);
      expect(config.password).toBeUndefined();
    });

    it('should use environment variables when provided', () => {
      process.env.REDIS_HOST = 'redis.example.com';
      process.env.REDIS_PORT = '6380';
      process.env.REDIS_PASSWORD = 'secret123';

      const { getRedisConfig } = require('./config');
      const config = getRedisConfig();

      expect(config.host).toBe('redis.example.com');
      expect(config.port).toBe(6380);
      expect(config.password).toBe('secret123');
    });

    it('should parse port as integer', () => {
      process.env.REDIS_PORT = '7000';

      const { getRedisConfig } = require('./config');
      const config = getRedisConfig();

      expect(config.port).toBe(7000);
      expect(typeof config.port).toBe('number');
    });

    it('should throw on invalid port range or type', () => {
      process.env.REDIS_PORT = 'invalid';
      expect(() => require('./config')).toThrow();
    });
  });

  describe('queueConfig', () => {
    it('should have valid default values', () => {
      const { queueConfig } = require('./config');
      expect(queueConfig.concurrency).toBe(5);
      expect(queueConfig.defaultJobOptions.attempts).toBe(3);
      expect(queueConfig.defaultJobOptions.backoff.type).toBe('exponential');
      expect(queueConfig.defaultJobOptions.backoff.delay).toBe(2000);
      expect(queueConfig.defaultJobOptions.removeOnComplete).toBe(100);
      expect(queueConfig.defaultJobOptions.removeOnFail).toBe(1000);
    });

    it('should parse environment variables on module load', () => {
      process.env.QUEUE_CONCURRENCY = '10';
      process.env.QUEUE_DEFAULT_ATTEMPTS = '5';
      process.env.QUEUE_BACKOFF_DELAY = '5000';
      process.env.QUEUE_REMOVE_ON_COMPLETE = '200';
      process.env.QUEUE_REMOVE_ON_FAIL = 'false';

      const { queueConfig } = require('./config');
      expect(queueConfig.concurrency).toBe(10);
      expect(queueConfig.defaultJobOptions.attempts).toBe(5);
      expect(queueConfig.defaultJobOptions.backoff.delay).toBe(5000);
      expect(queueConfig.defaultJobOptions.removeOnComplete).toBe(200);
      expect(queueConfig.defaultJobOptions.removeOnFail).toBe(false);
    });
  });

  describe('validateQueueConfig validator function', () => {
    it('should validate and parse a correct environment configuration', () => {
      const result = validateQueueConfig({
        REDIS_HOST: 'my-redis',
        REDIS_PORT: '1234',
        QUEUE_CONCURRENCY: '12',
        QUEUE_DEFAULT_ATTEMPTS: '2',
        QUEUE_BACKOFF_DELAY: '1000',
        QUEUE_REMOVE_ON_COMPLETE: 'true',
        QUEUE_REMOVE_ON_FAIL: '50',
      });

      expect(result).toEqual({
        REDIS_HOST: 'my-redis',
        REDIS_PORT: 1234,
        REDIS_PASSWORD: undefined,
        QUEUE_CONCURRENCY: 12,
        QUEUE_DEFAULT_ATTEMPTS: 2,
        QUEUE_BACKOFF_DELAY: 1000,
        QUEUE_REMOVE_ON_COMPLETE: true,
        QUEUE_REMOVE_ON_FAIL: 50,
      });
    });

    it('should throw on negative concurrency', () => {
      expect(() => {
        validateQueueConfig({
          QUEUE_CONCURRENCY: '-1',
        });
      }).toThrow(/QUEUE_CONCURRENCY/);
    });

    it('should throw on zero concurrency', () => {
      expect(() => {
        validateQueueConfig({
          QUEUE_CONCURRENCY: '0',
        });
      }).toThrow(/QUEUE_CONCURRENCY/);
    });

    it('should throw on concurrency exceeding upper bound', () => {
      expect(() => {
        validateQueueConfig({
          QUEUE_CONCURRENCY: '101',
        });
      }).toThrow(/QUEUE_CONCURRENCY/);
    });

    it('should throw on negative retry attempts', () => {
      expect(() => {
        validateQueueConfig({
          QUEUE_DEFAULT_ATTEMPTS: '-2',
        });
      }).toThrow(/QUEUE_DEFAULT_ATTEMPTS/);
    });

    it('should throw on attempts exceeding upper bound', () => {
      expect(() => {
        validateQueueConfig({
          QUEUE_DEFAULT_ATTEMPTS: '11',
        });
      }).toThrow(/QUEUE_DEFAULT_ATTEMPTS/);
    });

    it('should throw on negative or zero backoff delay', () => {
      expect(() => {
        validateQueueConfig({
          QUEUE_BACKOFF_DELAY: '0',
        });
      }).toThrow(/QUEUE_BACKOFF_DELAY/);
    });

    it('should throw on backoff delay exceeding upper bound', () => {
      expect(() => {
        validateQueueConfig({
          QUEUE_BACKOFF_DELAY: '60001',
        });
      }).toThrow(/QUEUE_BACKOFF_DELAY/);
    });

    it('should throw on invalid removeOnComplete non-numeric value', () => {
      expect(() => {
        validateQueueConfig({
          QUEUE_REMOVE_ON_COMPLETE: 'invalid_val',
        });
      }).toThrow(/QUEUE_REMOVE_ON_COMPLETE/);
    });

    it('should not leak redis password in error message on validation failure', () => {
      const secretPassword = 'SUPER_SECRET_REDIS_PASSWORD_12345';
      
      try {
        validateQueueConfig({
          REDIS_PASSWORD: secretPassword,
          QUEUE_CONCURRENCY: 'invalid_number',
        });
        fail('Should have thrown an error');
      } catch (error: any) {
        expect(error.message).not.toContain(secretPassword);
        expect(error.message).toContain('QUEUE_CONCURRENCY');
      }
    });
  });
});

