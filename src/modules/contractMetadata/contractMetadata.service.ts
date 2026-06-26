import { ContractMetadata } from '../../database/schema';
import { contractMetadataRepository } from './contractMetadata.repository';
import {
  CreateContractMetadataRequest,
  UpdateContractMetadataRequest,
  ContractMetadataResponse,
  ContractMetadataListResponse,
} from './contractMetadata.types';
import { AuthenticatedRequest } from '../../middleware/auth';
import { SWRCache, type CacheOptions } from '../../utils/swrCache';
import {
  contractMetadataCacheConfig,
  type ContractMetadataCacheConfig,
} from '../../config/contractMetadataCache';

interface ContractMetadataRepositoryLike {
  create(data: Omit<ContractMetadata, 'id' | 'created_at' | 'updated_at'>): Promise<ContractMetadata>;
  getByContractId(
    contractId: string,
    options?: {
      page?: string;
      limit?: string;
      key?: string;
      data_type?: string;
      includeDeleted?: boolean;
    }
  ): Promise<{ records: ContractMetadata[]; total: number; page: number; limit: number }>;
  getById(id: string): Promise<ContractMetadata | null>;
  update(
    id: string,
    updates: Partial<Pick<ContractMetadata, 'value' | 'is_sensitive' | 'updated_by'>>
  ): Promise<ContractMetadata | null>;
  delete(id: string): Promise<boolean>;
  findByContractAndKey(contractId: string, key: string): Promise<ContractMetadata | null>;
  getContractById(contractId: string): Promise<any>;
}

export interface ContractMetadataServiceOptions {
  repository?: ContractMetadataRepositoryLike;
  cache?: SWRCache;
  cacheConfig?: ContractMetadataCacheConfig;
}

/**
 * Service layer for contract metadata operations.
 *
 * Contract-scoped list reads are wrapped in the SWR cache so repeated hot
 * lookups can be served from memory while a background refresh keeps the
 * repository view current. Writes bump a contract-specific cache generation
 * so stale revalidation results cannot be reused after a mutation.
 */
export class ContractMetadataService {
  private readonly repository: ContractMetadataRepositoryLike;
  private readonly cache: SWRCache;
  private readonly cacheOptions: CacheOptions;
  private readonly cacheVersions = new Map<string, number>();

  constructor(options: ContractMetadataServiceOptions = {}) {
    const cacheConfig = options.cacheConfig ?? contractMetadataCacheConfig;

    this.repository = options.repository ?? contractMetadataRepository;
    this.cache = options.cache ?? new SWRCache({ maxEntries: cacheConfig.maxEntries });
    this.cacheOptions = {
      ttlMs: cacheConfig.ttlMs,
      swrMs: cacheConfig.swrMs,
    };
  }

  /**
   * Create a new contract metadata record.
   *
   * The post-write invalidation bumps the contract's cache generation so any
   * stale SWR entries that are still in flight are ignored by future reads.
   */
  async create(
    contractId: string,
    data: CreateContractMetadataRequest,
    userId: string
  ): Promise<ContractMetadataResponse> {
    const contract = await this.repository.getContractById(contractId);
    if (!contract) {
      throw new Error('Contract not found');
    }

    const existing = await this.repository.findByContractAndKey(contractId, data.key);
    if (existing) {
      throw new Error('Metadata key already exists for this contract');
    }

    const metadata = await this.repository.create({
      contract_id: contractId,
      key: data.key,
      value: data.value,
      data_type: data.data_type || 'string',
      is_sensitive: data.is_sensitive || false,
      created_by: userId,
    });

    this.invalidateContractListCache(contractId);
    return this.formatResponse(metadata);
  }

  /**
   * Get metadata records for a contract.
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
      data_type: options.data_type,
    };

    const cacheKey = this.buildListCacheKey(contractId, queryOptions);
    const result = await this.cache.get(
      cacheKey,
      () => this.repository.getByContractId(contractId, queryOptions),
      this.cacheOptions,
    );

    const records = result.data.records.map((record) => this.formatResponse(record, user));

    return {
      records,
      total: result.data.total,
      page: result.data.page,
      limit: result.data.limit,
    };
  }

  /**
   * Get a single metadata record by ID.
   */
  async getById(
    id: string,
    user?: AuthenticatedRequest['user']
  ): Promise<ContractMetadataResponse | null> {
    const metadata = await this.repository.getById(id);
    if (!metadata) {
      return null;
    }

    return this.formatResponse(metadata, user);
  }

  /**
   * Update a metadata record and invalidate cached list views for the parent contract.
   */
  async update(
    id: string,
    updates: UpdateContractMetadataRequest,
    userId: string,
    user?: AuthenticatedRequest['user']
  ): Promise<ContractMetadataResponse | null> {
    const existing = await this.repository.getById(id);
    if (!existing) {
      return null;
    }

    const metadata = await this.repository.update(id, {
      ...updates,
      updated_by: userId,
    });

    if (metadata) {
      this.invalidateContractListCache(existing.contract_id);
      return this.formatResponse(metadata, user);
    }

    return null;
  }

  /**
   * Soft delete a metadata record and flush the parent contract's cache entries.
   */
  async delete(id: string): Promise<boolean> {
    const existing = await this.repository.getById(id);
    if (!existing) {
      return false;
    }

    const deleted = await this.repository.delete(id);
    if (deleted) {
      this.invalidateContractListCache(existing.contract_id);
    }

    return deleted;
  }

  /**
   * Format metadata record for API response.
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
      updated_at: metadata.updated_at.toISOString(),
    };
  }

  /**
   * Build the cache key for a contract metadata list query.
   *
   * The contract id is part of the prefix and the query payload is serialized
   * in a stable order, which keeps tenant/contract reads isolated.
   */
  private buildListCacheKey(
    contractId: string,
    queryOptions: {
      page?: string;
      limit?: string;
      key?: string;
      data_type?: string;
    }
  ): string {
    return `${this.buildListCachePrefix(contractId)}${JSON.stringify({
      page: queryOptions.page ?? '',
      limit: queryOptions.limit ?? '',
      key: queryOptions.key ?? '',
      data_type: queryOptions.data_type ?? '',
    })}`;
  }

  private buildListCachePrefix(contractId: string, version = this.getCacheVersion(contractId)): string {
    return `contract-metadata:list:${contractId}:v${version}:`;
  }

  private getCacheVersion(contractId: string): number {
    return this.cacheVersions.get(contractId) ?? 0;
  }

  /**
   * Bump the contract-specific cache generation and drop the previous prefix.
   *
   * Any in-flight revalidation for the old generation can still resolve, but
   * future reads will move to the new generation and bypass the stale payload.
   */
  private invalidateContractListCache(contractId: string): void {
    const currentVersion = this.getCacheVersion(contractId);
    this.cacheVersions.set(contractId, currentVersion + 1);
    this.cache.deleteByPrefix(this.buildListCachePrefix(contractId, currentVersion));
  }
}

export const contractMetadataService = new ContractMetadataService();
