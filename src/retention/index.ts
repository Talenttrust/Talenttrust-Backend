/**
 * Data Retention Control Manager
 * 
 * Main orchestrator for all data retention, archival, and compliance operations.
 * Coordinates policies, storage, archival, and audit logging.
 * 
 * @module retention/index
 */

import {
  RetentionPolicy,
  RetainedData,
  RetentionStatus,
  ComplianceAuditLog,
  DataEntityType,
  DataClassification,
  RetentionPeriod,
  ArchivalStorageType,
  RetentionAction,
  RetentionConfig,
} from './types';
import { StorageManager, IStorageProvider, InMemoryStorageProvider } from './storage';
import { RetentionPolicyEngine } from './policies';
import { DataArchivalService } from './archival';
import { ComplianceAuditLogger, AuditLogFilter } from './audit';

/**
 * Primary data retention control manager
 * 
 * Provides high-level API for managing data retention, archival,
 * and compliance requirements across the application.
 * 
 * @class DataRetentionManager
 */
export class DataRetentionManager {
  private config: RetentionConfig;
  private policyEngine: RetentionPolicyEngine;
  private storageManager: StorageManager;
  private archivalService: DataArchivalService;
  private auditLogger: ComplianceAuditLogger;
  private processingEnabled = false;
  private checkInterval?: NodeJS.Timeout;

  /**
   * Initialize the data retention manager
   * @param {RetentionConfig} config - Configuration settings
   * @param {IStorageProvider} [customLocalProvider] - Optional custom storage provider
   * @param {IStorageProvider} [customArchiveProvider] - Optional custom archive provider
   */
  constructor(
    config: RetentionConfig,
    customLocalProvider?: IStorageProvider,
    customArchiveProvider?: IStorageProvider,
  ) {
    this.config = config;
    this.policyEngine = new RetentionPolicyEngine();
    this.storageManager = new StorageManager(
      customLocalProvider || new InMemoryStorageProvider(),
      customArchiveProvider || new InMemoryStorageProvider(),
    );
    this.archivalService = new DataArchivalService(
      this.storageManager,
      this.policyEngine,
      config.encryptionEnabled,
    );
    this.auditLogger = new ComplianceAuditLogger();
  }

  /**
   * Store data with retention policy
   * 
   * Stores data with configurable retention policy, calculating
   * expiration based on policy configuration.
   * 
   * @param {Omit<RetainedData, 'expiresAt' | 'id' | 'isArchived' | 'archivedAt' | 'archivedLocation'>} dataInput - Data to store
   * @param {string} [policyId] - Optional specific policy to apply
   * @param {string} [actor='system'] - Actor performing the action
   * @returns {Promise<{data: RetainedData; policy: RetentionPolicy | undefined}>} Stored data with applied policy
   */
  async storeData(
    dataInput: Omit<RetainedData, 'expiresAt' | 'id' | 'isArchived' | 'archivedAt' | 'archivedLocation'>,
    policyId?: string,
    actor: string = 'system',
  ): Promise<{ data: RetainedData; policy: RetentionPolicy | undefined }> {
    const data: RetainedData = {
      ...dataInput,
      id: this.generateDataId(),
      isArchived: false,
      expiresAt: new Date(), // Will be overridden
      retentionPolicyId: policyId,
    };

    // Calculate expiration date based on policy
    data.expiresAt = this.policyEngine.calculateExpirationDate(data);

    try {
      await this.storageManager.store(data, ArchivalStorageType.LOCAL);

      const policy = policyId ? this.policyEngine.getPolicy(policyId) : undefined;

      // Audit log
      this.auditLogger.logAction({
        entityId: data.id,
        entityType: data.entityType,
        action: RetentionAction.CREATE,
        actor,
        details: {
          classification: data.classification,
          policyId,
          expiresAt: data.expiresAt,
        },
        compliance: this.config.complianceStandard,
      });

      return { data, policy };
    } catch (error) {
      throw new Error(`Failed to store data: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Retrieve stored data by ID
   * 
   * @param {string} dataId - Data identifier
   * @returns {Promise<RetainedData | null>}
   */
  async retrieveData(dataId: string): Promise<RetainedData | null> {
    return this.storageManager.retrieve(dataId, ArchivalStorageType.LOCAL);
  }

  /**
   * Get retention status for data
   * 
   * @param {string} dataId - Data identifier
   * @returns {Promise<RetentionStatus | null>}
   */
  async getRetentionStatus(dataId: string): Promise<RetentionStatus | null> {
    const data = await this.retrieveData(dataId);
    if (!data) return null;

    return this.policyEngine.determineRetentionStatus(data);
  }

  /**
   * Create a retention policy
   * 
   * @param {Omit<RetentionPolicy, 'id' | 'createdAt' | 'updatedAt'>} config - Policy configuration
   * @returns {RetentionPolicy}
   */
  createRetentionPolicy(
    config: Omit<RetentionPolicy, 'id' | 'createdAt' | 'updatedAt'>,
  ): RetentionPolicy {
    const policy = this.policyEngine.createPolicy(config);

    this.auditLogger.logAction({
      entityId: policy.id,
      entityType: DataEntityType.CONTRACT, // Meta entity
      action: RetentionAction.POLICY_APPLIED,
      actor: 'system',
      details: {
        policyName: policy.name,
        period: policy.period,
        classification: policy.classification,
      },
      compliance: this.config.complianceStandard,
    });

    return policy;
  }

  /**
   * Get a retention policy
   * 
   * @param {string} policyId - Policy identifier
   * @returns {RetentionPolicy | undefined}
   */
  getRetentionPolicy(policyId: string): RetentionPolicy | undefined {
    return this.policyEngine.getPolicy(policyId);
  }

  /**
   * Get all active policies
   * 
   * @returns {RetentionPolicy[]}
   */
  getActivePolicies(): RetentionPolicy[] {
    return this.policyEngine.getActivePolicies();
  }

  /**
   * Set default policy for entity type
   * 
   * @param {DataEntityType} entityType - Entity type
   * @param {string} policyId - Policy identifier
   */
  setDefaultPolicy(entityType: DataEntityType, policyId: string): void {
    this.policyEngine.setDefaultPolicyForEntityType(entityType, policyId);
  }

  /**
   * Archive expired data
   * 
   * Moves data that has exceeded its retention period to archival storage.
   * 
   * @param {string} dataId - Data identifier
   * @param {string} [actor='system'] - Actor performing the action
   * @returns {Promise<{success: boolean; archivedAt?: Date; location?: string}>}
   */
  async archiveData(dataId: string, actor: string = 'system'): Promise<{
    success: boolean;
    archivedAt?: Date;
    location?: string;
  }> {
    const data = await this.retrieveData(dataId);
    if (!data) {
      throw new Error(`Data not found: ${dataId}`);
    }

    if (data.isArchived) {
      throw new Error(`Data ${dataId} is already archived`);
    }

    if (!this.policyEngine.shouldArchive(data)) {
      throw new Error(`Data ${dataId} does not meet archival criteria`);
    }

    try {
      const result = await this.archivalService.archiveData(data);

      // Update data in local storage to mark as archived
      const archivedData: RetainedData = {
        ...data,
        isArchived: true,
        archivedAt: result.archivedAt,
        archivedLocation: result.location,
      };
      await this.storageManager.store(archivedData, ArchivalStorageType.LOCAL);

      this.auditLogger.logAction({
        entityId: dataId,
        entityType: data.entityType,
        action: RetentionAction.ARCHIVE,
        actor,
        details: {
          location: result.location,
          encrypted: result.encrypted,
          classification: data.classification,
        },
        compliance: this.config.complianceStandard,
      });

      return {
        success: result.success,
        archivedAt: result.archivedAt,
        location: result.location,
      };
    } catch (error) {
      throw new Error(`Failed to archive data: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Restore archived data
   * 
   * @param {string} dataId - Data identifier
   * @param {string} [actor='system'] - Actor performing the action
   * @returns {Promise<RetainedData>}
   */
  async restoreArchivedData(dataId: string, actor: string = 'system'): Promise<RetainedData> {
    const restored = await this.archivalService.restoreArchivedData(dataId);

    // Store restored data back in local storage
    await this.storageManager.store(restored, ArchivalStorageType.LOCAL);

    this.auditLogger.logAction({
      entityId: dataId,
      entityType: restored.entityType,
      action: RetentionAction.RESTORE,
      actor,
      details: {
        classification: restored.classification,
      },
      compliance: this.config.complianceStandard,
    });

    return restored;
  }

  /**
   * Permanently delete data
   * 
   * Removes data that has exceeded all retention periods.
   * 
   * @param {string} dataId - Data identifier
   * @param {string} [actor='system'] - Actor performing the action
   * @returns {Promise<boolean>}
   */
  async deleteData(dataId: string, actor: string = 'system'): Promise<boolean> {
    const data = await this.retrieveData(dataId);
    if (!data) {
      throw new Error(`Data not found: ${dataId}`);
    }

    const deleted = await this.storageManager.delete(dataId, ArchivalStorageType.LOCAL);

    if (deleted) {
      this.auditLogger.logAction({
        entityId: dataId,
        entityType: data.entityType,
        action: RetentionAction.DELETE,
        actor,
        details: {
          classification: data.classification,
          wasArchived: data.isArchived,
        },
        compliance: this.config.complianceStandard,
      });
    }

    return deleted;
  }

  /**
   * Run retention checks and perform archival/deletion as needed
   * 
   * Automatically archives expired data and deletes post-archival expired data.
   * 
   * @returns {Promise<{archived: number; deleted: number; failed: number}>}
   */
  async runRetentionChecks(): Promise<{ archived: number; deleted: number; failed: number }> {
    if (!this.config.enabled) {
      return { archived: 0, deleted: 0, failed: 0 };
    }

    let archived = 0;
    let deleted = 0;
    let failed = 0;

    // This is a placeholder for the actual implementation
    // In production, would process all data in batches
    // const allData = await this.storageManager.list();

    // for (const data of allData) {
    //   try {
    //     if (!data.isArchived && this.policyEngine.shouldArchive(data)) {
    //       await this.archiveData(data.id);
    //       archived++;
    //     } else if (data.isArchived && this.policyEngine.shouldPermanentlyDelete(data, this.config.postArchivalRetentionDays)) {
    //       await this.storageManager.delete(data.id, ArchivalStorageType.COLD_STORAGE);
    //       deleted++;
    //     }
    //   } catch (error) {
    //     failed++;
    //   }
    // }

    return { archived, deleted, failed };
  }

  /**
   * Start automated retention processing
   * 
   * Begins periodic checks for data that needs archival or deletion.
   * 
   * @returns {void}
   */
  startAutomatedProcessing(): void {
    if (this.processingEnabled) return;
    if (!this.config.enabled) return;

    this.processingEnabled = true;
    this.checkInterval = setInterval(
      () => {
        this.runRetentionChecks().catch(error => {
          console.error('Error during retention checks:', error);
        });
      },
      this.config.checksIntervalMs,
    );
  }

  /**
   * Stop automated retention processing
   * 
   * @returns {void}
   */
  stopAutomatedProcessing(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = undefined;
    }
    this.processingEnabled = false;
  }

  /**
   * Get audit logs for compliance reporting
   * 
   * @param {AuditLogFilter} [filter] - Optional filter criteria
   * @returns {ComplianceAuditLog[]}
   */
  getAuditLogs(filter?: AuditLogFilter): ComplianceAuditLog[] {
    return this.auditLogger.queryLogs(filter || {});
  }

  /**
   * Get compliance report
   * 
   * @returns {Record<string, {count: number; actions: Record<string, number>}>}
   */
  getComplianceReport(): Record<string, { count: number; actions: Record<string, number> }> {
    return this.auditLogger.getComplianceReport();
  }

  /**
   * Export audit trail for compliance review
   * 
   * @param {AuditLogFilter} [filter] - Optional filter criteria
   * @returns {ComplianceAuditLog[]}
   */
  exportAuditTrail(filter?: AuditLogFilter): ComplianceAuditLog[] {
    return this.auditLogger.exportLogs(filter);
  }

  /**
   * Generate unique data ID
   * @private
   * @returns {string}
   */
  private generateDataId(): string {
    return `data_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}

// Export all types and utilities
export {
  RetentionPolicy,
  RetainedData,
  RetentionStatus,
  ComplianceAuditLog,
  DataEntityType,
  DataClassification,
  RetentionPeriod,
  ArchivalStorageType,
  RetentionAction,
  RetentionConfig,
  StorageManager,
  IStorageProvider,
  InMemoryStorageProvider,
  RetentionPolicyEngine,
  DataArchivalService,
  ComplianceAuditLogger,
};
