import { database } from '../../database';
import { ContractMetadata } from '../../database/schema';
import { CreateContractMetadataRequest, UpdateContractMetadataRequest, PaginationQuery } from './contractMetadata.types';

/**
 * Repository layer for contract metadata operations
 * Handles all database interactions for contract metadata
 */
export class ContractMetadataRepository {
  /**
   * Create a new contract metadata record
   * @param data - Metadata data to create
   * @returns Created metadata record
   */
  async create(data: Omit<ContractMetadata, 'id' | 'created_at' | 'updated_at'>): Promise<ContractMetadata> {
    return await database.createContractMetadata(data);
  }

  /**
   * Get metadata records for a contract with pagination and filtering
   * @param contractId - Contract ID
   * @param options - Pagination and filter options
   * @returns Paginated metadata records
   */
  async getByContractId(
    contractId: string,
    options: PaginationQuery & { includeDeleted?: boolean } = {}
  ): Promise<{ records: ContractMetadata[]; total: number; page: number; limit: number }> {
    const dbOptions = {
      page: options.page ? parseInt(options.page) : undefined,
      limit: options.limit ? parseInt(options.limit) : undefined,
      key: options.key,
      data_type: options.data_type,
      includeDeleted: options.includeDeleted
    };
    return await database.getContractMetadataByContractId(contractId, dbOptions);
  }

  /**
   * Get a single metadata record by ID
   * @param id - Metadata ID
   * @returns Metadata record or null if not found
   */
  async getById(id: string): Promise<ContractMetadata | null> {
    return await database.getContractMetadataById(id);
  }

  /**
   * Update a metadata record
   * @param id - Metadata ID
   * @param updates - Fields to update
   * @returns Updated metadata record or null if not found
   */
  async update(
    id: string,
    updates: Partial<Pick<ContractMetadata, 'value' | 'is_sensitive' | 'updated_by'>>
  ): Promise<ContractMetadata | null> {
    return await database.updateContractMetadata(id, updates);
  }

  /**
   * Soft delete a metadata record
   * @param id - Metadata ID
   * @returns True if deleted, false if not found
   */
  async delete(id: string): Promise<boolean> {
    return await database.deleteContractMetadata(id);
  }

  /**
   * Find metadata by contract ID and key (for duplicate checking)
   * @param contractId - Contract ID
   * @param key - Metadata key
   * @returns Metadata record or null if not found
   */
  async findByContractAndKey(contractId: string, key: string): Promise<ContractMetadata | null> {
    return await database.findContractMetadataByKey(contractId, key);
  }

  /**
   * Check if a contract exists
   * @param contractId - Contract ID
   * @returns Contract record or null if not found
   */
  async getContractById(contractId: string): Promise<any> {
    return await database.getContractById(contractId);
  }
}

export const contractMetadataRepository = new ContractMetadataRepository();
