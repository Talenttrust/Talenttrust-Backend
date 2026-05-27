import { SWRCache } from '../../src/utils/swrCache';

describe('SWRCache', () => {
  let cache: SWRCache;
  const ttlMs = 1000;
  const swrMs = 5000;

  beforeEach(() => {
    cache = new SWRCache();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('should fetch from upstream on cache miss', async () => {
    const fetcher = jest.fn().mockResolvedValue('fresh-data');
    const result = await cache.get('key1', fetcher, { ttlMs, swrMs });

    expect(result).toEqual({ data: 'fresh-data', degraded: false, source: 'upstream' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('should return fresh cache if within TTL', async () => {
    const fetcher = jest.fn().mockResolvedValue('fresh-data');
    
    await cache.get('key2', fetcher, { ttlMs, swrMs });
    
    // Advance time safely within TTL
    jest.advanceTimersByTime(500);
    
    const fetcherSpy = jest.fn().mockResolvedValue('should-not-call');
    const result = await cache.get('key2', fetcherSpy, { ttlMs, swrMs });

    expect(result).toEqual({ data: 'fresh-data', degraded: false, source: 'cache_fresh' });
    expect(fetcherSpy).not.toHaveBeenCalled();
  });

  it('should return stale cache and revalidate in background within SWR window', async () => {
    const fetcher = jest.fn().mockResolvedValue('initial-data');
    await cache.get('key3', fetcher, { ttlMs, swrMs });

    // Advance time past TTL, but within SWR window
    jest.advanceTimersByTime(1500); 

    const revalidateFetcher = jest.fn().mockResolvedValue('revalidated-data');
    
    // This should return the stale data immediately
    const result = await cache.get('key3', revalidateFetcher, { ttlMs, swrMs });
    expect(result).toEqual({ data: 'initial-data', degraded: true, source: 'cache_stale' });
    
    // Flush pending promises to allow background fetch to resolve
    await Promise.resolve();
    expect(revalidateFetcher).toHaveBeenCalledTimes(1);

    // Fetch again, should now be fresh with the newly revalidated data
    const finalResult = await cache.get('key3', jest.fn(), { ttlMs, swrMs });
    expect(finalResult).toEqual({ data: 'revalidated-data', degraded: false, source: 'cache_fresh' });
  });

  it('should coalesce overlapping upstream requests', async () => {
    // A fetcher that takes time to resolve
    const fetcher = jest.fn().mockImplementation(() => {
      return new Promise(resolve => setTimeout(() => resolve('coalesced-data'), 100));
    });

    // Fire multiple concurrent gets
    const promise1 = cache.get('key4', fetcher, { ttlMs, swrMs });
    const promise2 = cache.get('key4', fetcher, { ttlMs, swrMs });
    
    jest.advanceTimersByTime(100);
    
    const [res1, res2] = await Promise.all([promise1, promise2]);
    
    expect(fetcher).toHaveBeenCalledTimes(1); // Only called once
    expect(res1.source).toBe('upstream');
    expect(res2.source).toBe('upstream');
    expect(res1.data).toBe('coalesced-data');
  });

  it('should completely refetch if SWR window has also expired', async () => {
    const fetcher = jest.fn().mockResolvedValue('initial-data');
    await cache.get('key5', fetcher, { ttlMs, swrMs });

    // Advance time way past TTL + SWR window
    jest.advanceTimersByTime(10000); 

    const finalResult = await cache.get('key5', jest.fn().mockResolvedValue('brand-new-data'), { ttlMs, swrMs });
    expect(finalResult).toEqual({ data: 'brand-new-data', degraded: false, source: 'upstream' });
  });
});