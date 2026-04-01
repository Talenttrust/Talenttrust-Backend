/**
 * Storage abstraction layer for retained data
 * 
 * Provides a flexible interface for storing, retrieving, and managing
 * retained data with support for different storage backends.
 * 
 * @module retention/storage
 */

import { RetainedData, DataEntityType, DataClassification, ArchivalStorageType } from './types';

/**
 * Abstract storage provider interface
 * 
 * Allows implementation of different storage backends (local, cloud, encrypted, etc.)
 * 
 * @interface IStorageProvider
 */
export interface IStorageProvider {
  /**
   * Store a data entity
   * @param {RetainedData} data - Data to store
   * @returns {Promise<string>} Storage location/ID
   */
  store(data: RetainedData): Promise<string>;

  /**
   * Retrieve stored data
   * @param {string} id - Data identifier
   * @returns {Promise<RetainedData | null>} Retrieved data or null if not found
   */
  retrieve(id: string): Promise<RetainedData | null>;

  /**
   * Delete stored data
   * @param {string} id - Data identifier
   * @returns {Promise<boolean>} Success status
   */
  delete(id: string): Promise<boolean>;

  /**
   * List all stored data
   * @returns {Promise<RetainedData[]>} All stored data
   */
  list(): Promise<RetainedData[]>;

  /**
   * Check if data exists
   * @param {string} id - Data identifier
   * @returns {Promise<boolean>} Existence status
   */
  exists(id: string): Promise<boolean>;
}

/**
 * In-memory storage provider implementation
 * 
 * Suitable for development, testing, and small-scale deployments.
 * Data is stored in application memory.
 * 
 * @class InMemoryStorageProvider
 * @implements {IStorageProvider}
 */
export class InMemoryStorageProvider implements IStorageProvider {
  private storage: Map<string, RetainedData> = new Map();

  /**
   * Store data in memory
   * @param {RetainedData} data - Data to store
   * @returns {Promise<string>} Data ID
   */
  async store(data: RetainedData): Promise<string> {
    this.storage.set(data.id, { ...data });
    return data.id;
  }

  /**
   * Retrieve data from memory
   * @param {string} id - Data identifier
   * @returns {Promise<RetainedData | null>}
   */
  async retrieve(id: string): Promise<RetainedData | null> {
    return this.storage.get(id) || null;
  }

  /**
   * Delete data from memory
   * @param {string} id - Data identifier
   * @returns {Promise<boolean>}
   */
  async delete(id: string): Promise<boolean> {
    return this.storage.delete(id);
  }

  /**
   * List all data in memory
   * @returns {Promise<RetainedData[]>}
   */
  async list(): Promise<RetainedData[]> {
    return Array.from(this.storage.values());
  }

  /**
   * Check if data exists
   * @param {string} id - Data identifier
   * @returns {Promise<boolean>}
   */
  async exists(id: string): Promise<boolean> {
    return this.storage.has(id);
  }

  /**
   * Clear all data (useful for testing)
   * @returns {void}
   */
  clear(): void {
    this.storage.clear();
  }

  /**
   * Get storage size
   * @returns {number}
   */
  size(): number {
    return this.storage.size;
  }
}

/**
 * Storage manager for handling multiple storage backends
 * 
 * @class StorageManager
 */
export class StorageManager {
  private localProvider: IStorageProvider;
  private archiveProvider: IStorageProvider;

  /**
   * Initialize storage manager with providers
   * @param {IStorageProvider} [localProvider] - Local storage provider (defaults to in-memory)
   * @param {IStorageProvider} [archiveProvider] - Archive storage provider (defaults to in-memory)
   */
  constructor(
    localProvider?: IStorageProvider,
    archiveProvider?: IStorageProvider,
  ) {
    this.localProvider = localProvider || new InMemoryStorageProvider();
    this.archiveProvider = archiveProvider || new InMemoryStorageProvider();
  }

  /**
   * Store data with appropriate provider based on archival status
   * @param {RetainedData} data - Data to store
   * @param {ArchivalStorageType} [storageType='local'] - Storage type
   * @returns {Promise<string>} Storage location
   */
  async store(data: RetainedData, storageType: ArchivalStorageType = ArchivalStorageType.LOCAL): Promise<string> {
    const provider = this.getProvider(storageType);
    return provider.store(data);
  }

  /**
   * Retrieve data from appropriate storage
   * @param {string} id - Data identifier
   * @param {ArchivalStorageType} [storageType='local'] - Storage type
   * @returns {Promise<RetainedData | null>}
   */
  async retrieve(id: string, storageType: ArchivalStorageType = ArchivalStorageType.LOCAL): Promise<RetainedData | null> {
    const provider = this.getProvider(storageType);
    return provider.retrieve(id);
  }

  /**
   * Move data between storage types
   * @param {string} id - Data identifier
   * @param {ArchivalStorageType} fromType - Source storage type
   * @param {ArchivalStorageType} toType - Destination storage type
   * @returns {Promise<boolean>} Success status
   */
  async moveData(
    id: string,
    fromType: ArchivalStorageType,
    toType: ArchivalStorageType,
  ): Promise<boolean> {
    const data = await this.retrieve(id, fromType);
    if (!data) return false;

    const toProvider = this.getProvider(toType);
    const stored = await toProvider.store(data);

    if (stored) {
      const fromProvider = this.getProvider(fromType);
      await fromProvider.delete(id);
      return true;
    }
    return false;
  }

  /**
   * Delete data from specified storage
   * @param {string} id - Data identifier
   * @param {ArchivalStorageType} [storageType='local'] - Storage type
   * @returns {Promise<boolean>}
   */
  async delete(id: string, storageType: ArchivalStorageType = ArchivalStorageType.LOCAL): Promise<boolean> {
    const provider = this.getProvider(storageType);
    return provider.delete(id);
  }

  /**
   * Get provider for storage type
   * @private
   * @param {ArchivalStorageType} storageType - Storage type
   * @returns {IStorageProvider}
   */
  private getProvider(storageType: ArchivalStorageType): IStorageProvider {
    switch (storageType) {
      case ArchivalStorageType.COLD_STORAGE:
      case ArchivalStorageType.ENCRYPTED_ARCHIVE:
        return this.archiveProvider;
      default:
        return this.localProvider;
    }
  }
}
