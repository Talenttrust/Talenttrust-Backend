/**
 * Environment Promotion Tests
 * 
 * Comprehensive test suite for environment promotion module
 * covering promotion paths, rollbacks, and audit logging.
 */

import {
  validatePromotionPath,
  promoteDeployment,
  rollbackDeployment,
  getPromotionHistory,
  PromotionRequest,
  RollbackRequest,
} from './promoter';

describe('Environment Promoter', () => {
  describe('validatePromotionPath', () => {
    it('should allow promotion from development to staging', () => {
      const result = validatePromotionPath('development', 'staging');

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should allow promotion from staging to production', () => {
      const result = validatePromotionPath('staging', 'production');

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject promotion from development to production', () => {
      const result = validatePromotionPath('development', 'production');

      expect(result.valid).toBe(false);
      expect(result.errors).toContain(
        'Invalid promotion path: development -> production. Valid paths from development: staging'
      );
    });

    it('should reject promotion from production to any environment', () => {
      const result = validatePromotionPath('production', 'staging');

      expect(result.valid).toBe(false);
      expect(result.errors).toContain(
        'Invalid promotion path: production -> staging. Valid paths from production: none'
      );
    });

    it('should reject promotion from staging to development', () => {
      const result = validatePromotionPath('staging', 'development');

      expect(result.valid).toBe(false);
      expect(result.errors).toContain(
        'Invalid promotion path: staging -> development. Valid paths from staging: production'
      );
    });

    it('should reject promotion within same environment', () => {
      const result = validatePromotionPath('staging', 'staging');

      expect(result.valid).toBe(false);
    });
  });

  describe('promoteDeployment', () => {
    const createPromotionRequest = (
      overrides?: Partial<PromotionRequest>
    ): PromotionRequest => ({
      from: 'development',
      to: 'staging',
      version: 'v1.0.0',
      initiatedBy: 'test-user',
      timestamp: new Date(),
      ...overrides,
    });

    it('should successfully promote from development to staging', async () => {
      const request = createPromotionRequest();
      const result = await promoteDeployment(request);

      expect(result.success).toBe(true);
      expect(result.request).toEqual(request);
      expect(result.validation.valid).toBe(true);
      expect(result.promotionId).toMatch(/^promo-/);
    });

    it('should successfully promote from staging to production', async () => {
      const request = createPromotionRequest({
        from: 'staging',
        to: 'production',
      });
      const result = await promoteDeployment(request);

      expect(result.success).toBe(true);
      expect(result.validation.valid).toBe(true);
    });

    it('should fail promotion with invalid path', async () => {
      const request = createPromotionRequest({
        from: 'development',
        to: 'production',
      });
      const result = await promoteDeployment(request);

      expect(result.success).toBe(false);
      expect(result.validation.valid).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should generate unique promotion IDs', async () => {
      const request1 = createPromotionRequest();
      const request2 = createPromotionRequest();

      const result1 = await promoteDeployment(request1);
      const result2 = await promoteDeployment(request2);

      expect(result1.promotionId).not.toBe(result2.promotionId);
    });

    it('should include validation warnings in result', async () => {
      const request = createPromotionRequest();
      const result = await promoteDeployment(request);

      expect(result.validation.warnings).toBeDefined();
    });

    it('should handle different version formats', async () => {
      const versions = ['v1.0.0', '1.0.0', 'release-2024-01', 'abc123'];

      for (const version of versions) {
        const request = createPromotionRequest({ version });
        const result = await promoteDeployment(request);

        expect(result.success).toBe(true);
        expect(result.request.version).toBe(version);
      }
    });

    it('should preserve initiatedBy information', async () => {
      const request = createPromotionRequest({
        initiatedBy: 'john.doe@example.com',
      });
      const result = await promoteDeployment(request);

      expect(result.request.initiatedBy).toBe('john.doe@example.com');
    });

    it('should preserve timestamp information', async () => {
      const timestamp = new Date('2024-01-15T10:00:00Z');
      const request = createPromotionRequest({ timestamp });
      const result = await promoteDeployment(request);

      expect(result.request.timestamp).toEqual(timestamp);
    });
  });

  describe('rollbackDeployment', () => {
    const createRollbackRequest = (
      overrides?: Partial<RollbackRequest>
    ): RollbackRequest => ({
      environment: 'staging',
      targetVersion: 'v0.9.0',
      reason: 'Critical bug found',
      initiatedBy: 'test-user',
      ...overrides,
    });

    it('should successfully rollback staging environment', async () => {
      const request = createRollbackRequest();
      const result = await rollbackDeployment(request);

      expect(result.success).toBe(true);
      expect(result.request).toEqual(request);
      expect(result.rollbackId).toMatch(/^rollback-/);
    });

    it('should successfully rollback production environment', async () => {
      const request = createRollbackRequest({
        environment: 'production',
      });
      const result = await rollbackDeployment(request);

      expect(result.success).toBe(true);
    });

    it('should reject rollback without target version', async () => {
      const request = createRollbackRequest({
        targetVersion: '',
      });
      const result = await rollbackDeployment(request);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Target version is required for rollback');
    });

    it('should reject rollback for development environment', async () => {
      const request = createRollbackRequest({
        environment: 'development',
      });
      const result = await rollbackDeployment(request);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Rollback not supported for development environment');
    });

    it('should generate unique rollback IDs', async () => {
      const request1 = createRollbackRequest();
      const request2 = createRollbackRequest();

      const result1 = await rollbackDeployment(request1);
      const result2 = await rollbackDeployment(request2);

      expect(result1.rollbackId).not.toBe(result2.rollbackId);
    });

    it('should preserve rollback reason', async () => {
      const request = createRollbackRequest({
        reason: 'Performance degradation detected',
      });
      const result = await rollbackDeployment(request);

      expect(result.request.reason).toBe('Performance degradation detected');
    });

    it('should handle different version formats for rollback', async () => {
      const versions = ['v1.0.0', '1.0.0', 'release-2024-01', 'abc123'];

      for (const version of versions) {
        const request = createRollbackRequest({ targetVersion: version });
        const result = await rollbackDeployment(request);

        expect(result.success).toBe(true);
        expect(result.request.targetVersion).toBe(version);
      }
    });
  });

  describe('getPromotionHistory', () => {
    it('should return empty array for development environment', async () => {
      const history = await getPromotionHistory('development');

      expect(Array.isArray(history)).toBe(true);
      expect(history).toHaveLength(0);
    });

    it('should return empty array for staging environment', async () => {
      const history = await getPromotionHistory('staging');

      expect(Array.isArray(history)).toBe(true);
      expect(history).toHaveLength(0);
    });

    it('should return empty array for production environment', async () => {
      const history = await getPromotionHistory('production');

      expect(Array.isArray(history)).toBe(true);
      expect(history).toHaveLength(0);
    });
  });

  describe('Edge Cases', () => {
    it('should handle promotion with empty version string', async () => {
      const request: PromotionRequest = {
        from: 'development',
        to: 'staging',
        version: '',
        initiatedBy: 'test-user',
        timestamp: new Date(),
      };
      const result = await promoteDeployment(request);

      expect(result.success).toBe(true);
    });

    it('should handle rollback with special characters in reason', async () => {
      const request: RollbackRequest = {
        environment: 'staging',
        targetVersion: 'v1.0.0',
        reason: 'Bug #123: Critical error in payment processing (50% failure rate)',
        initiatedBy: 'test-user',
      };
      const result = await rollbackDeployment(request);

      expect(result.success).toBe(true);
    });

    it('should handle promotion with email as initiatedBy', async () => {
      const request: PromotionRequest = {
        from: 'development',
        to: 'staging',
        version: 'v1.0.0',
        initiatedBy: 'user@example.com',
        timestamp: new Date(),
      };
      const result = await promoteDeployment(request);

      expect(result.success).toBe(true);
    });
  });
});
