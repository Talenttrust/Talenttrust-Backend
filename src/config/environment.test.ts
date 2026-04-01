/**
 * Environment Configuration Tests
 * 
 * Comprehensive test suite for environment configuration module
 * covering all environments, edge cases, and error scenarios.
 */

import {
  getCurrentEnvironment,
  loadEnvironmentConfig,
  isProduction,
  isStaging,
  isDevelopment,
  Environment,
} from './environment';

describe('Environment Configuration', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('getCurrentEnvironment', () => {
    it('should return development by default', () => {
      delete process.env.NODE_ENV;
      expect(getCurrentEnvironment()).toBe('development');
    });

    it('should return production when NODE_ENV is production', () => {
      process.env.NODE_ENV = 'production';
      expect(getCurrentEnvironment()).toBe('production');
    });

    it('should return staging when NODE_ENV is staging', () => {
      process.env.NODE_ENV = 'staging';
      expect(getCurrentEnvironment()).toBe('staging');
    });

    it('should return development when NODE_ENV is development', () => {
      process.env.NODE_ENV = 'development';
      expect(getCurrentEnvironment()).toBe('development');
    });

    it('should return development for invalid NODE_ENV values', () => {
      process.env.NODE_ENV = 'invalid';
      expect(getCurrentEnvironment()).toBe('development');
    });
  });

  describe('loadEnvironmentConfig', () => {
    it('should load default development configuration', () => {
      process.env.NODE_ENV = 'development';
      const config = loadEnvironmentConfig();

      expect(config.environment).toBe('development');
      expect(config.port).toBe(3001);
      expect(config.debug).toBe(false);
      expect(config.stellarNetwork).toBe('testnet');
      expect(config.corsOrigins).toEqual(['http://localhost:3000']);
    });

    it('should load production configuration', () => {
      process.env.NODE_ENV = 'production';
      const config = loadEnvironmentConfig();

      expect(config.environment).toBe('production');
      expect(config.stellarNetwork).toBe('mainnet');
    });

    it('should load staging configuration', () => {
      process.env.NODE_ENV = 'staging';
      const config = loadEnvironmentConfig();

      expect(config.environment).toBe('staging');
      expect(config.stellarNetwork).toBe('testnet');
    });

    it('should parse custom port from environment', () => {
      process.env.NODE_ENV = 'development';
      process.env.PORT = '8080';
      const config = loadEnvironmentConfig();

      expect(config.port).toBe(8080);
    });

    it('should parse debug flag from environment', () => {
      process.env.NODE_ENV = 'development';
      process.env.DEBUG = 'true';
      const config = loadEnvironmentConfig();

      expect(config.debug).toBe(true);
    });

    it('should parse custom API base URL', () => {
      process.env.NODE_ENV = 'development';
      process.env.API_BASE_URL = 'https://api.example.com';
      const config = loadEnvironmentConfig();

      expect(config.apiBaseUrl).toBe('https://api.example.com');
    });

    it('should parse database URL', () => {
      process.env.NODE_ENV = 'development';
      process.env.DATABASE_URL = 'postgresql://localhost:5432/db';
      const config = loadEnvironmentConfig();

      expect(config.databaseUrl).toBe('postgresql://localhost:5432/db');
    });

    it('should parse CORS origins from comma-separated list', () => {
      process.env.NODE_ENV = 'development';
      process.env.CORS_ORIGINS = 'https://app1.com,https://app2.com';
      const config = loadEnvironmentConfig();

      expect(config.corsOrigins).toEqual(['https://app1.com', 'https://app2.com']);
    });

    it('should parse custom max request size', () => {
      process.env.NODE_ENV = 'development';
      process.env.MAX_REQUEST_SIZE = '50mb';
      const config = loadEnvironmentConfig();

      expect(config.maxRequestSize).toBe('50mb');
    });

    it('should throw error when NODE_ENV is missing', () => {
      delete process.env.NODE_ENV;
      expect(() => loadEnvironmentConfig()).toThrow('Missing required environment variables: NODE_ENV');
    });
  });

  describe('Environment Check Functions', () => {
    it('isProduction should return true for production environment', () => {
      process.env.NODE_ENV = 'production';
      expect(isProduction()).toBe(true);
      expect(isStaging()).toBe(false);
      expect(isDevelopment()).toBe(false);
    });

    it('isStaging should return true for staging environment', () => {
      process.env.NODE_ENV = 'staging';
      expect(isProduction()).toBe(false);
      expect(isStaging()).toBe(true);
      expect(isDevelopment()).toBe(false);
    });

    it('isDevelopment should return true for development environment', () => {
      process.env.NODE_ENV = 'development';
      expect(isProduction()).toBe(false);
      expect(isStaging()).toBe(false);
      expect(isDevelopment()).toBe(true);
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty string PORT gracefully', () => {
      process.env.NODE_ENV = 'development';
      process.env.PORT = '';
      const config = loadEnvironmentConfig();

      expect(config.port).toBe(3001);
    });

    it('should handle non-numeric PORT gracefully', () => {
      process.env.NODE_ENV = 'development';
      process.env.PORT = 'invalid';
      const config = loadEnvironmentConfig();

      expect(config.port).toBeNaN();
    });

    it('should handle empty CORS_ORIGINS', () => {
      process.env.NODE_ENV = 'development';
      process.env.CORS_ORIGINS = '';
      const config = loadEnvironmentConfig();

      expect(config.corsOrigins).toEqual(['']);
    });

    it('should handle DEBUG=false', () => {
      process.env.NODE_ENV = 'development';
      process.env.DEBUG = 'false';
      const config = loadEnvironmentConfig();

      expect(config.debug).toBe(false);
    });
  });
});
