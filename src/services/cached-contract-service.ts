import type { CacheStore } from '../cache/cache-store';
import type { CacheConfig } from '../config/cache-config';
import type { ContractRecord, CreateContractInput } from '../types/contract';
import type { ContractServicePort } from './contract-service';

/**
 * @notice Cache-enabled decorator for contract read operations.
 * @dev The cache is intentionally applied only to shared read-mostly data.
 *      Writes always go to the source of truth first, then invalidate
 *      affected cache keys.
 */
export class CachedContractService implements ContractServicePort {
  /**
   * @param source Source-of-truth contract service.
   * @param cacheStore Cache implementation.
   * @param cacheConfig Cache configuration.
   */
  constructor(
    private readonly source: ContractServicePort,
    private readonly cacheStore: CacheStore,
    private readonly cacheConfig: CacheConfig,
  ) {}

  /**
   * @inheritdoc
   */
  listContracts(): ContractRecord[] {
    return this.readThrough<ContractRecord[]>(buildContractsListKey(), () =>
      this.source.listContracts(),
    );
  }

  /**
   * @inheritdoc
   */
  getContractById(id: string): ContractRecord | undefined {
    return this.readThrough<ContractRecord | undefined>(buildContractDetailKey(id), () =>
      this.source.getContractById(id),
    );
  }

  /**
   * @inheritdoc
   */
  createContract(input: CreateContractInput): ContractRecord {
    const created = this.source.createContract(input);
    this.invalidateAfterWrite(created.id);
    return created;
  }

  /**
   * @notice Read from cache first, then safely fall back to source on miss/failure.
   * @param key Deterministic cache key.
   * @param loader Source-of-truth loader.
   */
  private readThrough<T>(key: string, loader: () => T): T {
    if (this.cacheConfig.enabled) {
      try {
        const cachedValue = this.cacheStore.get<T>(key);
        if (cachedValue !== undefined) {
          return cachedValue;
        }
      } catch {
        // Graceful fallback to the source of truth on cache read failure.
      }
    }

    const loadedValue = loader();

    if (this.cacheConfig.enabled) {
      try {
        this.cacheStore.set(key, loadedValue, this.cacheConfig.ttlSeconds);
      } catch {
        // Ignore cache write failure to preserve correctness.
      }
    }

    return loadedValue;
  }

  /**
   * @notice Invalidate read cache entries affected by a write.
   * @param contractId Contract identifier affected by the write.
   */
  private invalidateAfterWrite(contractId: string): void {
    if (!this.cacheConfig.enabled) {
      return;
    }

    try {
      this.cacheStore.delete(buildContractsListKey());
      this.cacheStore.delete(buildContractDetailKey(contractId));
    } catch {
      // Cache invalidation failure should not break the write path.
    }
  }
}

/**
 * @notice Build the cache key for the contracts collection.
 */
export function buildContractsListKey(): string {
  return 'contracts:list';
}

/**
 * @notice Build the cache key for a contract detail lookup.
 * @param id Contract identifier.
 */
export function buildContractDetailKey(id: string): string {
  return `contracts:detail:${encodeURIComponent(id)}`;
}
