/**
 * Deployment Validator Tests
 * 
 * Comprehensive test suite for deployment validation module
 * covering configuration validation, health checks, and readiness checks.
 */

import {
  validateDeploymentConfig,
  performHealthCheck,
  validateDeploymentReadiness,
} from './validator';
import { EnvironmentConfig } from '../config/environment';

describe('Deployment Validator', () => {
  const createMockConfig = (overrides?: Partial<EnvironmentConfig>): EnvironmentConfig => ({
    environment: 'development',
    port: 3001,
    nodeEnv: 'development',
    apiBaseUrl: 'http://localhost:3001',
    debug: false,
    stellarNetwork: 'testnet',
    maxRequestSize: '10mb',
    corsOrigins: ['http://localhost:3000'],
    ...overrides,
  });

  describe('validateDeploymentConfig', () => {
    it('should validate a correct development configuration', () => {
      const config = createMockConfig();
      const result = validateDeploymentConfig(config);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should validate a correct staging configuration', () => {
      const config = createMockConfig({
        environment: 'staging',
        nodeEnv: 'staging',
        apiBaseUrl: 'https://staging-api.example.com',
        corsOrigins: ['https://staging.example.com'],
      });
      const result = validateDeploymentConfig(config);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should validate a correct production configuration', () => {
      const config = createMockConfig({
        environment: 'production',
        nodeEnv: 'production',
        apiBaseUrl: 'https://api.example.com',
        stellarNetwork: 'mainnet',
        debug: false,
        corsOrigins: ['https://app.example.com'],
      });
      const result = validateDeploymentConfig(config);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject invalid port numbers', () => {
      const config = createMockConfig({ port: 0 });
      const result = validateDeploymentConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Invalid port number: 0');
    });

    it('should reject port numbers above 65535', () => {
      const config = createMockConfig({ port: 70000 });
      const result = validateDeploymentConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Invalid port number: 70000');
    });

    it('should reject invalid API base URL', () => {
      const config = createMockConfig({ apiBaseUrl: 'not-a-url' });
      const result = validateDeploymentConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Invalid API base URL: not-a-url');
    });

    it('should reject empty API base URL', () => {
      const config = createMockConfig({ apiBaseUrl: '' });
      const result = validateDeploymentConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Invalid API base URL: ');
    });

    it('should warn when debug is enabled in production', () => {
      const config = createMockConfig({
        environment: 'production',
        stellarNetwork: 'mainnet',
        debug: true,
        corsOrigins: ['https://app.example.com'],
      });
      const result = validateDeploymentConfig(config);

      expect(result.valid).toBe(true);
      expect(result.warnings).toContain('Debug mode is enabled in production');
    });

    it('should reject production with testnet', () => {
      const config = createMockConfig({
        environment: 'production',
        stellarNetwork: 'testnet',
        corsOrigins: ['https://app.example.com'],
      });
      const result = validateDeploymentConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Production must use Stellar mainnet');
    });

    it('should reject production with wildcard CORS', () => {
      const config = createMockConfig({
        environment: 'production',
        stellarNetwork: 'mainnet',
        corsOrigins: ['*'],
      });
      const result = validateDeploymentConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Production CORS origins must not include wildcards or localhost');
    });

    it('should reject production with localhost CORS', () => {
      const config = createMockConfig({
        environment: 'production',
        stellarNetwork: 'mainnet',
        corsOrigins: ['http://localhost:3000', 'https://app.example.com'],
      });
      const result = validateDeploymentConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Production CORS origins must not include wildcards or localhost');
    });

    it('should warn when staging uses mainnet', () => {
      const config = createMockConfig({
        environment: 'staging',
        stellarNetwork: 'mainnet',
      });
      const result = validateDeploymentConfig(config);

      expect(result.valid).toBe(true);
      expect(result.warnings).toContain('Staging environment using mainnet (consider using testnet)');
    });

    it('should handle multiple validation errors', () => {
      const config = createMockConfig({
        environment: 'production',
        port: -1,
        apiBaseUrl: 'invalid',
        stellarNetwork: 'testnet',
        corsOrigins: ['*'],
      });
      const result = validateDeploymentConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(1);
    });
  });

  describe('performHealthCheck', () => {
    it('should return healthy status for valid service', async () => {
      const result = await performHealthCheck('http://localhost:3001');

      expect(result.service).toBe('talenttrust-backend');
      expect(result.status).toBe('healthy');
      expect(result.timestamp).toBeInstanceOf(Date);
      expect(result.details).toBeDefined();
      expect(result.details?.baseUrl).toBe('http://localhost:3001');
    });

    it('should include response time in details', async () => {
      const result = await performHealthCheck('http://localhost:3001');

      expect(result.details?.responseTime).toBeDefined();
      expect(typeof result.details?.responseTime).toBe('number');
    });

    it('should handle different base URLs', async () => {
      const result = await performHealthCheck('https://api.example.com');

      expect(result.details?.baseUrl).toBe('https://api.example.com');
    });
  });

  describe('validateDeploymentReadiness', () => {
    it('should validate deployment readiness for valid config', async () => {
      const config = createMockConfig();
      const result = await validateDeploymentReadiness(config);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should fail readiness check for invalid config', async () => {
      const config = createMockConfig({
        port: -1,
        apiBaseUrl: 'invalid',
      });
      const result = await validateDeploymentReadiness(config);

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should return early if config validation fails', async () => {
      const config = createMockConfig({
        environment: 'production',
        stellarNetwork: 'testnet',
        corsOrigins: ['https://app.example.com'],
      });
      const result = await validateDeploymentReadiness(config);

      expect(result.valid).toBe(false);
    });
  });

  describe('Edge Cases', () => {
    it('should handle config with all optional fields undefined', () => {
      const config = createMockConfig({
        databaseUrl: undefined,
      });
      const result = validateDeploymentConfig(config);

      expect(result.valid).toBe(true);
    });

    it('should validate port at boundary values', () => {
      const config1 = createMockConfig({ port: 1 });
      const result1 = validateDeploymentConfig(config1);
      expect(result1.valid).toBe(true);

      const config2 = createMockConfig({ port: 65535 });
      const result2 = validateDeploymentConfig(config2);
      expect(result2.valid).toBe(true);
    });

    it('should handle empty CORS origins array', () => {
      const config = createMockConfig({
        environment: 'development',
        corsOrigins: [],
      });
      const result = validateDeploymentConfig(config);

      expect(result.valid).toBe(true);
    });
  });
});
