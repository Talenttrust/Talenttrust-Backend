/**
 * Queue Configuration Tests
 * 
 * Tests for queue configuration and Redis connection settings.
 */

import { getRedisConfig, queueConfig } from './config';

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

      const config = getRedisConfig();

      expect(config.host).toBe('localhost');
      expect(config.port).toBe(6379);
      expect(config.password).toBeUndefined();
    });

    it('should use environment variables when provided', () => {
      process.env.REDIS_HOST = 'redis.example.com';
      process.env.REDIS_PORT = '6380';
      process.env.REDIS_PASSWORD = 'secret123';

      const config = getRedisConfig();

      expect(config.host).toBe('redis.example.com');
      expect(config.port).toBe(6380);
      expect(config.password).toBe('secret123');
    });

    it('should parse port as integer', () => {
      process.env.REDIS_PORT = '7000';

      const config = getRedisConfig();

      expect(config.port).toBe(7000);
      expect(typeof config.port).toBe('number');
    });

    it('should handle invalid port gracefully', () => {
      process.env.REDIS_PORT = 'invalid';

      const config = getRedisConfig();

      expect(config.port).toBe(NaN);
    });
  });

  describe('queueConfig', () => {
    it('should have valid default job options', () => {
      expect(queueConfig.defaultJobOptions.attempts).toBe(3);
      expect(queueConfig.defaultJobOptions.backoff.type).toBe('exponential');
      expect(queueConfig.defaultJobOptions.backoff.delay).toBe(2000);
    });

    it('should have cleanup settings', () => {
      expect(queueConfig.defaultJobOptions.removeOnComplete).toBe(100);
      expect(queueConfig.defaultJobOptions.removeOnFail).toBe(1000);
    });

    it('should have redis configuration', () => {
      expect(queueConfig.redis).toBeDefined();
      expect(queueConfig.redis.host).toBeDefined();
      expect(queueConfig.redis.port).toBeDefined();
    });
  });
});
