import { DisputesCache, disputesCacheHitsTotal, disputesCacheMissesTotal } from './disputesCache';

beforeEach(() => {
  disputesCacheHitsTotal.reset();
  disputesCacheMissesTotal.reset();
});

describe('DisputesCache', () => {
  let cache: DisputesCache;

  beforeEach(() => {
    cache = new DisputesCache({ ttlMs: 5000, swrMs: 30000, maxEntries: 100 });
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('cold cache (miss)', () => {
    it('calls the fetcher on first list request', async () => {
      const fetcher = jest.fn().mockResolvedValue({ disputes: [], total: 0 });
      const result = await cache.getOrFetchList(fetcher);
      expect(result.data).toEqual({ disputes: [], total: 0 });
      expect(result.source).toBe('upstream');
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('calls the fetcher on first dispute request', async () => {
      const fetcher = jest.fn().mockResolvedValue({ dispute: { id: 'd1', status: 'open' } });
      const result = await cache.getOrFetchDispute('d1', fetcher);
      expect(result.data).toEqual({ dispute: { id: 'd1', status: 'open' } });
      expect(result.source).toBe('upstream');
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('increments miss counter on cold cache', async () => {
      const before = Number((await disputesCacheMissesTotal.get()).values[0]?.value ?? 0);
      await cache.getOrFetchList(() => Promise.resolve({ disputes: [] }));
      const after = Number((await disputesCacheMissesTotal.get()).values[0]?.value ?? 0);
      expect(after).toBe(before + 1);
    });
  });

  describe('cache hit', () => {
    it('returns cached list without calling fetcher within TTL', async () => {
      const fetcher = jest.fn().mockResolvedValue({ disputes: [], total: 0 });
      await cache.getOrFetchList(fetcher);
      const result = await cache.getOrFetchList(fetcher);
      expect(result.source).toBe('cache_fresh');
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('returns cached dispute without calling fetcher within TTL', async () => {
      const fetcher = jest.fn().mockResolvedValue({ dispute: { id: 'd1', status: 'open' } });
      await cache.getOrFetchDispute('d1', fetcher);
      const result = await cache.getOrFetchDispute('d1', fetcher);
      expect(result.source).toBe('cache_fresh');
      expect(result.data).toEqual({ dispute: { id: 'd1', status: 'open' } });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('increments hit counter on cache hit', async () => {
      await cache.getOrFetchList(() => Promise.resolve({ disputes: [] }));
      const before = Number((await disputesCacheHitsTotal.get()).values[0]?.value ?? 0);
      await cache.getOrFetchList(() => Promise.resolve({ disputes: [] }));
      const after = Number((await disputesCacheHitsTotal.get()).values[0]?.value ?? 0);
      expect(after).toBe(before + 1);
    });

    it('returns stale data within SWR window and revalidates in background', async () => {
      const seed = jest.fn().mockResolvedValue({ disputes: ['v1'] });
      await cache.getOrFetchList(seed);
      jest.advanceTimersByTime(6000);
      const reval = jest.fn().mockResolvedValue({ disputes: ['v2'] });
      const result = await cache.getOrFetchList(reval);
      expect(result.source).toBe('cache_stale');
      expect(result.data).toEqual({ disputes: ['v1'] });
      await Promise.resolve();
      expect(reval).toHaveBeenCalledTimes(1);
    });
  });

  describe('write invalidation', () => {
    it('invalidates list cache on POST', async () => {
      const fetcher = jest.fn().mockResolvedValue({ disputes: ['original'] });
      await cache.getOrFetchList(fetcher);
      expect(fetcher).toHaveBeenCalledTimes(1);
      cache.invalidateList();
      const result = await cache.getOrFetchList(fetcher);
      expect(result.source).toBe('upstream');
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it('invalidates dispute cache on PATCH', async () => {
      const fetcher = jest.fn().mockResolvedValue({ dispute: { id: 'd1', status: 'open' } });
      await cache.getOrFetchDispute('d1', fetcher);
      expect(fetcher).toHaveBeenCalledTimes(1);
      cache.invalidateDispute('d1');
      const result = await cache.getOrFetchDispute('d1', fetcher);
      expect(result.source).toBe('upstream');
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it('invalidates dispute for a different id independently', async () => {
      const fetcherD1 = jest.fn().mockResolvedValue({ dispute: { id: 'd1' } });
      const fetcherD2 = jest.fn().mockResolvedValue({ dispute: { id: 'd2' } });
      await cache.getOrFetchDispute('d1', fetcherD1);
      await cache.getOrFetchDispute('d2', fetcherD2);
      cache.invalidateDispute('d1');
      const r1 = await cache.getOrFetchDispute('d1', fetcherD1);
      const r2 = await cache.getOrFetchDispute('d2', fetcherD2);
      expect(r1.source).toBe('upstream');
      expect(r2.source).toBe('cache_fresh');
      expect(fetcherD1).toHaveBeenCalledTimes(2);
      expect(fetcherD2).toHaveBeenCalledTimes(1);
    });

    it('list and dispute caches are independent', async () => {
      const listFetcher = jest.fn().mockResolvedValue({ disputes: [] });
      const disputeFetcher = jest.fn().mockResolvedValue({ dispute: { id: 'd1' } });
      await cache.getOrFetchList(listFetcher);
      await cache.getOrFetchDispute('d1', disputeFetcher);
      cache.invalidateList();
      const listResult = await cache.getOrFetchList(listFetcher);
      const disputeResult = await cache.getOrFetchDispute('d1', disputeFetcher);
      expect(listResult.source).toBe('upstream');
      expect(disputeResult.source).toBe('cache_fresh');
    });

    it('invalidates both list and dispute on PATCH', async () => {
      const listFetcher = jest.fn().mockResolvedValue({ disputes: [] });
      const disputeFetcher = jest.fn().mockResolvedValue({ dispute: { id: 'd1' } });
      await cache.getOrFetchList(listFetcher);
      await cache.getOrFetchDispute('d1', disputeFetcher);
      cache.invalidateList();
      cache.invalidateDispute('d1');
      const listResult = await cache.getOrFetchList(listFetcher);
      const disputeResult = await cache.getOrFetchDispute('d1', disputeFetcher);
      expect(listResult.source).toBe('upstream');
      expect(disputeResult.source).toBe('upstream');
    });
  });

  describe('TTL expiration', () => {
    it('refetches after TTL expires', async () => {
      const fetcher = jest.fn().mockResolvedValue({ disputes: ['old'] });
      await cache.getOrFetchList(fetcher);
      jest.advanceTimersByTime(5001);
      const result = await cache.getOrFetchList(fetcher);
      expect(result.data).toEqual({ disputes: ['old'] });
      expect(result.source).toBe('cache_stale');
      await Promise.resolve();
      const freshResult = await cache.getOrFetchList(fetcher);
      expect(freshResult.source).toBe('cache_fresh');
    });

    it('fully refetches after SWR window expires', async () => {
      const fetcher = jest.fn()
        .mockResolvedValueOnce({ disputes: ['old'] })
        .mockResolvedValueOnce({ disputes: ['new'] });
      await cache.getOrFetchList(fetcher);
      jest.advanceTimersByTime(40000);
      const result = await cache.getOrFetchList(fetcher);
      expect(result.source).toBe('upstream');
      expect(result.data).toEqual({ disputes: ['new'] });
    });
  });

  describe('LRU eviction', () => {
    it('enforces maxEntries bound', async () => {
      const smallCache = new DisputesCache({ maxEntries: 3, ttlMs: 60000, swrMs: 0 });
      for (let i = 0; i < 3; i++) {
        await smallCache.getOrFetchDispute(`d${i}`, () => Promise.resolve({ dispute: { id: `d${i}` } }));
      }
      expect(smallCache.size).toBe(3);
      await smallCache.getOrFetchDispute('d4', () => Promise.resolve({ dispute: { id: 'd4' } }));
      expect(smallCache.size).toBe(3);
      const result = await smallCache.getOrFetchDispute('d0', () => Promise.resolve({ dispute: { id: 'd0-evicted' } }));
      expect(result.source).toBe('upstream');
      expect(result.data).toEqual({ dispute: { id: 'd0-evicted' } });
    });

    it('defaults maxEntries to 100', () => {
      const defaultCache = new DisputesCache();
      expect(defaultCache.maxEntries).toBe(100);
    });
  });

  describe('config', () => {
    it('accepts custom TTL and maxEntries', () => {
      const custom = new DisputesCache({ ttlMs: 1000, maxEntries: 10 });
      expect(custom.maxEntries).toBe(10);
    });
  });
});
