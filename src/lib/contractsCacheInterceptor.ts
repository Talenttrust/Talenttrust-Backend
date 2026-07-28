/**
 * @module contractsCacheInterceptor
 * @description Wraps ContractsService with bounded TTL cache and write-time invalidation.
 *
 * ## Design
 *
 * This interceptor sits in front of ContractsService and transparently adds caching
 * to read methods and invalidation to write methods. It does NOT modify the service
 * itself, but wraps it in a proxy-like pattern.
 *
 * ### Read Method Caching
 * - `getAllContracts()` → key: `contracts:list`
 * - `getContractById(id)` → key: `contracts:single:{id}`
 * - `getContractsPage(input)` → key: `contracts:page:{hash(input)}`
 * - `getContractStats()` → key: `contracts:stats`
 * - `getBounds()` → key: `contracts:bounds` (static, immutable)
 *
 * ### Write-Time Invalidation
 * - `createContract()`: invalidates `contracts:list`, `contracts:stats`, `contracts:page:**`
 * - `updateContract()`: invalidates `contracts:single:{id}`, `contracts:list`, `contracts:stats`, `contracts:page:**`
 * - `deleteContract()`: invalidates `contracts:single:{id}`, `contracts:list`, `contracts:stats`, `contracts:page:**`
 *
 * **Crucially, invalidation happens synchronously before the write's response is sent.**
 * This guarantees no client sees stale data immediately after a write completes.
 *
 * ## Metrics Integration
 * Emits cache hit/miss metrics through MetricsService callbacks passed in the config.
 *
 * @internal This is wired into the dependency injection at ContractsService instantiation.
 */

import type { CursorPaginationInput } from '../contracts/cursor.types';
import type { ContractsService } from '../services/contracts.service';
import type { CreateContractDto, UpdateContractDto } from '../modules/contracts/dto/contract.dto';
import type { Contract } from '../db/types';
import { CacheService } from './cacheService';
import type { CacheConfig } from '../config/cache';
import type { MetricsServiceLike } from '../observability/metrics-service';

/**
 * Configuration for the cache interceptor, including cache settings and metrics callbacks.
 */
export interface CacheInterceptorConfig extends CacheConfig {
  /** Optional metrics service for recording cache hit/miss events */
  metricsService?: MetricsServiceLike;
}

/**
 * Creates a cached wrapper around a ContractsService instance.
 *
 * @param service - The underlying ContractsService to wrap
 * @param config - Cache configuration including TTL, bounds, and optional metrics
 * @returns A new object with the same interface as ContractsService but with caching
 */
export function createCachedContractsService(
  service: ContractsService,
  config: CacheInterceptorConfig,
): ContractsService {
  const cache = new CacheService<any>(config, {
    onHit: (key) => {
      config.metricsService?.recordCacheHit('contracts');
    },
    onMiss: (key) => {
      config.metricsService?.recordCacheMiss('contracts');
    },
  });

  /**
   * Wraps a read method with caching logic.
   * @param key - Cache key for this read
   * @param fn - The underlying read function from the service
   * @returns The cached result or a fresh fetch
   */
  const cachedRead = async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const cached = cache.get(key);
    if (cached !== undefined) {
      return cached as T;
    }
    const result = await fn();
    cache.set(key, result);
    return result;
  };

  /**
   * Wraps a write method with cache invalidation.
   * Invalidates affected keys SYNCHRONOUSLY before the write completes, so
   * a client that immediately reads after a write sees fresh data.
   *
   * @param invalidationKeys - Keys or patterns to invalidate
   * @param fn - The underlying write function from the service
   * @returns The write function's result
   */
  const cachedWrite = async <T>(
    invalidationKeys: string[],
    fn: () => Promise<T>,
  ): Promise<T> => {
    // Execute the write first
    const result = await fn();

    // Then invalidate affected cache keys SYNCHRONOUSLY
    // This ensures no stale reads immediately after a write
    for (const key of invalidationKeys) {
      if (key.includes('*')) {
        // Key contains a pattern; use pattern-based invalidation
        cache.invalidatePattern(key);
      } else {
        // Exact key match
        cache.invalidateKey(key);
      }
    }

    return result;
  };

  // Return a proxy object with the same interface as ContractsService
  return {
    /**
     * Retrieves all contracts from the repository.
     */
    async getAllContracts(): Promise<Contract[]> {
      return cachedRead('contracts:list', () => service.getAllContracts());
    },

    /**
     * Retrieves a single contract by ID.
     */
    async getContractById(id: string): Promise<Contract | undefined> {
      return cachedRead(`contracts:single:${id}`, () => service.getContractById(id));
    },

    /**
     * Returns a cursor-paginated page of contracts.
     */
    async getContractsPage(
      input: CursorPaginationInput = {},
    ): Promise<any> {
      // Hash the input to create a deterministic cache key
      const inputHash = hashPaginationInput(input);
      return cachedRead(
        `contracts:page:${inputHash}`,
        () => service.getContractsPage(input),
      );
    },

    /**
     * Creates a new contract.
     * Invalidates: list cache, stats cache, all paginated results.
     */
    async createContract(data: CreateContractDto): Promise<Contract> {
      return cachedWrite(
        [
          'contracts:list',
          'contracts:stats',
          'contracts:page:**', // Invalidate all paginated results
        ],
        () => service.createContract(data),
      );
    },

    /**
     * Updates a contract.
     * Invalidates: specific contract, list cache, stats cache, all paginated results.
     */
    async updateContract(id: string, dto: UpdateContractDto): Promise<Contract> {
      return cachedWrite(
        [
          `contracts:single:${id}`,
          'contracts:list',
          'contracts:stats',
          'contracts:page:**',
        ],
        () => service.updateContract(id, dto),
      );
    },

    /**
     * Deletes a contract.
     * Invalidates: specific contract, list cache, stats cache, all paginated results.
     */
    async deleteContract(id: string): Promise<void> {
      return cachedWrite(
        [
          `contracts:single:${id}`,
          'contracts:list',
          'contracts:stats',
          'contracts:page:**',
        ],
        () => service.deleteContract(id),
      );
    },

    /**
     * Retrieves contract statistics.
     */
    async getContractStats(): Promise<any> {
      return cachedRead('contracts:stats', () => service.getContractStats());
    },

    /**
     * Retrieves policy bounds.
     * Immutable, never invalidated.
     */
    getBounds(): any {
      // Note: getBounds() is synchronous in the underlying service.
      // Cache it anyway for consistency, even though it never changes.
      const cached = cache.get('contracts:bounds');
      if (cached !== undefined) {
        config.metricsService?.recordCacheHit('contracts');
        return cached;
      }
      const result = service.getBounds();
      cache.set('contracts:bounds', result);
      return result;
    },
  } as ContractsService;
}

/**
 * Deterministically hashes pagination input for cache key generation.
 * Two identical inputs must produce identical hashes; different inputs should
 * produce different hashes (though collisions are acceptable).
 *
 * @internal
 */
function hashPaginationInput(input: CursorPaginationInput): string {
  // For now, use a simple string representation. In production, consider:
  // - Using SHA-256 for inputs containing many fields
  // - Normalizing sort order, filter order, etc. for consistency
  const parts = [
    input.limit ?? 'default',
    input.cursor ?? 'nocursor',
  ];
  return parts.join('_');
}
