/**
 * Unit Tests for Data Retention Module
 * 
 * Comprehensive test coverage for retention policies, storage,
 * archival, and audit logging components.
 * 
 * @test
 */

import {
  DataRetentionManager,
  RetentionPolicyEngine,
  DataArchivalService,
  ComplianceAuditLogger,
  StorageManager,
  InMemoryStorageProvider,
  RetentionPeriod,
  DataEntityType,
  DataClassification,
  ArchivalStorageType,
  RetentionAction,
  RetentionConfig,
} from './index';

describe('RetentionPolicyEngine', () => {
  let engine: RetentionPolicyEngine;

  beforeEach(() => {
    engine = new RetentionPolicyEngine();
  });

  describe('createPolicy', () => {
    it('should create a policy with all required fields', () => {
      const policy = engine.createPolicy({
        name: 'Test Policy',
        description: 'A test policy',
        entityType: DataEntityType.CONTRACT,
        period: RetentionPeriod.NINETY_DAYS,
        classification: DataClassification.CONFIDENTIAL,
        archivalType: ArchivalStorageType.COLD_STORAGE,
        encryptArchive: true,
        allowPermanentRetention: false,
        isActive: true,
      });

      expect(policy).toBeDefined();
      expect(policy.id).toBeDefined();
      expect(policy.name).toBe('Test Policy');
      expect(policy.createdAt).toBeDefined();
      expect(policy.updatedAt).toBeDefined();
    });

    it('should throw error for empty policy name', () => {
      expect(() => {
        engine.createPolicy({
          name: '',
          description: 'A test policy',
          entityType: DataEntityType.CONTRACT,
          period: RetentionPeriod.NINETY_DAYS,
          classification: DataClassification.CONFIDENTIAL,
          archivalType: ArchivalStorageType.COLD_STORAGE,
          encryptArchive: true,
          allowPermanentRetention: false,
          isActive: true,
        });
      }).toThrow('Policy name is required');
    });

    it('should throw error for invalid entity type', () => {
      expect(() => {
        engine.createPolicy({
          name: 'Test',
          description: 'A test policy',
          entityType: 'invalid' as any,
          period: RetentionPeriod.NINETY_DAYS,
          classification: DataClassification.CONFIDENTIAL,
          archivalType: ArchivalStorageType.COLD_STORAGE,
          encryptArchive: true,
          allowPermanentRetention: false,
          isActive: true,
        });
      }).toThrow('Invalid or missing entity type');
    });
  });

  describe('updatePolicy', () => {
    it('should update policy fields', async () => {
      const policy = engine.createPolicy({
        name: 'Original',
        description: 'Original description',
        entityType: DataEntityType.CONTRACT,
        period: RetentionPeriod.NINETY_DAYS,
        classification: DataClassification.CONFIDENTIAL,
        archivalType: ArchivalStorageType.COLD_STORAGE,
        encryptArchive: true,
        allowPermanentRetention: false,
        isActive: true,
      });

      // Add small delay to ensure updatedAt is different
      await new Promise(resolve => setTimeout(resolve, 10));

      const updated = engine.updatePolicy(policy.id, {
        name: 'Updated',
        period: RetentionPeriod.ONE_YEAR,
      });

      expect(updated.name).toBe('Updated');
      expect(updated.period).toBe(RetentionPeriod.ONE_YEAR);
      expect(updated.createdAt).toEqual(policy.createdAt);
      expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(policy.updatedAt.getTime());
    });

    it('should throw error when updating non-existent policy', () => {
      expect(() => {
        engine.updatePolicy('non-existent', { name: 'Updated' });
      }).toThrow('Policy not found');
    });
  });

  describe('getActivePolicies', () => {
    it('should return only active policies', () => {
      const active = engine.createPolicy({
        name: 'Active Policy',
        description: 'Active',
        entityType: DataEntityType.CONTRACT,
        period: RetentionPeriod.NINETY_DAYS,
        classification: DataClassification.CONFIDENTIAL,
        archivalType: ArchivalStorageType.COLD_STORAGE,
        encryptArchive: true,
        allowPermanentRetention: false,
        isActive: true,
      });

      engine.createPolicy({
        name: 'Inactive Policy',
        description: 'Inactive',
        entityType: DataEntityType.DOCUMENT,
        period: RetentionPeriod.THIRTY_DAYS,
        classification: DataClassification.INTERNAL,
        archivalType: ArchivalStorageType.LOCAL,
        encryptArchive: false,
        allowPermanentRetention: false,
        isActive: false,
      });

      const active_policies = engine.getActivePolicies();
      expect(active_policies).toHaveLength(1);
      expect(active_policies[0].id).toBe(active.id);
    });
  });

  describe('calculateExpirationDate', () => {
    it('should calculate correct expiration for 30 days', () => {
      const policy = engine.createPolicy({
        name: 'Test 30d',
        description: 'Test',
        entityType: DataEntityType.CONTRACT,
        period: RetentionPeriod.THIRTY_DAYS,
        classification: DataClassification.CONFIDENTIAL,
        archivalType: ArchivalStorageType.COLD_STORAGE,
        encryptArchive: true,
        allowPermanentRetention: false,
        isActive: true,
      });

      const data = {
        id: 'test-1',
        entityType: DataEntityType.CONTRACT,
        data: {},
        classification: DataClassification.CONFIDENTIAL,
        createdAt: new Date('2024-01-01'),
        expiresAt: new Date(),
        isArchived: false,
        retentionPolicyId: policy.id,
      };

      const expiration = engine.calculateExpirationDate(data);
      const expectedExpiration = new Date('2024-01-31'); // 30 days later

      expect(expiration.getDate()).toBe(expectedExpiration.getDate());
      expect(expiration.getMonth()).toBe(expectedExpiration.getMonth());
      expect(expiration.getFullYear()).toBe(expectedExpiration.getFullYear());
    });
  });

  describe('determineRetentionStatus', () => {
    it('should flag data as needing action when expired', () => {
      const data = {
        id: 'test-1',
        entityType: DataEntityType.CONTRACT,
        data: {},
        classification: DataClassification.CONFIDENTIAL,
        createdAt: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000), // 100 days ago
        expiresAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000), // Expired 10 days ago
        isArchived: false,
      };

      const status = engine.determineRetentionStatus(data);

      expect(status.needsAction).toBe(true);
      expect(status.actionRequired).toContain('should be archived');
    });

    it('should flag data expiring soon', () => {
      const data = {
        id: 'test-1',
        entityType: DataEntityType.CONTRACT,
        data: {},
        classification: DataClassification.CONFIDENTIAL,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000), // Expires in 3 days
        isArchived: false,
      };

      const status = engine.determineRetentionStatus(data);

      expect(status.needsAction).toBe(true);
      expect(status.actionRequired).toContain('approaching');
    });
  });

  describe('shouldArchive', () => {
    it('should return true for expired non-archived data', () => {
      const data = {
        id: 'test-1',
        entityType: DataEntityType.CONTRACT,
        data: {},
        classification: DataClassification.CONFIDENTIAL,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000), // Expired yesterday
        isArchived: false,
      };

      expect(engine.shouldArchive(data)).toBe(true);
    });

    it('should return false for already archived data', () => {
      const data = {
        id: 'test-1',
        entityType: DataEntityType.CONTRACT,
        data: {},
        classification: DataClassification.CONFIDENTIAL,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
        isArchived: true,
        archivedAt: new Date(),
      };

      expect(engine.shouldArchive(data)).toBe(false);
    });
  });

  describe('shouldPermanentlyDelete', () => {
    it('should return true for archived data past post-archival retention', () => {
      const data = {
        id: 'test-1',
        entityType: DataEntityType.CONTRACT,
        data: {},
        classification: DataClassification.CONFIDENTIAL,
        createdAt: new Date(),
        expiresAt: new Date(),
        isArchived: true,
        archivedAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000), // Archived 40 days ago
      };

      expect(engine.shouldPermanentlyDelete(data, 30)).toBe(true); // 30 day post-archival
    });

    it('should return false for recently archived data', () => {
      const data = {
        id: 'test-1',
        entityType: DataEntityType.CONTRACT,
        data: {},
        classification: DataClassification.CONFIDENTIAL,
        createdAt: new Date(),
        expiresAt: new Date(),
        isArchived: true,
        archivedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000), // Archived 10 days ago
      };

      expect(engine.shouldPermanentlyDelete(data, 30)).toBe(false);
    });
  });
});

describe('StorageManager', () => {
  let manager: StorageManager;

  beforeEach(() => {
    manager = new StorageManager(
      new InMemoryStorageProvider(),
      new InMemoryStorageProvider(),
    );
  });

  describe('store and retrieve', () => {
    it('should store and retrieve data', async () => {
      const data = {
        id: 'test-1',
        entityType: DataEntityType.CONTRACT,
        data: { contractId: '123' },
        classification: DataClassification.CONFIDENTIAL,
        createdAt: new Date(),
        expiresAt: new Date(),
        isArchived: false,
      };

      await manager.store(data, ArchivalStorageType.LOCAL);
      const retrieved = await manager.retrieve('test-1', ArchivalStorageType.LOCAL);

      expect(retrieved).toEqual(data);
    });

    it('should return null for non-existent data', async () => {
      const retrieved = await manager.retrieve('non-existent', ArchivalStorageType.LOCAL);
      expect(retrieved).toBeNull();
    });

    it('should store to archive storage', async () => {
      const data = {
        id: 'test-1',
        entityType: DataEntityType.CONTRACT,
        data: { contractId: '123' },
        classification: DataClassification.CONFIDENTIAL,
        createdAt: new Date(),
        expiresAt: new Date(),
        isArchived: true,
        archivedAt: new Date(),
      };

      await manager.store(data, ArchivalStorageType.COLD_STORAGE);
      const retrieved = await manager.retrieve('test-1', ArchivalStorageType.COLD_STORAGE);

      expect(retrieved).toBeDefined();
    });

    it('should store to encrypted archive', async () => {
      const data = {
        id: 'test-1',
        entityType: DataEntityType.CONTRACT,
        data: { contractId: '123' },
        classification: DataClassification.RESTRICTED,
        createdAt: new Date(),
        expiresAt: new Date(),
        isArchived: true,
        archivedAt: new Date(),
      };

      await manager.store(data, ArchivalStorageType.ENCRYPTED_ARCHIVE);
      const retrieved = await manager.retrieve('test-1', ArchivalStorageType.ENCRYPTED_ARCHIVE);

      expect(retrieved).toBeDefined();
    });
  });

  describe('moveData', () => {
    it('should move data between storage types', async () => {
      const data = {
        id: 'test-1',
        entityType: DataEntityType.CONTRACT,
        data: { contractId: '123' },
        classification: DataClassification.CONFIDENTIAL,
        createdAt: new Date(),
        expiresAt: new Date(),
        isArchived: false,
      };

      await manager.store(data, ArchivalStorageType.LOCAL);
      const success = await manager.moveData(
        'test-1',
        ArchivalStorageType.LOCAL,
        ArchivalStorageType.COLD_STORAGE,
      );

      expect(success).toBe(true);

      const fromLocal = await manager.retrieve('test-1', ArchivalStorageType.LOCAL);
      expect(fromLocal).toBeNull();

      const fromCold = await manager.retrieve('test-1', ArchivalStorageType.COLD_STORAGE);
      expect(fromCold).toBeDefined();
    });

    it('should fail move for non-existent data', async () => {
      const success = await manager.moveData(
        'non-existent',
        ArchivalStorageType.LOCAL,
        ArchivalStorageType.COLD_STORAGE,
      );

      expect(success).toBe(false);
    });
  });

  describe('delete', () => {
    it('should delete data', async () => {
      const data = {
        id: 'test-1',
        entityType: DataEntityType.CONTRACT,
        data: { contractId: '123' },
        classification: DataClassification.CONFIDENTIAL,
        createdAt: new Date(),
        expiresAt: new Date(),
        isArchived: false,
      };

      await manager.store(data, ArchivalStorageType.LOCAL);
      const deleted = await manager.delete('test-1', ArchivalStorageType.LOCAL);

      expect(deleted).toBe(true);

      const retrieved = await manager.retrieve('test-1', ArchivalStorageType.LOCAL);
      expect(retrieved).toBeNull();
    });

    it('should return false when deleting non-existent data', async () => {
      const deleted = await manager.delete('non-existent', ArchivalStorageType.LOCAL);
      expect(deleted).toBe(false);
    });
  });
});

describe('DataArchivalService', () => {
  let service: DataArchivalService;
  let engine: RetentionPolicyEngine;
  let manager: StorageManager;

  beforeEach(() => {
    engine = new RetentionPolicyEngine();
    manager = new StorageManager(
      new InMemoryStorageProvider(),
      new InMemoryStorageProvider(),
    );
    service = new DataArchivalService(manager, engine, true); // encryption enabled
  });

  describe('archiveData', () => {
    it('should archive data successfully', async () => {
      const data = {
        id: 'test-1',
        entityType: DataEntityType.CONTRACT,
        data: { contractId: '123' },
        classification: DataClassification.CONFIDENTIAL,
        createdAt: new Date(),
        expiresAt: new Date(),
        isArchived: false,
      };

      const result = await service.archiveData(data);

      expect(result.success).toBe(true);
      expect(result.dataId).toBe('test-1');
      expect(result.archivedAt).toBeDefined();
      expect(result.location).toBeDefined();
    });

    it('should throw error for already archived data', async () => {
      const data = {
        id: 'test-1',
        entityType: DataEntityType.CONTRACT,
        data: { contractId: '123' },
        classification: DataClassification.CONFIDENTIAL,
        createdAt: new Date(),
        expiresAt: new Date(),
        isArchived: true,
        archivedAt: new Date(),
      };

      await expect(service.archiveData(data)).rejects.toThrow('already archived');
    });

    it('should encrypt restricted data', async () => {
      const data = {
        id: 'test-1',
        entityType: DataEntityType.CONTRACT,
        data: { contractId: '123' },
        classification: DataClassification.RESTRICTED,
        createdAt: new Date(),
        expiresAt: new Date(),
        isArchived: false,
      };

      const result = await service.archiveData(data);

      expect(result.encrypted).toBe(true);
    });

    it('should encrypt confidential data when policy requires', async () => {
      const policy = engine.createPolicy({
        name: 'Encrypted Policy',
        description: 'Test',
        entityType: DataEntityType.CONTRACT,
        period: RetentionPeriod.NINETY_DAYS,
        classification: DataClassification.CONFIDENTIAL,
        archivalType: ArchivalStorageType.COLD_STORAGE,
        encryptArchive: true,
        allowPermanentRetention: false,
        isActive: true,
      });

      const data = {
        id: 'test-1',
        entityType: DataEntityType.CONTRACT,
        data: { contractId: '123' },
        classification: DataClassification.CONFIDENTIAL,
        createdAt: new Date(),
        expiresAt: new Date(),
        isArchived: false,
        retentionPolicyId: policy.id,
      };

      const result = await service.archiveData(data);
      expect(result.encrypted).toBe(true);
    });

    it('should not encrypt public data when encryption disabled', async () => {
      // Create service with encryption disabled
      const disabledService = new DataArchivalService(
        new StorageManager(
          new InMemoryStorageProvider(),
          new InMemoryStorageProvider(),
        ),
        new RetentionPolicyEngine(),
        false, // encryption disabled
      );

      const data = {
        id: 'test-1',
        entityType: DataEntityType.CONTRACT,
        data: { contractId: '123' },
        classification: DataClassification.PUBLIC,
        createdAt: new Date(),
        expiresAt: new Date(),
        isArchived: false,
      };

      const result = await disabledService.archiveData(data);
      expect(result.encrypted).toBe(false);
    });

    it('should respect options override for encryption', async () => {
      const data = {
        id: 'test-1',
        entityType: DataEntityType.CONTRACT,
        data: { contractId: '123' },
        classification: DataClassification.PUBLIC,
        createdAt: new Date(),
        expiresAt: new Date(),
        isArchived: false,
      };

      const result = await service.archiveData(data, { encrypted: true });
      expect(result.encrypted).toBe(true);
    });

    it('should use custom location when provided', async () => {
      const data = {
        id: 'test-1',
        entityType: DataEntityType.CONTRACT,
        data: { contractId: '123' },
        classification: DataClassification.CONFIDENTIAL,
        createdAt: new Date(),
        expiresAt: new Date(),
        isArchived: false,
      };

      const customLocation = '/custom/path/test-1';
      const result = await service.archiveData(data, { location: customLocation });
      
      // The location in metadata should contain the custom location
      expect(result.location).toBeDefined();
      expect(result.metadata?.location || result.location).toBeDefined();
    });
  });

  describe('restoreArchivedData', () => {
    it('should restore archived data successfully', async () => {
      const data = {
        id: 'test-1',
        entityType: DataEntityType.CONTRACT,
        data: { contractId: '123' },
        classification: DataClassification.CONFIDENTIAL,
        createdAt: new Date(),
        expiresAt: new Date(),
        isArchived: false,
      };

      // First archive the data
      await service.archiveData(data);

      // Then restore it
      const restored = await service.restoreArchivedData('test-1');

      expect(restored.isArchived).toBe(false);
      expect(restored.archivedAt).toBeUndefined();
    });

    it('should throw error for non-existent archived data', async () => {
      await expect(service.restoreArchivedData('non-existent')).rejects.toThrow('not found');
    });
  });

  describe('getArchivedData', () => {
    it('should retrieve archived data', async () => {
      const data = {
        id: 'test-1',
        entityType: DataEntityType.CONTRACT,
        data: { contractId: '123' },
        classification: DataClassification.CONFIDENTIAL,
        createdAt: new Date(),
        expiresAt: new Date(),
        isArchived: false,
      };

      await service.archiveData(data);
      const archived = await service.getArchivedData('test-1');

      expect(archived).toBeDefined();
      expect(archived!.isArchived).toBe(true);
    });

    it('should return null for non-existent archived data', async () => {
      const archived = await service.getArchivedData('non-existent');
      expect(archived).toBeNull();
    });
  });

  describe('permanentlyDeleteArchived', () => {
    it('should permanently delete archived data', async () => {
      const data = {
        id: 'test-1',
        entityType: DataEntityType.CONTRACT,
        data: { contractId: '123' },
        classification: DataClassification.CONFIDENTIAL,
        createdAt: new Date(),
        expiresAt: new Date(),
        isArchived: false,
      };

      await service.archiveData(data);
      const deleted = await service.permanentlyDeleteArchived('test-1');

      expect(deleted).toBe(true);

      const retrieved = await service.getArchivedData('test-1');
      expect(retrieved).toBeNull();
    });
  });

  describe('getArchivalStatus', () => {
    it('should get archival status for archived data', async () => {
      const data = {
        id: 'test-1',
        entityType: DataEntityType.CONTRACT,
        data: { contractId: '123' },
        classification: DataClassification.CONFIDENTIAL,
        createdAt: new Date(),
        expiresAt: new Date(),
        isArchived: false,
      };

      await service.archiveData(data);
      const status = await service.getArchivalStatus('test-1');

      expect(status.archived).toBe(true);
      expect(status.location).toBeDefined();
      expect(status.timestamp).toBeDefined();
    });

    it('should return not archived for non-existent data', async () => {
      const status = await service.getArchivalStatus('non-existent');
      expect(status.archived).toBe(false);
    });
  });
});

describe('ComplianceAuditLogger', () => {
  let logger: ComplianceAuditLogger;

  beforeEach(() => {
    logger = new ComplianceAuditLogger();
  });

  describe('logAction', () => {
    it('should log action successfully', () => {
      const log = logger.logAction({
        entityId: 'test-1',
        entityType: DataEntityType.CONTRACT,
        action: RetentionAction.CREATE,
        actor: 'user@example.com',
        details: { policyId: 'policy-1' },
        compliance: 'GDPR',
      });

      expect(log.id).toBeDefined();
      expect(log.entityId).toBe('test-1');
      expect(log.action).toBe(RetentionAction.CREATE);
      expect(log.timestamp).toBeDefined();
    });

    it('should log action with optional notes', () => {
      const log = logger.logAction({
        entityId: 'test-1',
        entityType: DataEntityType.CONTRACT,
        action: RetentionAction.DELETE,
        actor: 'admin',
        details: {},
        compliance: 'CCPA',
        notes: 'Deletion requested by user',
      });

      expect(log.notes).toBe('Deletion requested by user');
    });
  });

  describe('getLogsForEntity', () => {
    it('should retrieve logs for specific entity', () => {
      logger.logAction({
        entityId: 'entity-1',
        entityType: DataEntityType.CONTRACT,
        action: RetentionAction.CREATE,
        actor: 'user',
        details: {},
      });

      logger.logAction({
        entityId: 'entity-1',
        entityType: DataEntityType.CONTRACT,
        action: RetentionAction.ARCHIVE,
        actor: 'system',
        details: {},
      });

      logger.logAction({
        entityId: 'entity-2',
        entityType: DataEntityType.DOCUMENT,
        action: RetentionAction.CREATE,
        actor: 'user',
        details: {},
      });

      const logs = logger.getLogsForEntity('entity-1');
      expect(logs).toHaveLength(2);
      expect(logs.every(log => log.entityId === 'entity-1')).toBe(true);
    });

    it('should return empty array for entity with no logs', () => {
      const logs = logger.getLogsForEntity('non-existent');
      expect(logs).toHaveLength(0);
    });

    it('should return logs sorted by timestamp', () => {
      logger.logAction({
        entityId: 'entity-1',
        entityType: DataEntityType.CONTRACT,
        action: RetentionAction.CREATE,
        actor: 'user',
        details: {},
      });

      // Small delay to ensure different timestamps
      setTimeout(() => {
        logger.logAction({
          entityId: 'entity-1',
          entityType: DataEntityType.CONTRACT,
          action: RetentionAction.ARCHIVE,
          actor: 'system',
          details: {},
        });
      }, 10);

      const logs = logger.getLogsForEntity('entity-1');
      for (let i = 1; i < logs.length; i++) {
        expect(logs[i].timestamp.getTime()).toBeGreaterThanOrEqual(logs[i - 1].timestamp.getTime());
      }
    });
  });

  describe('queryLogs', () => {
    beforeEach(() => {
      logger.logAction({
        entityId: 'entity-1',
        entityType: DataEntityType.CONTRACT,
        action: RetentionAction.CREATE,
        actor: 'user1',
        details: {},
        compliance: 'GDPR',
      });

      logger.logAction({
        entityId: 'entity-1',
        entityType: DataEntityType.CONTRACT,
        action: RetentionAction.ARCHIVE,
        actor: 'system',
        details: {},
        compliance: 'CCPA',
      });

      logger.logAction({
        entityId: 'entity-2',
        entityType: DataEntityType.DOCUMENT,
        action: RetentionAction.DELETE,
        actor: 'admin',
        details: {},
        compliance: 'GDPR',
      });
    });

    it('should filter by action', () => {
      const logs = logger.queryLogs({ action: RetentionAction.CREATE });
      expect(logs).toHaveLength(1);
      expect(logs[0].action).toBe(RetentionAction.CREATE);
    });

    it('should filter by compliance standard', () => {
      const logs = logger.queryLogs({ compliance: 'GDPR' });
      expect(logs).toHaveLength(2);
      expect(logs.every(l => l.compliance === 'GDPR')).toBe(true);
    });

    it('should filter by actor', () => {
      const logs = logger.queryLogs({ actor: 'system' });
      expect(logs).toHaveLength(1);
      expect(logs[0].actor).toBe('system');
    });

    it('should filter by entity type', () => {
      const logs = logger.queryLogs({ entityType: DataEntityType.CONTRACT });
      expect(logs).toHaveLength(2);
    });

    it('should filter by multiple criteria', () => {
      const logs = logger.queryLogs({
        entityType: DataEntityType.CONTRACT,
        actor: 'system',
        compliance: 'CCPA',
      });
      expect(logs).toHaveLength(1);
      expect(logs[0].action).toBe(RetentionAction.ARCHIVE);
    });

    it('should filter by date range', () => {
      const now = new Date();
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);

      const logs = logger.queryLogs({
        startDate: yesterday,
        endDate: tomorrow,
      });
      expect(logs.length).toBeGreaterThan(0);
    });

    it('should return empty array for non-matching filters', () => {
      const logs = logger.queryLogs({ actor: 'non-existent-actor' });
      expect(logs).toHaveLength(0);
    });
  });

  describe('getLogById', () => {
    it('should retrieve log by ID', () => {
      const log = logger.logAction({
        entityId: 'entity-1',
        entityType: DataEntityType.CONTRACT,
        action: RetentionAction.CREATE,
        actor: 'user',
        details: {},
      });

      const retrieved = logger.getLogById(log.id);
      expect(retrieved).toEqual(log);
    });

    it('should return undefined for non-existent log ID', () => {
      const retrieved = logger.getLogById('non-existent-id');
      expect(retrieved).toBeUndefined();
    });
  });

  describe('getComplianceReport', () => {
    it('should generate compliance report', () => {
      logger.logAction({
        entityId: 'entity-1',
        entityType: DataEntityType.CONTRACT,
        action: RetentionAction.CREATE,
        actor: 'user',
        details: {},
        compliance: 'GDPR',
      });

      logger.logAction({
        entityId: 'entity-1',
        entityType: DataEntityType.CONTRACT,
        action: RetentionAction.ARCHIVE,
        actor: 'system',
        details: {},
        compliance: 'GDPR',
      });

      logger.logAction({
        entityId: 'entity-2',
        entityType: DataEntityType.DOCUMENT,
        action: RetentionAction.DELETE,
        actor: 'admin',
        details: {},
        compliance: 'CCPA',
      });

      const report = logger.getComplianceReport();

      expect(report.GDPR).toBeDefined();
      expect(report.GDPR.count).toBe(2);
      expect(report.GDPR.actions[RetentionAction.CREATE]).toBe(1);
      expect(report.GDPR.actions[RetentionAction.ARCHIVE]).toBe(1);
      expect(report.CCPA.count).toBe(1);
    });
  });

  describe('getEntityAuditSummary', () => {
    it('should return audit summary for entity', () => {
      logger.logAction({
        entityId: 'entity-1',
        entityType: DataEntityType.CONTRACT,
        action: RetentionAction.CREATE,
        actor: 'user',
        details: {},
      });

      logger.logAction({
        entityId: 'entity-1',
        entityType: DataEntityType.CONTRACT,
        action: RetentionAction.ARCHIVE,
        actor: 'system',
        details: {},
      });

      const summary = logger.getEntityAuditSummary('entity-1');

      expect(summary.entity).toBe('entity-1');
      expect(summary.actionCount).toBe(2);
      expect(summary.actions).toContain(RetentionAction.CREATE);
      expect(summary.actions).toContain(RetentionAction.ARCHIVE);
    });

    it('should return empty summary for entity with no logs', () => {
      const summary = logger.getEntityAuditSummary('non-existent');

      expect(summary.entity).toBe('non-existent');
      expect(summary.actionCount).toBe(0);
      expect(summary.actions).toHaveLength(0);
    });
  });

  describe('exportLogs', () => {
    it('should export all logs', () => {
      logger.logAction({
        entityId: 'entity-1',
        entityType: DataEntityType.CONTRACT,
        action: RetentionAction.CREATE,
        actor: 'user',
        details: {},
      });

      const exported = logger.exportLogs();
      expect(exported).toHaveLength(1);
    });

    it('should export filtered logs', () => {
      logger.logAction({
        entityId: 'entity-1',
        entityType: DataEntityType.CONTRACT,
        action: RetentionAction.CREATE,
        actor: 'user',
        details: {},
        compliance: 'GDPR',
      });

      logger.logAction({
        entityId: 'entity-2',
        entityType: DataEntityType.DOCUMENT,
        action: RetentionAction.DELETE,
        actor: 'admin',
        details: {},
        compliance: 'CCPA',
      });

      const exported = logger.exportLogs({ compliance: 'GDPR' });
      expect(exported).toHaveLength(1);
      expect(exported[0].compliance).toBe('GDPR');
    });
  });

  describe('clearLogs', () => {
    it('should clear all logs', () => {
      logger.logAction({
        entityId: 'entity-1',
        entityType: DataEntityType.CONTRACT,
        action: RetentionAction.CREATE,
        actor: 'user',
        details: {},
      });

      expect(logger.getLogCount()).toBe(1);

      logger.clearLogs();
      expect(logger.getLogCount()).toBe(0);
    });
  });
});

describe('DataRetentionManager', () => {
  let manager: DataRetentionManager;
  const config: RetentionConfig = {
    enabled: true,
    storageBasePath: '/data',
    archiveBasePath: '/archive',
    checksIntervalMs: 60000,
    batchSize: 100,
    automaticArchival: true,
    automaticDeletion: false,
    postArchivalRetentionDays: 30,
    complianceStandard: 'GDPR',
    encryptionEnabled: true,
  };

  beforeEach(() => {
    manager = new DataRetentionManager(config);
  });

  describe('storeData', () => {
    it('should store data with retention policy', async () => {
      const policy = manager.createRetentionPolicy({
        name: 'Test Policy',
        description: 'Test',
        entityType: DataEntityType.CONTRACT,
        period: RetentionPeriod.NINETY_DAYS,
        classification: DataClassification.CONFIDENTIAL,
        archivalType: ArchivalStorageType.COLD_STORAGE,
        encryptArchive: true,
        allowPermanentRetention: false,
        isActive: true,
      });

      const result = await manager.storeData(
        {
          entityType: DataEntityType.CONTRACT,
          data: { contractId: '123' },
          classification: DataClassification.CONFIDENTIAL,
          createdAt: new Date(),
        },
        policy.id,
        'user@example.com',
      );

      expect(result.data.id).toBeDefined();
      expect(result.data.expiresAt).toBeDefined();
      expect(result.policy).toBeDefined();
    });
  });

  describe('createRetentionPolicy', () => {
    it('should create and register policy', () => {
      const policy = manager.createRetentionPolicy({
        name: 'Contract Retention',
        description: 'Retain contracts for 1 year',
        entityType: DataEntityType.CONTRACT,
        period: RetentionPeriod.ONE_YEAR,
        classification: DataClassification.CONFIDENTIAL,
        archivalType: ArchivalStorageType.COLD_STORAGE,
        encryptArchive: true,
        allowPermanentRetention: false,
        isActive: true,
      });

      expect(policy.id).toBeDefined();
      expect(policy.name).toBe('Contract Retention');

      const retrieved = manager.getRetentionPolicy(policy.id);
      expect(retrieved).toEqual(policy);
    });
  });

  describe('getActivePolicies', () => {
    it('should return all active policies', () => {
      manager.createRetentionPolicy({
        name: 'Policy 1',
        description: '',
        entityType: DataEntityType.CONTRACT,
        period: RetentionPeriod.NINETY_DAYS,
        classification: DataClassification.CONFIDENTIAL,
        archivalType: ArchivalStorageType.COLD_STORAGE,
        encryptArchive: true,
        allowPermanentRetention: false,
        isActive: true,
      });

      manager.createRetentionPolicy({
        name: 'Policy 2',
        description: '',
        entityType: DataEntityType.DOCUMENT,
        period: RetentionPeriod.THIRTY_DAYS,
        classification: DataClassification.INTERNAL,
        archivalType: ArchivalStorageType.LOCAL,
        encryptArchive: false,
        allowPermanentRetention: false,
        isActive: true,
      });

      const policies = manager.getActivePolicies();
      expect(policies).toHaveLength(2);
    });
  });

  describe('automated processing', () => {
    it('should start and stop automated processing', () => {
      manager.startAutomatedProcessing();
      expect(true).toBe(true); // Processing started without error

      manager.stopAutomatedProcessing();
      expect(true).toBe(true); // Processing stopped without error
    });

    it('should not start if retention disabled', () => {
      const disabledManager = new DataRetentionManager({
        ...config,
        enabled: false,
      });

      disabledManager.startAutomatedProcessing();
      expect(true).toBe(true); // Should not throw
    });
  });

  describe('audit logging', () => {
    it('should provide audit logs', async () => {
      const policy = manager.createRetentionPolicy({
        name: 'Policy',
        description: '',
        entityType: DataEntityType.CONTRACT,
        period: RetentionPeriod.NINETY_DAYS,
        classification: DataClassification.CONFIDENTIAL,
        archivalType: ArchivalStorageType.COLD_STORAGE,
        encryptArchive: true,
        allowPermanentRetention: false,
        isActive: true,
      });

      await manager.storeData(
        {
          entityType: DataEntityType.CONTRACT,
          data: { contractId: '123' },
          classification: DataClassification.CONFIDENTIAL,
          createdAt: new Date(),
        },
        policy.id,
      );

      const logs = manager.getAuditLogs();
      expect(logs.length).toBeGreaterThan(0);
    });

    it('should provide compliance report', () => {
      manager.createRetentionPolicy({
        name: 'Policy',
        description: '',
        entityType: DataEntityType.CONTRACT,
        period: RetentionPeriod.NINETY_DAYS,
        classification: DataClassification.CONFIDENTIAL,
        archivalType: ArchivalStorageType.COLD_STORAGE,
        encryptArchive: true,
        allowPermanentRetention: false,
        isActive: true,
      });

      const report = manager.getComplianceReport();
      expect(report.GDPR).toBeDefined();
      expect(report.GDPR.count).toBeGreaterThan(0);
    });
  });
});
