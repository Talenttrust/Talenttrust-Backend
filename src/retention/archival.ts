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
/**
 * List archived data with optional storage filter and pagination.
 *
 * @param {ArchivalStorageType} [storageType] - Filter by storage type.
 * @param {number} [limit] - Maximum number of records to return. If omitted, returns all.
 * @param {number} [offset] - Number of records to skip before returning results. Defaults to 0.
 * @returns {Promise<RetainedData[]>} Archived data matching criteria.
 */
async listArchivedData(
  storageType?: ArchivalStorageType,
  limit?: number,
  offset: number = 0,
): Promise<RetainedData[]> {
  // Helper to apply pagination
  const paginate = (items: RetainedData[]): RetainedData[] => {
    if (limit !== undefined) {
      return items.slice(offset, offset + limit);
    }
    return items.slice(offset);
  };

  // If a specific storage type is provided, query the backing provider and keep
  // only the records that actually belong to that storage type. Several storage
  // types can share a single physical provider (e.g. COLD_STORAGE and
  // ENCRYPTED_ARCHIVE both map to the archive provider), so listing the provider
  // alone would return records from sibling storage types too.
  if (storageType) {
    const provider = this.storageManager.getProvider(storageType);
    const all = await provider.list();
    const filtered = all.filter(
      (item) => this.resolveStorageType(item) === storageType,
    );
    return paginate(filtered);
  }

  // No storage filter: aggregate a de-duplicated view across all storage types.
  // Because multiple enum values can resolve to the same provider, iterating the
  // enum naively would visit shared providers more than once and double-count
  // their records. De-duplicate by id to return each archived item exactly once.
  const allTypes = Object.values(ArchivalStorageType) as ArchivalStorageType[];
  const seen = new Set<string>();
  const aggregated: RetainedData[] = [];
  for (const type of allTypes) {
    const provider = this.storageManager.getProvider(type);
    const list = await provider.list();
    for (const item of list) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      aggregated.push(item);
    }
  }
  return paginate(aggregated);
}

/**
 * Resolve the archival storage type an item lives in from its archive location.
 *
 * Archive locations are shaped like `/archive/{storageType}/...`, so the storage
 * type is recovered by finding the first path segment that matches a known
 * {@link ArchivalStorageType} value. Returns `undefined` when the location is
 * missing or does not encode a recognised storage type.
 *
 * @private
 */
private resolveStorageType(item: RetainedData): ArchivalStorageType | undefined {
  const location = item.archivedLocation;
  if (!location) return undefined;
  const knownTypes = Object.values(ArchivalStorageType) as ArchivalStorageType[];
  for (const segment of location.split('/')) {
    if (!segment) continue;
    if (knownTypes.includes(segment as ArchivalStorageType)) {
      return segment as ArchivalStorageType;
    }
  }
  return undefined;
}

  /**
   * Calculate archive statistics
   * 
   * @returns {Promise<{totalArchived: number; byStorageType: Record<string, number>}>}
   */
/**
 * Calculate archive statistics across all storage backends.
 *
 * @returns {Promise<{ totalArchived: number; byStorageType: Record<string, number> }>}
 *   Object containing the total number of archived records and a breakdown per storage type.
 */
async getArchiveStats(): Promise<{
  totalArchived: number;
  byStorageType: Record<string, number>;
}> {
  const allTypes = Object.values(ArchivalStorageType) as ArchivalStorageType[];

  // Seed every known storage type with a zero count so callers always see the
  // full set of buckets, even for storage types that hold no records.
  const stats: Record<string, number> = {};
  for (const type of allTypes) {
    stats[type] = 0;
  }

  // Providers can be shared across storage types, so de-duplicate by id and
  // attribute each record to the storage type encoded in its archive location.
  const seen = new Set<string>();
  let total = 0;
  for (const type of allTypes) {
    const provider = this.storageManager.getProvider(type);
    const list = await provider.list();
    for (const item of list) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      const resolved = this.resolveStorageType(item) ?? type;
      stats[resolved] = (stats[resolved] ?? 0) + 1;
      total += 1;
    }
  }
  return { totalArchived: total, byStorageType: stats };
}

  /**
   * Export data in specified format for compliance
   * 
   * @param {string} dataId - Data identifier
   * @param {'json' | 'csv'} format - Export format
   * @param {ArchivalStorageType} [fromLocation] - Archival storage type
   * @returns {Promise<string>} Serialized data
   */
  async exportData(
    dataId: string,
    format: 'json' | 'csv',
    fromLocation?: ArchivalStorageType,
  ): Promise<string> {
    const data = await this.getArchivedData(dataId, fromLocation);
    if (!data) {
      throw new Error(`Data not found for export: ${dataId}`);
    }

    if (format === 'json') {
      return JSON.stringify(data, null, 2);
    } else {
      // Basic CSV implementation
      const headers = ['id', 'entityType', 'classification', 'createdAt', 'expiresAt', 'isArchived', 'archivedAt'];
      const values = [
        data.id,
        data.entityType,
        data.classification,
        data.createdAt.toISOString(),
        data.expiresAt.toISOString(),
        data.isArchived.toString(),
        data.archivedAt?.toISOString() || '',
      ];

      // Flatten data payload if it's an object
      if (typeof data.data === 'object' && data.data !== null) {
        Object.entries(data.data).forEach(([key, val]) => {
          headers.push(`data.${key}`);
          values.push(String(val));
        });
      } else {
        headers.push('data');
        values.push(String(data.data));
      }

      return `${headers.join(',')}\n${values.join(',')}`;
    }
  }
}
