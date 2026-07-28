import { Counter, Gauge, Registry } from 'prom-client';
import { SWRCache } from '../utils/swrCache';
import type { Contract } from '../db/types';
import type { CursorPage, CursorPaginationInput } from '../contracts/cursor.types';

export const DEFAULT_CACHE_TTL_MS = 5_000;
export const DEFAULT_CACHE_SWR_MS = 30_000;
export const DEFAULT_CACHE_MAX_ENTRIES = 500;

export interface ContractCacheConfig {
  ttlMs?: number;
  swrMs?: number;
  maxEntries?: number;
}

const CACHE_KEY_CONTRACT = (id: string) => `contract:${id}`;
const CACHE_KEY_ALL_CONTRACTS = 'contracts:all';
const CACHE_KEY_CONTRACTS_PAGE = (cursor?: string, limit?: number) =>
  `contracts:page:${cursor ?? ''}:${limit ?? ''}`;
const CACHE_KEY_STATS = 'contracts:stats';

export type OperationLabel = 'getContractById' | 'getAllContracts' | 'getContractsPage' | 'getContractStats';

export class ContractCacheService {
  private cache: SWRCache;
  private readonly ttlMs: number;
  private readonly swrMs: number;

  public readonly cacheHitsTotal: Counter<'operation'>;
  public readonly cacheMissesTotal: Counter<'operation'>;
  public readonly cacheInvalidationsTotal: Counter<'reason'>;
  public readonly cacheEntries: Gauge;

  constructor(config: ContractCacheConfig = {}, register?: Registry) {
    this.ttlMs = config.ttlMs ?? DEFAULT_CACHE_TTL_MS;
    this.swrMs = config.swrMs ?? DEFAULT_CACHE_SWR_MS;
    this.cache = new SWRCache({ maxEntries: config.maxEntries ?? DEFAULT_CACHE_MAX_ENTRIES });

    const reg = register ?? new Registry();

    this.cacheHitsTotal = new Counter({
      name: 'contract_cache_hits_total',
      help: 'Total number of contract cache hits by operation',
      labelNames: ['operation'] as const,
      registers: [reg],
    });

    this.cacheMissesTotal = new Counter({
      name: 'contract_cache_misses_total',
      help: 'Total number of contract cache misses by operation',
      labelNames: ['operation'] as const,
      registers: [reg],
    });

    this.cacheInvalidationsTotal = new Counter({
      name: 'contract_cache_invalidations_total',
      help: 'Total number of contract cache invalidations by reason',
      labelNames: ['reason'] as const,
      registers: [reg],
    });

    this.cacheEntries = new Gauge({
      name: 'contract_cache_entries',
      help: 'Current number of entries in the contract cache',
      registers: [reg],
    });
  }

  public get size(): number {
    return this.cache.size;
  }

  private updateEntryGauge(): void {
    this.cacheEntries.set(this.cache.size);
  }

  private recordHit(operation: OperationLabel): void {
    this.cacheHitsTotal.inc({ operation });
  }

  private recordMiss(operation: OperationLabel): void {
    this.cacheMissesTotal.inc({ operation });
  }

  private recordInvalidation(reason: string): void {
    this.cacheInvalidationsTotal.inc({ reason });
  }

  async getContractById(
    id: string,
    fetcher: () => Promise<Contract | undefined>,
  ): Promise<Contract | undefined> {
    const key = CACHE_KEY_CONTRACT(id);
    const result = await this.cache.get<Contract | undefined>(key, fetcher, {
      ttlMs: this.ttlMs,
      swrMs: this.swrMs,
    });
    this.updateEntryGauge();

    if (result.source === 'cache_fresh' || result.source === 'cache_stale') {
      this.recordHit('getContractById');
    } else {
      this.recordMiss('getContractById');
    }

    return result.data;
  }

  async getAllContracts(
    fetcher: () => Promise<Contract[]>,
  ): Promise<Contract[]> {
    const key = CACHE_KEY_ALL_CONTRACTS;
    const result = await this.cache.get<Contract[]>(key, fetcher, {
      ttlMs: this.ttlMs,
      swrMs: this.swrMs,
    });
    this.updateEntryGauge();

    if (result.source === 'cache_fresh' || result.source === 'cache_stale') {
      this.recordHit('getAllContracts');
    } else {
      this.recordMiss('getAllContracts');
    }

    return result.data;
  }

  async getContractsPage(
    input: CursorPaginationInput,
    fetcher: () => Promise<CursorPage<Contract>>,
  ): Promise<CursorPage<Contract>> {
    const key = CACHE_KEY_CONTRACTS_PAGE(input.cursor, input.limit);
    const result = await this.cache.get<CursorPage<Contract>>(key, fetcher, {
      ttlMs: this.ttlMs,
      swrMs: this.swrMs,
    });
    this.updateEntryGauge();

    if (result.source === 'cache_fresh' || result.source === 'cache_stale') {
      this.recordHit('getContractsPage');
    } else {
      this.recordMiss('getContractsPage');
    }

    return result.data;
  }

  async getContractStats(
    fetcher: () => Promise<{ total: number; totalBudget: number; byStatus: Record<string, number> }>,
  ): Promise<{ total: number; totalBudget: number; byStatus: Record<string, number> }> {
    const key = CACHE_KEY_STATS;
    const result = await this.cache.get(key, fetcher, {
      ttlMs: this.ttlMs,
      swrMs: this.swrMs,
    });
    this.updateEntryGauge();

    if (result.source === 'cache_fresh' || result.source === 'cache_stale') {
      this.recordHit('getContractStats');
    } else {
      this.recordMiss('getContractStats');
    }

    return result.data;
  }

  invalidateContract(id: string): void {
    this.cache.invalidate(CACHE_KEY_CONTRACT(id));
    this.recordInvalidation('contract_update');
    this.updateEntryGauge();
  }

  invalidateLists(): void {
    this.cache.invalidate(CACHE_KEY_ALL_CONTRACTS);
    this.recordInvalidation('list_invalidation');
    this.updateEntryGauge();
  }

  invalidateAll(): void {
    this.recordInvalidation('full_clear');
    this.cache.clear();
    this.updateEntryGauge();
  }
}
