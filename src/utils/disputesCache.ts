import { Counter, register as promRegister } from 'prom-client';
import { SWRCache } from './swrCache';

export interface DisputesCacheConfig {
  ttlMs: number;
  swrMs: number;
  maxEntries: number;
}

const DEFAULT_TTL_MS = 5_000;
const DEFAULT_SWR_MS = 30_000;
const DEFAULT_MAX_ENTRIES = 100;

export const disputesCacheHitsTotal = new Counter({
  name: 'disputes_cache_hits_total',
  help: 'Total number of disputes cache hits',
  labelNames: ['type'] as const,
  registers: [promRegister],
});

export const disputesCacheMissesTotal = new Counter({
  name: 'disputes_cache_misses_total',
  help: 'Total number of disputes cache misses',
  labelNames: ['type'] as const,
  registers: [promRegister],
});

export class DisputesCache {
  private cache: SWRCache;
  private options: { ttlMs: number; swrMs: number };

  constructor(config?: Partial<DisputesCacheConfig>) {
    this.cache = new SWRCache({
      maxEntries: config?.maxEntries ?? DEFAULT_MAX_ENTRIES,
    });
    this.options = {
      ttlMs: config?.ttlMs ?? DEFAULT_TTL_MS,
      swrMs: config?.swrMs ?? DEFAULT_SWR_MS,
    };
  }

  async getOrFetchList<T>(fetcher: () => Promise<T>): Promise<{ data: T; source: 'cache_fresh' | 'cache_stale' | 'upstream' }> {
    const result = await this.cache.get('disputes:list', fetcher, this.options);
    if (result.source === 'cache_fresh' || result.source === 'cache_stale') {
      disputesCacheHitsTotal.inc({ type: 'list' });
    } else {
      disputesCacheMissesTotal.inc({ type: 'list' });
    }
    return { data: result.data as T, source: result.source };
  }

  async getOrFetchDispute<T>(id: string, fetcher: () => Promise<T>): Promise<{ data: T; source: 'cache_fresh' | 'cache_stale' | 'upstream' }> {
    const result = await this.cache.get(`disputes:${id}`, fetcher, this.options);
    if (result.source === 'cache_fresh' || result.source === 'cache_stale') {
      disputesCacheHitsTotal.inc({ type: 'dispute' });
    } else {
      disputesCacheMissesTotal.inc({ type: 'dispute' });
    }
    return { data: result.data as T, source: result.source };
  }

  invalidateList(): void {
    this.cache.delete('disputes:list');
  }

  invalidateDispute(id: string): void {
    this.cache.delete(`disputes:${id}`);
  }

  get size(): number {
    return this.cache.size;
  }

  get maxEntries(): number {
    return this.cache.maxEntries;
  }
}
