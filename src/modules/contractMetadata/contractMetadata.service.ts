import { ContractMetadata } from '../../database/schema';
import { contractMetadataRepository } from './contractMetadata.repository';
import { CreateContractMetadataRequest, UpdateContractMetadataRequest, ContractMetadataResponse, ContractMetadataListResponse } from './contractMetadata.types';
import { AuthenticatedRequest } from '../../middleware/auth';

/**
 * Service layer for contract metadata operations
 * Handles business logic and authorization
 */
export class ContractMetadataService {
  /**
   * Create a new contract metadata record
   * @param contractId - Contract ID
   * @param data - Metadata data to create
   * @param userId - User ID creating the metadata
   * @returns Created metadata response
   * @throws Error if contract not found, duplicate key, or validation fails
   */
  async create(
    contractId: string,
    data: CreateContractMetadataRequest,
    userId: string
  ): Promise<ContractMetadataResponse> {
    // Check if contract exists
    const contract = await contractMetadataRepository.getContractById(contractId);
    if (!contract) {
      throw new Error('Contract not found');
    }

    // Check for duplicate key
    const existing = await contractMetadataRepository.findByContractAndKey(contractId, data.key);
    if (existing) {
      throw new Error('Metadata key already exists for this contract');
    }

    const metadata = await contractMetadataRepository.create({
      contract_id: contractId,
      key: data.key,
      value: data.value,
      data_type: data.data_type || 'string',
      is_sensitive: data.is_sensitive || false,
      created_by: userId
    });

    return this.formatResponse(metadata);
  }

  /**
   * Get metadata records for a contract
   * @param contractId - Contract ID
   * @param options - Pagination and filter options
   * @param user - Authenticated user for permission checking
   * @returns Paginated metadata list response
   */
  async list(
    contractId: string,
    options: {
      page?: number;
      limit?: number;
      key?: string;
      data_type?: string;
    },
    user?: AuthenticatedRequest['user']
  ): Promise<ContractMetadataListResponse> {
    const queryOptions = {
      page: options.page?.toString(),
      limit: options.limit?.toString(),
      key: options.key,
      data_type: options.data_type
    };
    const result = await contractMetadataRepository.getByContractId(contractId, queryOptions);
    
    const records = result.records.map(record => 
      this.formatResponse(record, user)
    );

    return {
      records,
      total: result.total,
      page: result.page,
      limit: result.limit
    };
  }

  /**
   * Get a single metadata record by ID
   * @param id - Metadata ID
   * @param user - Authenticated user for permission checking
   * @returns Metadata response or null if not found
   */
  async getById(
    id: string,
    user?: AuthenticatedRequest['user']
  ): Promise<ContractMetadataResponse | null> {
    const metadata = await contractMetadataRepository.getById(id);
    if (!metadata) {
      return null;
    }

    return this.formatResponse(metadata, user);
  }

  /**
   * Update a metadata record
   * @param id - Metadata ID
   * @param updates - Fields to update
   * @param userId - User ID performing the update
   * @param user - Authenticated user for permission checking
   * @returns Updated metadata response or null if not found
   * @throws Error if attempting to update immutable fields
   */
  async update(
    id: string,
    updates: UpdateContractMetadataRequest,
    userId: string,
    user?: AuthenticatedRequest['user']
  ): Promise<ContractMetadataResponse | null> {
    const existing = await contractMetadataRepository.getById(id);
    if (!existing) {
      return null;
    }

    const metadata = await contractMetadataRepository.update(id, {
      ...updates,
      updated_by: userId
    });

    return metadata ? this.formatResponse(metadata, user) : null;
  }

  /**
   * Soft delete a metadata record
   * @param id - Metadata ID
   * @returns True if deleted, false if not found
   */
  async delete(id: string): Promise<boolean> {
    return await contractMetadataRepository.delete(id);
  }

  /**
   * Format metadata record for API response
   * @param metadata - Metadata record
   * @param user - Authenticated user for sensitive data masking
   * @returns Formatted response
   */
  private formatResponse(
    metadata: ContractMetadata,
    user?: AuthenticatedRequest['user']
  ): ContractMetadataResponse {
    const shouldMaskValue = metadata.is_sensitive && 
      user && 
      metadata.created_by !== user.id && 
      user.role !== 'admin';

    return {
      id: metadata.id,
      contract_id: metadata.contract_id,
      key: metadata.key,
      value: shouldMaskValue ? '***REDACTED***' : metadata.value,
      data_type: metadata.data_type,
      is_sensitive: metadata.is_sensitive,
      created_by: metadata.created_by,
      updated_by: metadata.updated_by,
      created_at: metadata.created_at.toISOString(),
      updated_at: metadata.updated_at.toISOString()
    };
  }
}

export const contractMetadataService = new ContractMetadataService();
