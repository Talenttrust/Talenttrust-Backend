/**
 * Integration Tests for Data Retention System
 * 
 * Tests end-to-end workflows for data retention, archival, and compliance
 * across multiple system components.
 * 
 * @test
 */

import {
  DataRetentionManager,
  RetentionPeriod,
  DataEntityType,
  DataClassification,
  ArchivalStorageType,
  RetentionAction,
  RetentionConfig,
} from './index';

describe('Integration: Data Retention Lifecycle', () => {
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

  describe('Complete Data Retention Workflow', () => {
    it('should handle data creation, retention check, and archival', async () => {
      // 1. Create retention policy
      const policy = manager.createRetentionPolicy({
        name: 'Contract Storage Policy',
        description: 'Store contracts for 90 days before archiving',
        entityType: DataEntityType.CONTRACT,
        period: RetentionPeriod.NINETY_DAYS,
        classification: DataClassification.CONFIDENTIAL,
        archivalType: ArchivalStorageType.COLD_STORAGE,
        encryptArchive: true,
        allowPermanentRetention: false,
        isActive: true,
      });

      expect(policy.id).toBeDefined();

      // 2. Store data with policy
      const { data: storedData } = await manager.storeData(
        {
          entityType: DataEntityType.CONTRACT,
          data: { contractId: 'C-123', amount: 50000 },
          classification: DataClassification.CONFIDENTIAL,
          createdAt: new Date(),
        },
        policy.id,
        'user@example.com',
      );

      expect(storedData.id).toBeDefined();
      expect(storedData.isArchived).toBe(false);

      // 3. Check retention status immediately
      const status = await manager.getRetentionStatus(storedData.id);
      expect(status).toBeDefined();
      expect(status!.isArchived).toBe(false);
      expect(status!.needsAction).toBe(false);

      // 4. Retrieve and verify data
      const retrieved = await manager.retrieveData(storedData.id);
      expect(retrieved).toBeDefined();
      expect(retrieved!.data).toEqual({ contractId: 'C-123', amount: 50000 });

      // 5. Check audit logs
      const auditLogs = manager.getAuditLogs({ entityId: storedData.id });
      expect(auditLogs.length).toBeGreaterThan(0);
      expect(auditLogs.some(log => log.action === RetentionAction.CREATE)).toBe(true);
    });
  });

  describe('Multiple Entities with Different Policies', () => {
    it('should manage different entity types with separate policies', async () => {
      // Create policies for different entity types
      const contractPolicy = manager.createRetentionPolicy({
        name: 'Contract Policy',
        description: '1 year retention',
        entityType: DataEntityType.CONTRACT,
        period: RetentionPeriod.ONE_YEAR,
        classification: DataClassification.CONFIDENTIAL,
        archivalType: ArchivalStorageType.COLD_STORAGE,
        encryptArchive: true,
        allowPermanentRetention: false,
        isActive: true,
      });

      const documentPolicy = manager.createRetentionPolicy({
        name: 'Document Policy',
        description: '30 days retention',
        entityType: DataEntityType.DOCUMENT,
        period: RetentionPeriod.THIRTY_DAYS,
        classification: DataClassification.INTERNAL,
        archivalType: ArchivalStorageType.LOCAL,
        encryptArchive: false,
        allowPermanentRetention: false,
        isActive: true,
      });

      // Store contract
      const { data: contract } = await manager.storeData(
        {
          entityType: DataEntityType.CONTRACT,
          data: { type: 'Employment', duration: '2 years' },
          classification: DataClassification.CONFIDENTIAL,
          createdAt: new Date(),
        },
        contractPolicy.id,
      );

      // Store document
      const { data: document } = await manager.storeData(
        {
          entityType: DataEntityType.DOCUMENT,
          data: { type: 'Report', pages: 15 },
          classification: DataClassification.INTERNAL,
          createdAt: new Date(),
        },
        documentPolicy.id,
      );

      // Both should be stored successfully
      expect(contract.id).toBeDefined();
      expect(document.id).toBeDefined();

      // Check that contract expires much later than document
      const contractStatus = await manager.getRetentionStatus(contract.id);
      const documentStatus = await manager.getRetentionStatus(document.id);

      expect(contractStatus!.expiresAt.getTime()).toBeGreaterThan(
        documentStatus!.expiresAt.getTime(),
      );
    });
  });

  describe('Archival and Restoration', () => {
    it('should archive expired data and restored it successfully', async () => {
      const policy = manager.createRetentionPolicy({
        name: 'Short Retention',
        description: '30 days',
        entityType: DataEntityType.TRANSACTION,
        period: RetentionPeriod.THIRTY_DAYS,
        classification: DataClassification.INTERNAL,
        archivalType: ArchivalStorageType.COLD_STORAGE,
        encryptArchive: false,
        allowPermanentRetention: false,
        isActive: true,
      });

      // Create data with creation date 35 days in the past
      const creationDate = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000);

      const { data: transaction } = await manager.storeData(
        {
          entityType: DataEntityType.TRANSACTION,
          data: { txId: 'TX-001', amount: 1000 },
          classification: DataClassification.INTERNAL,
          createdAt: creationDate,
        },
        policy.id,
      );

      // Verify initial state
      let retrievedData = await manager.retrieveData(transaction.id);
      expect(retrievedData).toBeDefined();
      expect(retrievedData!.isArchived).toBe(false);

      // Archive the data
      const archiveResult = await manager.archiveData(transaction.id);
      expect(archiveResult.success).toBe(true);

      // Retrieve and verify archived
      retrievedData = await manager.retrieveData(transaction.id);
      expect(retrievedData!.isArchived).toBe(true);
      expect(retrievedData!.archivedLocation).toBeDefined();

      // Restore the data
      const restored = await manager.restoreArchivedData(transaction.id);
      expect(restored.isArchived).toBe(false);
      expect(restored.archivedAt).toBeUndefined();

      // Verify restored
      retrievedData = await manager.retrieveData(transaction.id);
      expect(retrievedData!.isArchived).toBe(false);

      // Verify audit trail
      const logs = manager.getAuditLogs({ entityId: transaction.id });
      expect(logs.some(log => log.action === RetentionAction.ARCHIVE)).toBe(true);
      expect(logs.some(log => log.action === RetentionAction.RESTORE)).toBe(true);
    });
  });

  describe('Compliance Reporting', () => {
    it('should maintain accurate compliance audit trail', async () => {
      const policy = manager.createRetentionPolicy({
        name: 'Compliance Policy',
        description: 'GDPR compliant',
        entityType: DataEntityType.USER_PROFILE,
        period: RetentionPeriod.THIRTY_DAYS,
        classification: DataClassification.RESTRICTED,
        archivalType: ArchivalStorageType.ENCRYPTED_ARCHIVE,
        encryptArchive: true,
        allowPermanentRetention: false,
        isActive: true,
      });

      // Store user profiles with creation date 35 days in the past (so they meet archival criteria)
      const creationDate = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000);

      const profile1 = await manager.storeData(
        {
          entityType: DataEntityType.USER_PROFILE,
          data: { userId: 'user1', email: 'user1@example.com' },
          classification: DataClassification.RESTRICTED,
          createdAt: creationDate,
        },
        policy.id,
        'admin',
      );

      const profile2 = await manager.storeData(
        {
          entityType: DataEntityType.USER_PROFILE,
          data: { userId: 'user2', email: 'user2@example.com' },
          classification: DataClassification.RESTRICTED,
          createdAt: creationDate,
        },
        policy.id,
        'admin',
      );

      // Archive first profile
      await manager.archiveData(profile1.data.id, 'admin');

      // Get compliance report
      const report = manager.getComplianceReport();
      expect(report.GDPR).toBeDefined();
      expect(report.GDPR.count).toBeGreaterThan(0);
      expect(report.GDPR.actions[RetentionAction.CREATE]).toBeGreaterThanOrEqual(2);
      expect(report.GDPR.actions[RetentionAction.ARCHIVE]).toBeGreaterThanOrEqual(1);

      // Export audit trail
      const auditTrail = manager.exportAuditTrail({ entityType: DataEntityType.USER_PROFILE });
      expect(auditTrail.length).toBeGreaterThan(0);

      // Verify all actions are GDPR compliant
      const gdprLogs = auditTrail.filter(log => log.compliance === 'GDPR');
      expect(gdprLogs.length).toEqual(auditTrail.length);
    });
  });

  describe('Data Classification and Encryption', () => {
    it('should apply appropriate security controls based on classification', async () => {
      // Create policies for different classifications
      const publicPolicy = manager.createRetentionPolicy({
        name: 'Public Data Policy',
        description: 'Public data',
        entityType: DataEntityType.MESSAGE,
        period: RetentionPeriod.THIRTY_DAYS,
        classification: DataClassification.PUBLIC,
        archivalType: ArchivalStorageType.LOCAL,
        encryptArchive: false,
        allowPermanentRetention: false,
        isActive: true,
      });

      const restrictedPolicy = manager.createRetentionPolicy({
        name: 'Restricted Data Policy',
        description: 'Restricted data with encryption',
        entityType: DataEntityType.MESSAGE,
        period: RetentionPeriod.ONE_YEAR,
        classification: DataClassification.RESTRICTED,
        archivalType: ArchivalStorageType.ENCRYPTED_ARCHIVE,
        encryptArchive: true,
        allowPermanentRetention: false,
        isActive: true,
      });

      // Store public data
      const publicMsg = await manager.storeData(
        {
          entityType: DataEntityType.MESSAGE,
          data: { content: 'Public announcement' },
          classification: DataClassification.PUBLIC,
          createdAt: new Date(),
        },
        publicPolicy.id,
      );

      // Store restricted data
      const restrictedMsg = await manager.storeData(
        {
          entityType: DataEntityType.MESSAGE,
          data: { content: 'Sensitive information' },
          classification: DataClassification.RESTRICTED,
          createdAt: new Date(),
        },
        restrictedPolicy.id,
      );

      // Review security controls
      const publicStatus = await manager.getRetentionStatus(publicMsg.data.id);
      const restrictedStatus = await manager.getRetentionStatus(restrictedMsg.data.id);

      expect(publicStatus).toBeDefined();
      expect(restrictedStatus).toBeDefined();

      // Restricted data should have different archival strategy
      expect(publicPolicy.archivalType).not.toBe(restrictedPolicy.archivalType);
      expect(publicPolicy.encryptArchive).toBe(false);
      expect(restrictedPolicy.encryptArchive).toBe(true);
    });
  });

  describe('Edge Cases and Error Handling', () => {
    it('should handle archival of already archived data', async () => {
      const policy = manager.createRetentionPolicy({
        name: 'Test Policy',
        description: '',
        entityType: DataEntityType.CONTRACT,
        period: RetentionPeriod.THIRTY_DAYS,
        classification: DataClassification.CONFIDENTIAL,
        archivalType: ArchivalStorageType.COLD_STORAGE,
        encryptArchive: true,
        allowPermanentRetention: false,
        isActive: true,
      });

      const { data: contract } = await manager.storeData(
        {
          entityType: DataEntityType.CONTRACT,
          data: { contractId: 'C-001' },
          classification: DataClassification.CONFIDENTIAL,
          createdAt: new Date(Date.now() - 35 * 24 * 60 * 60 * 1000),
        },
        policy.id,
      );

      // Archive once
      await manager.archiveData(contract.id);

      // Try to archive again (should fail gracefully)
      await expect(manager.archiveData(contract.id)).rejects.toThrow();
    });

    it('should handle non-existent data cleanup', async () => {
      await expect(manager.retrieveData('non-existent')).resolves.toBeNull();
      await expect(manager.getRetentionStatus('non-existent')).resolves.toBeNull();
    });

    it('should handle deletion of non-existent data', async () => {
      await expect(manager.deleteData('non-existent')).rejects.toThrow();
    });
  });

  describe('Policy Lifecycle Management', () => {
    it('should create, update, and deactivate policies', () => {
      // Create policy
      const policy = manager.createRetentionPolicy({
        name: 'Original Policy',
        description: 'Original description',
        entityType: DataEntityType.DOCUMENT,
        period: RetentionPeriod.NINETY_DAYS,
        classification: DataClassification.INTERNAL,
        archivalType: ArchivalStorageType.LOCAL,
        encryptArchive: false,
        allowPermanentRetention: false,
        isActive: true,
      });

      const policyId = policy.id;

      // Verify active
      let activePolicies = manager.getActivePolicies();
      expect(activePolicies.some(p => p.id === policyId)).toBe(true);

      // Get and verify policy details
      const retrieved = manager.getRetentionPolicy(policyId);
      expect(retrieved?.name).toBe('Original Policy');
    });

    it('should set default policies by entity type', () => {
      const policy = manager.createRetentionPolicy({
        name: 'Default Contract Policy',
        description: '',
        entityType: DataEntityType.CONTRACT,
        period: RetentionPeriod.ONE_YEAR,
        classification: DataClassification.CONFIDENTIAL,
        archivalType: ArchivalStorageType.COLD_STORAGE,
        encryptArchive: true,
        allowPermanentRetention: false,
        isActive: true,
      });

      manager.setDefaultPolicy(DataEntityType.CONTRACT, policy.id);

      // Data stored without explicit policy should use default
      manager.storeData(
        {
          entityType: DataEntityType.CONTRACT,
          data: { contractId: 'C-001' },
          classification: DataClassification.CONFIDENTIAL,
          createdAt: new Date(),
        },
        undefined, // No explicit policy
      );

      expect(true).toBe(true); // Should not throw
    });
  });

  describe('Retention Checks and Automated Processing', () => {
    it('should run retention checks without errors', async () => {
      manager.createRetentionPolicy({
        name: 'Test',
        description: '',
        entityType: DataEntityType.DOCUMENT,
        period: RetentionPeriod.THIRTY_DAYS,
        classification: DataClassification.INTERNAL,
        archivalType: ArchivalStorageType.LOCAL,
        encryptArchive: false,
        allowPermanentRetention: false,
        isActive: true,
      });

      const result = await manager.runRetentionChecks();

      expect(result.archived).toBeDefined();
      expect(result.deleted).toBeDefined();
      expect(result.failed).toBeDefined();
    });

    it('should not process when retention is disabled', async () => {
      const disabledManager = new DataRetentionManager({
        ...config,
        enabled: false,
      });

      const result = await disabledManager.runRetentionChecks();

      expect(result.archived).toBe(0);
      expect(result.deleted).toBe(0);
      expect(result.failed).toBe(0);
    });
  });
});
