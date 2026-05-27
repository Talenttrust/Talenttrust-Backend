/**
 * Deployment Integration Tests
 * 
 * End-to-end integration tests for the complete deployment workflow
 * including environment configuration, validation, and promotion.
 */

import { loadEnvironmentConfig, getCurrentEnvironment } from '../config/environment';
import { validateDeploymentConfig, validateDeploymentReadiness } from './validator';
import { promoteDeployment, rollbackDeployment, validatePromotionPath } from './promoter';

describe('Deployment Integration Tests', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('Complete Deployment Workflow', () => {
    it('should complete full development deployment workflow', async () => {
      // Setup environment
      process.env.NODE_ENV = 'development';
      process.env.PORT = '3001';
      process.env.API_BASE_URL = 'http://localhost:3001';

      // Load and validate configuration
      const config = loadEnvironmentConfig();
      expect(config.environment).toBe('development');

      // Validate deployment readiness
      const validation = await validateDeploymentReadiness(config);
      expect(validation.valid).toBe(true);

      // Verify environment checks
      expect(getCurrentEnvironment()).toBe('development');
    });

    it('should complete full staging deployment workflow', async () => {
      // Setup environment
      process.env.NODE_ENV = 'staging';
      process.env.PORT = '3002';
      process.env.API_BASE_URL = 'https://staging-api.example.com';
      process.env.CORS_ORIGINS = 'https://staging.example.com';

      // Load and validate configuration
      const config = loadEnvironmentConfig();
      expect(config.environment).toBe('staging');

      // Validate deployment readiness
      const validation = await validateDeploymentReadiness(config);
      expect(validation.valid).toBe(true);
    });

    it('should complete full production deployment workflow', async () => {
      // Setup environment
      process.env.NODE_ENV = 'production';
      process.env.PORT = '3000';
      process.env.API_BASE_URL = 'https://api.example.com';
      process.env.CORS_ORIGINS = 'https://app.example.com';
      process.env.DEBUG = 'false';

      // Load and validate configuration
      const config = loadEnvironmentConfig();
      expect(config.environment).toBe('production');
      expect(config.stellarNetwork).toBe('mainnet');

      // Validate deployment readiness
      const validation = await validateDeploymentReadiness(config);
      expect(validation.valid).toBe(true);
    });
  });

  describe('Environment Promotion Workflow', () => {
    it('should promote from development to staging', async () => {
      // Validate promotion path
      const pathValidation = validatePromotionPath('development', 'staging');
      expect(pathValidation.valid).toBe(true);

      // Execute promotion
      const promotionResult = await promoteDeployment({
        from: 'development',
        to: 'staging',
        version: 'v1.0.0',
        initiatedBy: 'ci-system',
        timestamp: new Date(),
      });

      expect(promotionResult.success).toBe(true);
      expect(promotionResult.promotionId).toBeDefined();
    });

    it('should promote from staging to production', async () => {
      // Validate promotion path
      const pathValidation = validatePromotionPath('staging', 'production');
      expect(pathValidation.valid).toBe(true);

      // Execute promotion
      const promotionResult = await promoteDeployment({
        from: 'staging',
        to: 'production',
        version: 'v1.0.0',
        initiatedBy: 'ci-system',
        timestamp: new Date(),
      });

      expect(promotionResult.success).toBe(true);
      expect(promotionResult.promotionId).toBeDefined();
    });

    it('should prevent invalid promotion from development to production', async () => {
      // Validate promotion path
      const pathValidation = validatePromotionPath('development', 'production');
      expect(pathValidation.valid).toBe(false);

      // Attempt promotion
      const promotionResult = await promoteDeployment({
        from: 'development',
        to: 'production',
        version: 'v1.0.0',
        initiatedBy: 'ci-system',
        timestamp: new Date(),
      });

      expect(promotionResult.success).toBe(false);
      expect(promotionResult.error).toBeDefined();
    });
  });

  describe('Rollback Workflow', () => {
    it('should rollback staging environment', async () => {
      const rollbackResult = await rollbackDeployment({
        environment: 'staging',
        targetVersion: 'v0.9.0',
        reason: 'Integration test rollback',
        initiatedBy: 'ci-system',
      });

      expect(rollbackResult.success).toBe(true);
      expect(rollbackResult.rollbackId).toBeDefined();
    });

    it('should rollback production environment', async () => {
      const rollbackResult = await rollbackDeployment({
        environment: 'production',
        targetVersion: 'v0.9.0',
        reason: 'Critical bug found',
        initiatedBy: 'ci-system',
      });

      expect(rollbackResult.success).toBe(true);
      expect(rollbackResult.rollbackId).toBeDefined();
    });

    it('should prevent rollback of development environment', async () => {
      const rollbackResult = await rollbackDeployment({
        environment: 'development',
        targetVersion: 'v0.9.0',
        reason: 'Test rollback',
        initiatedBy: 'ci-system',
      });

      expect(rollbackResult.success).toBe(false);
      expect(rollbackResult.error).toContain('not supported for development');
    });
  });

  describe('Configuration Validation Scenarios', () => {
    it('should reject production config with testnet', async () => {
      process.env.NODE_ENV = 'production';
      process.env.API_BASE_URL = 'https://api.example.com';
      process.env.CORS_ORIGINS = 'https://app.example.com';

      const config = loadEnvironmentConfig();
      // Force testnet for testing
      config.stellarNetwork = 'testnet';

      const validation = validateDeploymentConfig(config);
      expect(validation.valid).toBe(false);
      expect(validation.errors).toContain('Production must use Stellar mainnet');
    });

    it('should reject production config with localhost CORS', async () => {
      process.env.NODE_ENV = 'production';
      process.env.API_BASE_URL = 'https://api.example.com';
      process.env.CORS_ORIGINS = 'http://localhost:3000';

      const config = loadEnvironmentConfig();
      const validation = validateDeploymentConfig(config);

      expect(validation.valid).toBe(false);
      expect(validation.errors.some(e => e.includes('CORS'))).toBe(true);
    });

    it('should warn about debug mode in production', async () => {
      process.env.NODE_ENV = 'production';
      process.env.API_BASE_URL = 'https://api.example.com';
      process.env.CORS_ORIGINS = 'https://app.example.com';
      process.env.DEBUG = 'true';

      const config = loadEnvironmentConfig();
      const validation = validateDeploymentConfig(config);

      expect(validation.warnings).toContain('Debug mode is enabled in production');
    });
  });

  describe('Multi-Environment Deployment Scenario', () => {
    it('should handle complete promotion pipeline', async () => {
      // Step 1: Deploy to development
      process.env.NODE_ENV = 'development';
      const devConfig = loadEnvironmentConfig();
      const devValidation = await validateDeploymentReadiness(devConfig);
      expect(devValidation.valid).toBe(true);

      // Step 2: Promote to staging
      const devToStaging = await promoteDeployment({
        from: 'development',
        to: 'staging',
        version: 'v1.0.0',
        initiatedBy: 'ci-system',
        timestamp: new Date(),
      });
      expect(devToStaging.success).toBe(true);

      // Step 3: Validate staging
      process.env.NODE_ENV = 'staging';
      process.env.CORS_ORIGINS = 'https://staging.example.com';
      const stagingConfig = loadEnvironmentConfig();
      const stagingValidation = await validateDeploymentReadiness(stagingConfig);
      expect(stagingValidation.valid).toBe(true);

      // Step 4: Promote to production
      const stagingToProd = await promoteDeployment({
        from: 'staging',
        to: 'production',
        version: 'v1.0.0',
        initiatedBy: 'ci-system',
        timestamp: new Date(),
      });
      expect(stagingToProd.success).toBe(true);

      // Step 5: Validate production
      process.env.NODE_ENV = 'production';
      process.env.CORS_ORIGINS = 'https://app.example.com';
      const prodConfig = loadEnvironmentConfig();
      const prodValidation = await validateDeploymentReadiness(prodConfig);
      expect(prodValidation.valid).toBe(true);
    });
  });

  describe('Error Recovery Scenarios', () => {
    it('should handle failed deployment and rollback', async () => {
      // Simulate failed production deployment
      process.env.NODE_ENV = 'production';
      process.env.API_BASE_URL = 'invalid-url';
      process.env.CORS_ORIGINS = 'https://app.example.com';

      // Load and validate configuration - should fail fast due to Zod validation
      expect(() => loadEnvironmentConfig()).toThrow();

      // Perform rollback regardless of initial failure
      const rollback = await rollbackDeployment({
        environment: 'production',
        targetVersion: 'v0.9.0',
        reason: 'Failed deployment validation',
        initiatedBy: 'ci-system',
      });

      expect(rollback.success).toBe(true);
    });
  });
});
