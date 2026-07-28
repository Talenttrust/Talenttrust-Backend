import { Registry } from 'prom-client';
import {
  ContractCacheService,
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_CACHE_SWR_MS,
  DEFAULT_CACHE_MAX_ENTRIES,
} from './contractCache.service';
import type { Contract } from '../db/types';
import type { CursorPage } from '../contracts/cursor.types';

describe('ContractCacheService', () => {
  let cacheService: ContractCacheService;
  let registry: Registry;

  const sampleContract: Contract = {
    id: 'c1',
    title: 'Test Contract',
    clientId: 'client-1',
    freelancerId: '',
    amount: 1000,
    status: 'draft',
    version: 0,
    createdAt: '2024-01-01T00:00:00.000Z',
  };

  const samplePage: CursorPage<Contract> = {
    data: [sampleContract],
    nextCursor: null,
    hasNextPage: false,
    limit: 20,
  };

  const sampleStats = {
    total: 1,
    totalBudget: 1000,
    byStatus: { draft: 1 },
  };

  beforeEach(() => {
    registry = new Registry();
    cacheService = new ContractCacheService({}, registry);
  });

  describe('getContractById', () => {
    it('returns data from fetcher on cold cache (miss)', async () => {
      const fetcher = jest.fn().mockResolvedValue(sampleContract);

      const result = await cacheService.getContractById('c1', fetcher);

      expect(result).toEqual(sampleContract);
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('returns cached data on subsequent read (hit) without calling fetcher', async () => {
      const fetcher = jest.fn().mockResolvedValue(sampleContract);

      await cacheService.getContractById('c1', fetcher);
      const result = await cacheService.getContractById('c1', fetcher);

      expect(result).toEqual(sampleContract);
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('returns undefined when fetcher returns undefined', async () => {
      const fetcher = jest.fn().mockResolvedValue(undefined);

      const result = await cacheService.getContractById('missing', fetcher);

      expect(result).toBeUndefined();
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('calls fetcher again after invalidation', async () => {
      const fetcher = jest.fn()
        .mockResolvedValueOnce(sampleContract)
        .mockResolvedValueOnce({ ...sampleContract, title: 'Updated' });

      await cacheService.getContractById('c1', fetcher);
      cacheService.invalidateContract('c1');
      const result = await cacheService.getContractById('c1', fetcher);

      expect(result?.title).toBe('Updated');
      expect(fetcher).toHaveBeenCalledTimes(2);
    });
  });

  describe('getAllContracts', () => {
    it('returns data from fetcher on cold cache (miss)', async () => {
      const fetcher = jest.fn().mockResolvedValue([sampleContract]);

      const result = await cacheService.getAllContracts(fetcher);

      expect(result).toEqual([sampleContract]);
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('returns cached data on hit without calling fetcher', async () => {
      const fetcher = jest.fn().mockResolvedValue([sampleContract]);

      await cacheService.getAllContracts(fetcher);
      const result = await cacheService.getAllContracts(fetcher);

      expect(result).toEqual([sampleContract]);
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('calls fetcher again after invalidation', async () => {
      const fetcher = jest.fn().mockResolvedValue([sampleContract]);
      const updated = { ...sampleContract, title: 'New Title' };

      await cacheService.getAllContracts(fetcher);
      cacheService.invalidateLists();
      const fetcher2 = jest.fn().mockResolvedValue([updated]);
      const result = await cacheService.getAllContracts(fetcher2);

      expect(result).toEqual([updated]);
      expect(fetcher2).toHaveBeenCalledTimes(1);
    });
  });

  describe('getContractsPage', () => {
    it('returns data from fetcher on cold cache', async () => {
      const fetcher = jest.fn().mockResolvedValue(samplePage);

      const result = await cacheService.getContractsPage({ limit: 20 }, fetcher);

      expect(result).toEqual(samplePage);
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('uses different cache keys for different cursor inputs', async () => {
      const page1: CursorPage<Contract> = { data: [sampleContract], nextCursor: 'cursor-2', hasNextPage: true, limit: 1 };
      const page2: CursorPage<Contract> = { data: [{ ...sampleContract, id: 'c2' }], nextCursor: null, hasNextPage: false, limit: 1 };

      const fetcher1 = jest.fn().mockResolvedValue(page1);
      const fetcher2 = jest.fn().mockResolvedValue(page2);

      await cacheService.getContractsPage({ limit: 1 }, fetcher1);
      await cacheService.getContractsPage({ limit: 1, cursor: 'cursor-2' }, fetcher2);

      expect(fetcher1).toHaveBeenCalledTimes(1);
      expect(fetcher2).toHaveBeenCalledTimes(1);

      const hit1 = await cacheService.getContractsPage({ limit: 1 }, jest.fn());
      const hit2 = await cacheService.getContractsPage({ limit: 1, cursor: 'cursor-2' }, jest.fn());

      expect(hit1).toEqual(page1);
      expect(hit2).toEqual(page2);
    });
  });

  describe('getContractStats', () => {
    it('returns data from fetcher on cold cache', async () => {
      const fetcher = jest.fn().mockResolvedValue(sampleStats);

      const result = await cacheService.getContractStats(fetcher);

      expect(result).toEqual(sampleStats);
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('returns cached stats on hit without calling fetcher', async () => {
      const fetcher = jest.fn().mockResolvedValue(sampleStats);

      await cacheService.getContractStats(fetcher);
      const result = await cacheService.getContractStats(fetcher);

      expect(result).toEqual(sampleStats);
      expect(fetcher).toHaveBeenCalledTimes(1);
    });
  });

  describe('invalidation', () => {
    it('invalidateContract removes only the specific contract key', async () => {
      const fetcherA = jest.fn().mockResolvedValue({ ...sampleContract, id: 'a' });
      const fetcherB = jest.fn().mockResolvedValue({ ...sampleContract, id: 'b' });

      await cacheService.getContractById('a', fetcherA);
      await cacheService.getContractById('b', fetcherB);

      cacheService.invalidateContract('a');

      const refetchA = jest.fn().mockResolvedValue({ ...sampleContract, id: 'a', title: 'Refetched' });
      const hitB = jest.fn();

      await cacheService.getContractById('a', refetchA);
      const resultB = await cacheService.getContractById('b', hitB);

      expect(refetchA).toHaveBeenCalledTimes(1);
      expect(hitB).not.toHaveBeenCalled();
      expect(resultB?.id).toBe('b');
    });

    it('invalidateLists removes only the list keys, not individual contract keys', async () => {
      const contractFetcher = jest.fn().mockResolvedValue(sampleContract);
      const listFetcher = jest.fn().mockResolvedValue([sampleContract]);

      await cacheService.getContractById('c1', contractFetcher);
      await cacheService.getAllContracts(listFetcher);

      cacheService.invalidateLists();

      const listFetcher2 = jest.fn().mockResolvedValue([]);
      const listResult = await cacheService.getAllContracts(listFetcher2);
      expect(listFetcher2).toHaveBeenCalledTimes(1);
      expect(listResult).toEqual([]);

      const contractHit = jest.fn();
      const contractResult = await cacheService.getContractById('c1', contractHit);
      expect(contractHit).not.toHaveBeenCalled();
      expect(contractResult).toEqual(sampleContract);
    });

    it('invalidateAll clears entire cache', async () => {
      await cacheService.getContractById('c1', jest.fn().mockResolvedValue(sampleContract));
      await cacheService.getAllContracts(jest.fn().mockResolvedValue([sampleContract]));

      cacheService.invalidateAll();
      expect(cacheService.size).toBe(0);

      const f1 = jest.fn().mockResolvedValue(sampleContract);
      const f2 = jest.fn().mockResolvedValue([]);
      await cacheService.getContractById('c1', f1);
      await cacheService.getAllContracts(f2);

      expect(f1).toHaveBeenCalledTimes(1);
      expect(f2).toHaveBeenCalledTimes(1);
    });
  });

  describe('metrics tracking', () => {
    it('increments hit counter on cache hit', async () => {
      const fetcher = jest.fn().mockResolvedValue(sampleContract);

      await cacheService.getContractById('c1', fetcher);
      await cacheService.getContractById('c1', fetcher);

      const json = await registry.getMetricsAsJSON();
      const hitMetric = json.find((m) => m.name === 'contract_cache_hits_total');
      expect(hitMetric).toBeDefined();
      const hitValue = (hitMetric!.values as any[])[0]?.value;
      expect(hitValue).toBe(1);
    });

    it('increments miss counter on cache miss', async () => {
      const fetcher = jest.fn().mockResolvedValue(sampleContract);

      await cacheService.getContractById('c1', fetcher);

      const json = await registry.getMetricsAsJSON();
      const missMetric = json.find((m) => m.name === 'contract_cache_misses_total');
      expect(missMetric).toBeDefined();
      const missValue = (missMetric!.values as any[])[0]?.value;
      expect(missValue).toBe(1);
    });

    it('increments invalidation counter on invalidate', async () => {
      cacheService.invalidateContract('c1');

      const json = await registry.getMetricsAsJSON();
      const invMetric = json.find((m) => m.name === 'contract_cache_invalidations_total');
      expect(invMetric).toBeDefined();
      const invValue = (invMetric!.values as any[])[0]?.value;
      expect(invValue).toBe(1);
    });

    it('cache_entries gauge reflects current size', async () => {
      await cacheService.getContractById('c1', jest.fn().mockResolvedValue(sampleContract));
      await cacheService.getContractById('c2', jest.fn().mockResolvedValue(sampleContract));

      const json = await registry.getMetricsAsJSON();
      const gaugeMetric = json.find((m) => m.name === 'contract_cache_entries');
      expect(gaugeMetric).toBeDefined();

      const entryValue = (gaugeMetric!.values as any[])?.find((v: any) => v.value > 0);
      expect(entryValue?.value).toBe(2);
    });
  });

  describe('config-driven defaults', () => {
    it('uses default values when no config is provided', () => {
      expect(DEFAULT_CACHE_TTL_MS).toBe(5000);
      expect(DEFAULT_CACHE_SWR_MS).toBe(30000);
      expect(DEFAULT_CACHE_MAX_ENTRIES).toBe(500);
    });

    it('applies custom config values', () => {
      const svc = new ContractCacheService({
        ttlMs: 1000,
        swrMs: 5000,
        maxEntries: 10,
      });
      expect(svc.size).toBe(0);
    });

    it('evicts entries when maxEntries is exceeded', async () => {
      const svc = new ContractCacheService({ maxEntries: 2 });

      await svc.getContractById('a', jest.fn().mockResolvedValue({ ...sampleContract, id: 'a' }));
      await svc.getContractById('b', jest.fn().mockResolvedValue({ ...sampleContract, id: 'b' }));
      expect(svc.size).toBe(2);

      await svc.getContractById('c', jest.fn().mockResolvedValue({ ...sampleContract, id: 'c' }));
      expect(svc.size).toBe(2);

      const refetchA = jest.fn().mockResolvedValue({ ...sampleContract, id: 'a', title: 'Evicted-refetched' });
      const resultA = await svc.getContractById('a', refetchA);
      expect(refetchA).toHaveBeenCalledTimes(1);
      expect(resultA?.title).toBe('Evicted-refetched');
    });
  });

  describe('edge cases', () => {
    it('handles empty array from getAllContracts', async () => {
      const fetcher = jest.fn().mockResolvedValue([]);

      const result = await cacheService.getAllContracts(fetcher);

      expect(result).toEqual([]);
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('handles empty page from getContractsPage', async () => {
      const emptyPage: CursorPage<Contract> = { data: [], nextCursor: null, hasNextPage: false, limit: 20 };
      const fetcher = jest.fn().mockResolvedValue(emptyPage);

      const result = await cacheService.getContractsPage({}, fetcher);

      expect(result.data).toEqual([]);
    });

    it('handles null cursor in getContractsPage', async () => {
      const fetcher = jest.fn().mockResolvedValue(samplePage);

      await cacheService.getContractsPage({ limit: 20 }, fetcher);
      const hit = await cacheService.getContractsPage({ limit: 20 }, jest.fn());

      expect(hit).toEqual(samplePage);
    });

    it('propagates fetcher errors', async () => {
      const error = new Error('upstream failure');
      const fetcher = jest.fn().mockRejectedValue(error);

      await expect(cacheService.getContractById('c1', fetcher)).rejects.toThrow('upstream failure');
    });
  });
});
