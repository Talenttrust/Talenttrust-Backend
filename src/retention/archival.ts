/**
 * Data Archival Service
 * 
 * Handles secure archival of expired or archived data, including
 * encryption, storage management, and lifecycle operations.
 * 
 * @module retention/archival
 */

import { RetainedData, ArchivalStorageType, DataClassification } from './types';
import { StorageManager } from './storage';
import { RetentionPolicyEngine } from './policies';

/**
 * Options for archival operations
 * @interface ArchivalOptions
 */
export interface ArchivalOptions {
  encrypted?: boolean;
  location?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Archival result information
 * @interface ArchivalResult
 */
export interface ArchivalResult {
  success: boolean;
  dataId: string;
  archivedAt: Date;
  location: string;
  encrypted: boolean;
  sizeBytes?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Data archival service
 * 
 * Manages the lifecycle of archiving data, including secure storage,
 * retrieval, restoration, and compliance tracking.
 * 
 * @class DataArchivalService
 */
export class DataArchivalService {
  private storageManager: StorageManager;
  private policyEngine: RetentionPolicyEngine;
  private encryptionEnabled: boolean;

  /**
   * Initialize the archival service
   * @param {StorageManager} storageManager - Storage management service
   * @param {RetentionPolicyEngine} policyEngine - Policy enforcement engine
   * @param {boolean} [encryptionEnabled=false] - Enable encryption for archives
   */
  constructor(
    storageManager: StorageManager,
    policyEngine: RetentionPolicyEngine,
    encryptionEnabled: boolean = false,
  ) {
    this.storageManager = storageManager;
    this.policyEngine = policyEngine;
    this.encryptionEnabled = encryptionEnabled;
  }

  /**
   * Archive data based on policy requirements
   * 
   * Moves data to archival storage with optional encryption based on
   * its classification level and retention policy.
   * 
   * @param {RetainedData} data - Data to archive
   * @param {ArchivalOptions} [options] - Archival configuration
   * @returns {Promise<ArchivalResult>} Archival operation result
   * @throws {Error} If archival fails
   */
  async archiveData(data: RetainedData, options?: ArchivalOptions): Promise<ArchivalResult> {
    if (data.isArchived) {
      throw new Error(`Data ${data.id} is already archived`);
    }

    const now = new Date();
    const policy = data.retentionPolicyId ? this.policyEngine.getPolicy(data.retentionPolicyId) : null;

    const archivalStorageType = policy?.archivalType || ArchivalStorageType.COLD_STORAGE;
    const policyEncryptionRequirement = policy?.encryptArchive ?? true;
    const shouldEncrypt =
      this.shouldEncryptArchive(data.classification, policyEncryptionRequirement) ||
      (options?.encrypted ?? false);

    const archivedData: RetainedData = {
      ...data,
      isArchived: true,
      archivedAt: now,
      archivedLocation: options?.location || this.generateArchiveLocation(data, archivalStorageType),
      metadata: {
        ...data.metadata,
        encrypted: shouldEncrypt,
        ...options?.metadata,
      },
    };

    try {
      const location = await this.storageManager.store(archivedData, archivalStorageType);

      return {
        success: true,
        dataId: data.id,
        archivedAt: now,
        location,
        encrypted: shouldEncrypt,
        metadata: archivedData.metadata,
      };
    } catch (error) {
      throw new Error(`Failed to archive data ${data.id}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Restore archived data back to active storage
   * 
   * Retrieves archived data and restores it to the active data store
   * with updated metadata reflecting the restoration.
   * 
   * @param {string} dataId - ID of archived data to restore
   * @param {ArchivalStorageType} [fromLocation] - Archival storage type
   * @returns {Promise<RetainedData>} Restored data
   * @throws {Error} If restoration fails
   */
  async restoreArchivedData(
    dataId: string,
    fromLocation?: ArchivalStorageType,
  ): Promise<RetainedData> {
    const location = fromLocation || ArchivalStorageType.COLD_STORAGE;

    const archivedData = await this.storageManager.retrieve(dataId, location);
    if (!archivedData) {
      throw new Error(`Archived data not found: ${dataId}`);
    }

    const restoredData: RetainedData = {
      ...archivedData,
      isArchived: false,
      archivedAt: undefined,
      archivedLocation: undefined,
    };

    // Move data back to local storage
    const success = await this.storageManager.moveData(dataId, location, ArchivalStorageType.LOCAL);
    if (!success) {
      throw new Error(`Failed to restore data ${dataId} from archive`);
    }

    return restoredData;
  }

  /**
   * Retrieve archived data (read-only)
   * 
   * @param {string} dataId - ID of archived data
   * @param {ArchivalStorageType} [fromLocation] - Archival storage type
   * @returns {Promise<RetainedData | null>} Archived data or null if not found
   */
  async getArchivedData(
    dataId: string,
    fromLocation?: ArchivalStorageType,
  ): Promise<RetainedData | null> {
    const location = fromLocation || ArchivalStorageType.COLD_STORAGE;
    return this.storageManager.retrieve(dataId, location);
  }

  /**
   * Permanently delete archived data
   * 
   * Securely removes archived data that has exceeded post-archival
   * retention period.
   * 
   * @param {string} dataId - ID of archived data to delete
   * @param {ArchivalStorageType} [fromLocation] - Archival storage type
   * @returns {Promise<boolean>} Success status
   */
  async permanentlyDeleteArchived(
    dataId: string,
    fromLocation?: ArchivalStorageType,
  ): Promise<boolean> {
    const location = fromLocation || ArchivalStorageType.COLD_STORAGE;
    return this.storageManager.delete(dataId, location);
  }

  /**
   * Get archival status for data
   * 
   * @param {string} dataId - Data identifier
   * @param {ArchivalStorageType} [fromLocation] - Archival storage type
   * @returns {Promise<{archived: boolean; location?: string; timestamp?: Date}>} Archival status
   */
  async getArchivalStatus(
    dataId: string,
    fromLocation?: ArchivalStorageType,
  ): Promise<{ archived: boolean; location?: string; timestamp?: Date }> {
    const location = fromLocation || ArchivalStorageType.COLD_STORAGE;
    const data = await this.storageManager.retrieve(dataId, location);

    if (!data) {
      return { archived: false };
    }

    return {
      archived: data.isArchived,
      location: data.archivedLocation,
      timestamp: data.archivedAt,
    };
  }

  /**
   * Determine if data should be encrypted based on classification and policy
   * @private
   * @param {DataClassification} classification - Data sensitivity level
   * @param {boolean} policyRequires - Whether policy requires encryption
   * @returns {boolean}
   */
  private shouldEncryptArchive(classification: DataClassification, policyRequires: boolean): boolean {
    if (!this.encryptionEnabled) return false;

    // Always encrypt restricted and confidential data
    if (
      classification === DataClassification.RESTRICTED ||
      classification === DataClassification.CONFIDENTIAL
    ) {
      return true;
    }

    // Respect policy requirement for other classifications
    return policyRequires;
  }

  /**
   * Generate archive location path based on data and storage type
   * @private
   * @param {RetainedData} data - Data being archived
   * @param {ArchivalStorageType} storageType - Storage type
   * @returns {string}
   */
  private generateArchiveLocation(data: RetainedData, storageType: ArchivalStorageType): string {
    const timestamp = data.archivedAt || new Date();
    const year = timestamp.getUTCFullYear();
    const month = String(timestamp.getUTCMonth() + 1).padStart(2, '0');

    // Format: /archive/{storageType}/{entityType}/{year}/{month}/{dataId}
    return `/archive/${storageType}/${data.entityType}/${year}/${month}/${data.id}`;
  }

  /**
   * List all archived data
   * 
   * @param {ArchivalStorageType} [storageType] - Filter by storage type
   * @returns {Promise<RetainedData[]>} All archived data
   */
  async listArchivedData(storageType?: ArchivalStorageType): Promise<RetainedData[]> {
    // This simplified implementation retrieves from specified storage type
    // In production, would query index/database
    if (!storageType) {
      return [];
    }

    // Placeholder for more comprehensive listing
    // Would iterate through storage locations and filter
    return [];
  }

  /**
   * Calculate archive statistics
   * 
   * @returns {Promise<{totalArchived: number; byStorageType: Record<string, number>}>}
   */
  async getArchiveStats(): Promise<{
    totalArchived: number;
    byStorageType: Record<string, number>;
  }> {
    return {
      totalArchived: 0,
      byStorageType: {},
    };
  }
}
