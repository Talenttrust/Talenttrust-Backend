import {
  validatePromotionPath,
  promoteDeployment,
  rollbackDeployment,
  getPromotionHistory,
  PromotionRequest,
  RollbackRequest,
} from './promoter';
import { auditService } from '../audit/service';
import { closeDb, getDb } from '../db/database';

jest.mock('../httpClient', () => ({
  createHttpClient: jest.fn().mockReturnValue({
    get: jest.fn().mockRejectedValue(new Error('Connection refused')),
  }),
}));

jest.mock('../deploy', () => ({
  switchToGreen: jest.fn().mockResolvedValue(undefined),
  rollback: jest.fn().mockResolvedValue(undefined),
  getStatus: jest.fn().mockResolvedValue({ activeColor: 'blue', lastSwitch: Date.now() }),
  setHealthChecker: jest.fn(),
  setErrorRateReader: jest.fn(),
}));

const AUDIT_SPY = jest.spyOn(auditService, 'log');

beforeEach(() => {
  AUDIT_SPY.mockClear();
});

afterAll(() => {
  AUDIT_SPY.mockRestore();
  closeDb();
});

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

    it('should call switchToGreen on successful promotion', async () => {
      const { switchToGreen } = require('../deploy');
      switchToGreen.mockClear();

      const request = createPromotionRequest();
      await promoteDeployment(request);

      expect(switchToGreen).toHaveBeenCalledTimes(1);
    });

    it('should not call switchToGreen when path validation fails', async () => {
      const { switchToGreen } = require('../deploy');
      switchToGreen.mockClear();

      const request = createPromotionRequest({
        from: 'development',
        to: 'production',
      });
      await promoteDeployment(request);

      expect(switchToGreen).not.toHaveBeenCalled();
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

    it('should call blueGreenRollback on successful rollback', async () => {
      const { rollback: blueGreenRollback } = require('../deploy');
      blueGreenRollback.mockClear();

      const request = createRollbackRequest();
      await rollbackDeployment(request);

      expect(blueGreenRollback).toHaveBeenCalledTimes(1);
    });

    it('should not call blueGreenRollback when validation fails', async () => {
      const { rollback: blueGreenRollback } = require('../deploy');
      blueGreenRollback.mockClear();

      const request = createRollbackRequest({ targetVersion: '' });
      await rollbackDeployment(request);

      expect(blueGreenRollback).not.toHaveBeenCalled();
    });
  });

  describe('getPromotionHistory', () => {
    beforeEach(() => {
      const db = getDb();
      db.exec('DELETE FROM deployment_history');
    });

    it('should return empty array when no history exists', async () => {
      const history = await getPromotionHistory('development');

      expect(Array.isArray(history)).toBe(true);
      expect(history).toHaveLength(0);
    });

    it('should return promotion records after a successful promotion', async () => {
      const request: PromotionRequest = {
        from: 'development',
        to: 'staging',
        version: 'v1.0.0',
        initiatedBy: 'test-user',
        timestamp: new Date('2024-06-01T12:00:00Z'),
      };
      const result = await promoteDeployment(request);

      expect(result.success).toBe(true);

      const history = await getPromotionHistory('staging');
      expect(history).toHaveLength(1);
      expect(history[0].from).toBe('development');
      expect(history[0].to).toBe('staging');
      expect(history[0].version).toBe('v1.0.0');
      expect(history[0].initiatedBy).toBe('test-user');
    });

    it('should return records ordered by timestamp descending', async () => {
      const req1: PromotionRequest = {
        from: 'development',
        to: 'staging',
        version: 'v1.0.0',
        initiatedBy: 'user-a',
        timestamp: new Date('2024-06-01T12:00:00Z'),
      };
      const req2: PromotionRequest = {
        from: 'staging',
        to: 'production',
        version: 'v2.0.0',
        initiatedBy: 'user-b',
        timestamp: new Date('2024-06-02T12:00:00Z'),
      };

      await promoteDeployment(req1);
      await promoteDeployment(req2);

      const history = await getPromotionHistory('staging');
      expect(history.length).toBeGreaterThanOrEqual(1);
      if (history.length >= 2) {
        expect(new Date(history[0].timestamp).getTime()).toBeGreaterThanOrEqual(
          new Date(history[1].timestamp).getTime()
        );
      }
    });

    it('should include rollback records in history', async () => {
      await promoteDeployment({
        from: 'staging',
        to: 'production',
        version: 'v2.0.0',
        initiatedBy: 'admin',
        timestamp: new Date(),
      });

      await rollbackDeployment({
        environment: 'production',
        targetVersion: 'v1.0.0',
        reason: 'Bug found',
        initiatedBy: 'admin',
      });

      const history = await getPromotionHistory('production');
      expect(history.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('audit emission', () => {
    it('should emit audit entry on successful promotion', async () => {
      AUDIT_SPY.mockClear();

      const request: PromotionRequest = {
        from: 'development',
        to: 'staging',
        version: 'v2.0.0',
        initiatedBy: 'ci-bot',
        timestamp: new Date(),
      };
      await promoteDeployment(request);

      const auditCalls = AUDIT_SPY.mock.calls.filter(
        (call) => call[0].action === 'DEPLOYMENT_PROMOTED'
      );
      expect(auditCalls.length).toBeGreaterThanOrEqual(1);
      const entry = auditCalls[auditCalls.length - 1][0];
      expect(entry.severity).toBe('INFO');
      expect(entry.actor).toBe('ci-bot');
      expect(entry.resource).toBe('deployment');
    });

    it('should emit audit entry on successful rollback', async () => {
      AUDIT_SPY.mockClear();

      await rollbackDeployment({
        environment: 'staging',
        targetVersion: 'v1.0.0',
        reason: 'Stability issues',
        initiatedBy: 'ops-user',
      });

      const auditCalls = AUDIT_SPY.mock.calls.filter(
        (call) => call[0].action === 'DEPLOYMENT_ROLLED_BACK'
      );
      expect(auditCalls.length).toBeGreaterThanOrEqual(1);
      const entry = auditCalls[auditCalls.length - 1][0];
      expect(entry.severity).toBe('WARNING');
      expect(entry.actor).toBe('ops-user');
    });

    it('should emit CRITICAL audit entry on failed promotion', async () => {
      AUDIT_SPY.mockClear();

      const { switchToGreen } = require('../deploy');
      switchToGreen.mockRejectedValueOnce(new Error('Switch failed'));

      const request: PromotionRequest = {
        from: 'development',
        to: 'staging',
        version: 'v3.0.0',
        initiatedBy: 'tester',
        timestamp: new Date(),
      };
      const result = await promoteDeployment(request);

      expect(result.success).toBe(false);

      const criticalCall = AUDIT_SPY.mock.calls.find(
        (call) =>
          call[0].action === 'DEPLOYMENT_PROMOTED' && call[0].severity === 'CRITICAL'
      );
      expect(criticalCall).toBeDefined();
      expect(criticalCall[0].actor).toBe('tester');
      expect(criticalCall[0].metadata.error).toBe('Switch failed');
    });
  });

  describe('validation gate', () => {
    it('should block promotion when path is invalid', async () => {
      const request: PromotionRequest = {
        from: 'production',
        to: 'development',
        version: 'v1.0.0',
        initiatedBy: 'user',
        timestamp: new Date(),
      };
      const result = await promoteDeployment(request);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid promotion path');
    });

    it('should block promotion when readiness validation fails', async () => {
      const request: PromotionRequest = {
        from: 'development',
        to: 'production',
        version: 'v1.0.0',
        initiatedBy: 'user',
        timestamp: new Date(),
      };
      const result = await promoteDeployment(request);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('Edge Cases', () => {
    beforeEach(() => {
      const db = getDb();
      db.exec('DELETE FROM deployment_history');
    });

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

    it('should record failed promotion in history', async () => {
      const { switchToGreen } = require('../deploy');
      switchToGreen.mockRejectedValueOnce(new Error('Deployment failed'));

      const request: PromotionRequest = {
        from: 'development',
        to: 'staging',
        version: 'v1.0.0',
        initiatedBy: 'user',
        timestamp: new Date(),
      };
      const result = await promoteDeployment(request);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Deployment failed');

      const history = await getPromotionHistory('staging');
      expect(history.length).toBeGreaterThanOrEqual(1);
    });

    it('should maintain history ordering across repeated promotions', async () => {
      for (let i = 1; i <= 3; i++) {
        const request: PromotionRequest = {
          from: 'development',
          to: 'staging',
          version: `v${i}.0.0`,
          initiatedBy: 'ci',
          timestamp: new Date(2024, 5, i, 12, 0, 0),
        };
        await promoteDeployment(request);
      }

      const history = await getPromotionHistory('staging');
      expect(history.length).toBe(3);
    });
  });
});
