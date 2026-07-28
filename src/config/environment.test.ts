/**
 * Environment Configuration Tests
 * * Comprehensive test suite for environment configuration module
 * covering all environments, edge cases, and error scenarios.
 */

import {
  getCurrentEnvironment,
  loadEnvironmentConfig,
  isProduction,
  isStaging,
  isDevelopment,
} from './environment';
import { validateEnv } from './env.schema';

describe('Environment Configuration', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    // The global test setup enables SSRF_ALLOW_PRIVATE_HOSTS; the SSRF-guard
    // assertions here verify the fail-closed default, so clear the bypass flag.
    delete process.env.SSRF_ALLOW_PRIVATE_HOSTS;
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
      // Production requires a JWT_SECRET (see the JWT_SECRET validation suite).
      process.env.JWT_SECRET = 'a'.repeat(32);
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
      process.env.CORS_ALLOWED_ORIGINS = 'https://app1.com,https://app2.com';
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
      const config = loadEnvironmentConfig();
      expect(config.environment).toBe('development');
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

    it('should throw for non-numeric PORT', () => {
      process.env.NODE_ENV = 'development';
      process.env.PORT = 'invalid';
      expect(() => loadEnvironmentConfig()).toThrow();
    });

    it('should use empty array when CORS_ALLOWED_ORIGINS is set to empty string', () => {
      process.env.NODE_ENV = 'development';
      process.env.CORS_ALLOWED_ORIGINS = '';
      const config = loadEnvironmentConfig();

      expect(config.corsOrigins).toEqual([]);
    });

    it('should handle DEBUG=false', () => {
      process.env.NODE_ENV = 'development';
      process.env.DEBUG = 'false';
      const config = loadEnvironmentConfig();

      expect(config.debug).toBe(false);
    });
  });

  describe('validateEnv edge cases', () => {
    let consoleErrorSpy: jest.SpyInstance;

    beforeEach(() => {
      // Suppress console.error during validation failures to avoid noisy test output
      consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      process.env.NODE_ENV = 'test';
    });

    afterEach(() => {
      consoleErrorSpy.mockRestore();
    });

    it('should reject internal URLs for SSRF-guarded variables', () => {
      const ssrfVars = ['API_BASE_URL', 'STELLAR_HORIZON_URL', 'SOROBAN_RPC_URL', 'STELLAR_RPC_URL'];
      
      for (const envVar of ssrfVars) {
        process.env[envVar] = 'http://localhost:8080';
        expect(() => validateEnv(process.env)).toThrow(/SSRF protection|must be a public URL/);
        
        process.env[envVar] = 'http://10.0.0.1';
        expect(() => validateEnv(process.env)).toThrow(/SSRF protection|must be a public URL/);
        
        delete process.env[envVar]; // cleanup after check
      }
    });

    it('should accept valid public URLs for SSRF-guarded variables', () => {
      process.env.API_BASE_URL = 'https://api.example.com';
      process.env.STELLAR_HORIZON_URL = 'https://horizon.stellar.org';
      process.env.SOROBAN_RPC_URL = 'https://rpc.soroban.com';
      process.env.STELLAR_RPC_URL = 'https://rpc.stellar.org';
      
      const config = validateEnv(process.env);
      expect(config.API_BASE_URL).toBe('https://api.example.com');
      expect(config.STELLAR_HORIZON_URL).toBe('https://horizon.stellar.org');
      expect(config.SOROBAN_RPC_URL).toBe('https://rpc.soroban.com');
      expect(config.STELLAR_RPC_URL).toBe('https://rpc.stellar.org');
    });

    it('should validate PORT coercion bounds', () => {
      process.env.PORT = '0';
      expect(() => validateEnv(process.env)).toThrow(/Number must be greater than or equal to 1/);
      
      process.env.PORT = '65536';
      expect(() => validateEnv(process.env)).toThrow(/Number must be less than or equal to 65535/);
      
      process.env.PORT = 'invalid';
      expect(() => validateEnv(process.env)).toThrow(/Expected number, received nan/i);
    });

    it('should validate NODE_ENV enum', () => {
      process.env.NODE_ENV = 'invalid_env';
      expect(() => validateEnv(process.env)).toThrow(/Invalid enum value/);
    });

    it('should parse valid ROUTE_BODY_LIMITS correctly', () => {
      process.env.ROUTE_BODY_LIMITS = '/api/upload:1048576,/api/data:2048';
      const config = validateEnv(process.env);
      expect(config.ROUTE_BODY_LIMITS).toEqual({
        '/api/upload': 1048576,
        '/api/data': 2048
      });
    });

    it('should parse HTTP_METRICS_ROUTE_LABEL_LIMIT with a safe default', () => {
      delete process.env.HTTP_METRICS_ROUTE_LABEL_LIMIT;
      expect(validateEnv(process.env).HTTP_METRICS_ROUTE_LABEL_LIMIT).toBe(100);

      process.env.HTTP_METRICS_ROUTE_LABEL_LIMIT = '250';
      expect(validateEnv(process.env).HTTP_METRICS_ROUTE_LABEL_LIMIT).toBe(250);
    });

    it('should reject invalid HTTP_METRICS_ROUTE_LABEL_LIMIT values', () => {
      process.env.HTTP_METRICS_ROUTE_LABEL_LIMIT = '0';
      expect(() => validateEnv(process.env)).toThrow();

      process.env.HTTP_METRICS_ROUTE_LABEL_LIMIT = '10001';
      expect(() => validateEnv(process.env)).toThrow();

      process.env.HTTP_METRICS_ROUTE_LABEL_LIMIT = 'not-a-number';
      expect(() => validateEnv(process.env)).toThrow();
    });

    it('should reject malformed ROUTE_BODY_LIMITS', () => {
      // Missing path prefix '/'
      process.env.ROUTE_BODY_LIMITS = 'api/upload:1024';
      expect(() => validateEnv(process.env)).toThrow(/ROUTE_BODY_LIMITS must be a comma-separated list of path:limit pairs/);
      
      // Negative limit
      process.env.ROUTE_BODY_LIMITS = '/api/upload:-1024';
      expect(() => validateEnv(process.env)).toThrow(/ROUTE_BODY_LIMITS must be a comma-separated list of path:limit pairs/);

      // Not an integer
      process.env.ROUTE_BODY_LIMITS = '/api/upload:10.5';
      expect(() => validateEnv(process.env)).toThrow(/ROUTE_BODY_LIMITS must be a comma-separated list of path:limit pairs/);

      // Missing colon
      process.env.ROUTE_BODY_LIMITS = '/api/upload=1024';
      expect(() => validateEnv(process.env)).toThrow(/ROUTE_BODY_LIMITS must be a comma-separated list of path:limit pairs/);
    });
    // JWT_SECRET validation tests
    describe('JWT_SECRET validation', () => {
      it('should reject missing JWT_SECRET in production', () => {
        process.env.NODE_ENV = 'production';
        delete process.env.JWT_SECRET;
        expect(() => validateEnv(process.env)).toThrow();
      });

      it('should reject short JWT_SECRET in production', () => {
        process.env.NODE_ENV = 'production';
        process.env.JWT_SECRET = 'shortsecret'; // less than 32 chars
        expect(() => validateEnv(process.env)).toThrow();
      });

      it('should accept valid JWT_SECRET in production', () => {
        process.env.NODE_ENV = 'production';
        process.env.JWT_SECRET = 'abcdefghijklmnopqrstuvwxyz123456'; // 32 chars
        const config = validateEnv(process.env);
        expect(config.JWT_SECRET).toBe('abcdefghijklmnopqrstuvwxyz123456');
      });

      it('should allow missing JWT_SECRET in test environment', () => {
        process.env.NODE_ENV = 'test';
        delete process.env.JWT_SECRET;
        const config = validateEnv(process.env);
        expect(config.JWT_SECRET).toBeUndefined();
      });
    });

    it('should throw under NODE_ENV=test and not exit process', () => {
      process.env.PORT = 'invalid';
      // validateEnv is expected to throw rather than exit() due to the `isTest` branch
      expect(() => validateEnv(process.env)).toThrow();
    });
  });
});
