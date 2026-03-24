/**
 * Environment Configuration Tests
 * Test suite for environment variable loading and validation
 */

import { loadEnvironmentConfig } from './environment';

describe('Environment Configuration', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('loadEnvironmentConfig', () => {
    it('should load default configuration when no env vars set', () => {
      delete process.env.PORT;
      delete process.env.NODE_ENV;
      delete process.env.API_VERSION;
      delete process.env.DEPRECATION_WARNING_DAYS;

      const config = loadEnvironmentConfig();

      expect(config.port).toBe(3001);
      expect(config.nodeEnv).toBe('development');
      expect(config.apiVersion).toBe('v1');
      expect(config.deprecationWarningDays).toBe(90);
    });

    it('should load custom PORT from environment', () => {
      process.env.PORT = '8080';

      const config = loadEnvironmentConfig();

      expect(config.port).toBe(8080);
    });

    it('should load custom NODE_ENV from environment', () => {
      process.env.NODE_ENV = 'production';

      const config = loadEnvironmentConfig();

      expect(config.nodeEnv).toBe('production');
    });

    it('should load custom API_VERSION from environment', () => {
      process.env.API_VERSION = 'v2';

      const config = loadEnvironmentConfig();

      expect(config.apiVersion).toBe('v2');
    });

    it('should load custom DEPRECATION_WARNING_DAYS from environment', () => {
      process.env.DEPRECATION_WARNING_DAYS = '180';

      const config = loadEnvironmentConfig();

      expect(config.deprecationWarningDays).toBe(180);
    });

    it('should handle invalid PORT gracefully', () => {
      process.env.PORT = 'invalid';

      const config = loadEnvironmentConfig();

      expect(config.port).toBeNaN();
    });

    it('should handle all custom environment variables together', () => {
      process.env.PORT = '5000';
      process.env.NODE_ENV = 'staging';
      process.env.API_VERSION = 'v2';
      process.env.DEPRECATION_WARNING_DAYS = '60';

      const config = loadEnvironmentConfig();

      expect(config.port).toBe(5000);
      expect(config.nodeEnv).toBe('staging');
      expect(config.apiVersion).toBe('v2');
      expect(config.deprecationWarningDays).toBe(60);
    });
  });
});
