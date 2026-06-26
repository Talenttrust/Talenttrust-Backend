import { SWRCache, DEFAULT_MAX_ENTRIES } from './swrCache';

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

describe('SWRCache with bounded LRU eviction (#416)', () => {
  let cache: SWRCache;

  beforeEach(() => {
    cache = new SWRCache();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('defaults maxEntries to a sane cap of 1000', () => {
    expect(DEFAULT_MAX_ENTRIES).toBe(1000);
    expect(cache.maxEntries).toBe(1000);
  });

  it('respects a configurable maxEntries', () => {
    cache = new SWRCache({ maxEntries: 7 });
    expect(cache.maxEntries).toBe(7);
  });

  it('throws RangeError on non-positive or non-integer maxEntries', () => {
    expect(() => new SWRCache({ maxEntries: 0 })).toThrow(RangeError);
    expect(() => new SWRCache({ maxEntries: -1 })).toThrow(RangeError);
    expect(() => new SWRCache({ maxEntries: 1.5 })).toThrow(RangeError);
    expect(() => new SWRCache({ maxEntries: Number.NaN })).toThrow(RangeError);
    expect(() => new SWRCache({ maxEntries: Number.POSITIVE_INFINITY })).toThrow(RangeError);
  });

  it('keeps the cap of 100 by treating the default as a real bound', async () => {
    // Smaller default would be impractical to fill; we instead set maxEntries to
    // a tiny value so the same invariant is observable in microseconds.
    cache = new SWRCache({ maxEntries: 100 });

    for (let i = 0; i < 100; i += 1) {
      await cache.get(`k${i}`, () => Promise.resolve(`v${i}`), { ttlMs: 60_000, swrMs: 0 });
    }
    expect(cache.size).toBe(100);

    // Trigger one more write — cap enforced, oldest (k0) is gone.
    await cache.get(`k100`, () => Promise.resolve(`v100`), { ttlMs: 60_000, swrMs: 0 });
    expect(cache.size).toBe(100);

    // k0 is no longer cached — must be refetched.
    const reread0 = await cache.get('k0', () => Promise.resolve('v0-redo'), { ttlMs: 60_000, swrMs: 0 });
    expect(reread0.source).toBe('upstream');
  });

  it('keeps the most recent N entries and drops the oldest on overflow', async () => {
    cache = new SWRCache({ maxEntries: 3 });

    await cache.get('a', () => Promise.resolve('vA'), { ttlMs: 60_000, swrMs: 0 });
    await cache.get('b', () => Promise.resolve('vB'), { ttlMs: 60_000, swrMs: 0 });
    await cache.get('c', () => Promise.resolve('vC'), { ttlMs: 60_000, swrMs: 0 });
    expect(cache.size).toBe(3);

    await cache.get('d', () => Promise.resolve('vD'), { ttlMs: 60_000, swrMs: 0 });
    expect(cache.size).toBe(3);

    // b, c, d remain; a was evicted (it was the oldest insertion at the moment
    // of the overflow write).
    const readA = await cache.get('a', () => Promise.resolve('vA-replacement'), { ttlMs: 60_000, swrMs: 0 });
    expect(readA.source).toBe('upstream');
    const readD = await cache.get('d', () => Promise.resolve('irrelevant'), { ttlMs: 60_000, swrMs: 0 });
    expect(readD.source).toBe('cache_fresh');
    expect(readD.data).toBe('vD');
  });

  it('reorders LRU on read access so the touched key survives a later overflow', async () => {
    cache = new SWRCache({ maxEntries: 3 });

    // Sequential inserts match the rest of the suite. See comment above
    // on `keeps the most recent N entries and drops the oldest on overflow`
    // for the basic FRO rule; this test adds touch-on-read promotion on top.
    await cache.get('a', () => Promise.resolve('vA'), { ttlMs: 60_000, swrMs: 0 });
    await cache.get('b', () => Promise.resolve('vB'), { ttlMs: 60_000, swrMs: 0 });
    await cache.get('c', () => Promise.resolve('vC'), { ttlMs: 60_000, swrMs: 0 });
    expect(cache.size).toBe(3);

    // Touch 'a' on a fresh hit — delete-then-set reorders to [b, c, a].
    const readA = await cache.get('a', () => Promise.resolve('vA-new'), { ttlMs: 60_000, swrMs: 0 });
    expect(readA.source).toBe('cache_fresh');
    expect(readA.data).toBe('vA');

    // Insert 'd': cap exceeded, the LRU-oldest (now 'b') is evicted.
    // Order becomes [c, a, d]. Cross-reference: test 6 (above) verifies
    // that the LRU-oldest at the moment of overflow is the eviction victim.
    await cache.get('d', () => Promise.resolve('vD'), { ttlMs: 60_000, swrMs: 0 });
    expect(cache.size).toBe(3);

    // Survivors must still be cache_fresh; touching them on read does not
    // push the cache over its cap (the entries are already present).
    const stillA = await cache.get('a', () => Promise.resolve('nope'), { ttlMs: 60_000, swrMs: 0 });
    expect(stillA.source).toBe('cache_fresh');
    expect(stillA.data).toBe('vA');

    const stillC = await cache.get('c', () => Promise.resolve('nope'), { ttlMs: 60_000, swrMs: 0 });
    expect(stillC.source).toBe('cache_fresh');
    expect(stillC.data).toBe('vC');

    const stillD = await cache.get('d', () => Promise.resolve('nope'), { ttlMs: 60_000, swrMs: 0 });
    expect(stillD.source).toBe('cache_fresh');
    expect(stillD.data).toBe('vD');
  });

  it('enforces cap when maxEntries is 1', async () => {
    cache = new SWRCache({ maxEntries: 1 });

    await cache.get('a', () => Promise.resolve('vA'), { ttlMs: 60_000, swrMs: 0 });
    await cache.get('b', () => Promise.resolve('vB'), { ttlMs: 60_000, swrMs: 0 });
    await cache.get('c', () => Promise.resolve('vC'), { ttlMs: 60_000, swrMs: 0 });
    expect(cache.size).toBe(1);

    const readC = await cache.get('c', () => Promise.resolve('never-called'), { ttlMs: 60_000, swrMs: 0 });
    expect(readC.source).toBe('cache_fresh');
    expect(readC.data).toBe('vC');
  });

  it('exposes the current size before, during, and after eviction', async () => {
    cache = new SWRCache({ maxEntries: 2 });
    expect(cache.size).toBe(0);

    await cache.get('a', () => Promise.resolve('vA'), { ttlMs: 60_000, swrMs: 0 });
    expect(cache.size).toBe(1);

    await cache.get('b', () => Promise.resolve('vB'), { ttlMs: 60_000, swrMs: 0 });
    expect(cache.size).toBe(2);

    // At cap: another write must NOT push size past 2.
    await cache.get('c', () => Promise.resolve('vC'), { ttlMs: 60_000, swrMs: 0 });
    expect(cache.size).toBe(2);
  });

  it('does not corrupt in-flight revalidation when the cache entry is evicted mid-flight', async () => {
    // Real timers here: we want to assert the revalidate promise resolves
    // and writes back after eviction, even though the cache entry was
    // displaced while the upstream request was still pending.
    jest.useRealTimers();

    cache = new SWRCache({ maxEntries: 2 });

    // k1 has a short TTL; k2 has the long default so it stays fresh.
    await cache.get('k1', () => Promise.resolve('v1-initial'), { ttlMs: 1, swrMs: 60_000 });
    await cache.get('k2', () => Promise.resolve('v2'), { ttlMs: 60_000, swrMs: 0 });
    expect(cache.size).toBe(2);

    // Wait past k1's TTL so it becomes stale.
    await new Promise((resolve) => setTimeout(resolve, 10));

    // A slow revalidator for k1: returns 'v1-new' after 30ms.
    const reFetcher = jest.fn(
      () =>
        new Promise<string>((resolve) => {
          setTimeout(() => resolve('v1-new'), 30);
        }),
    );

    const staleCall = await cache.get('k1', reFetcher, { ttlMs: 1, swrMs: 60_000 });
    expect(staleCall.source).toBe('cache_stale');
    expect(staleCall.data).toBe('v1-initial');

    // While k1's revalidation is in flight, push pressure: add k3, then k4.
    await cache.get('k3', () => Promise.resolve('v3'), { ttlMs: 60_000, swrMs: 0 });
    expect(cache.size).toBeLessThanOrEqual(2);

    await cache.get('k4', () => Promise.resolve('v4'), { ttlMs: 60_000, swrMs: 0 });
    expect(cache.size).toBeLessThanOrEqual(2);

    // Wait long enough for the in-flight k1 revalidation to resolve.
    await new Promise((resolve) => setTimeout(resolve, 60));

    // The revalidator was called exactly once (coalescing still held during
    // the eviction pressure) and its return value landed back in the cache.
    expect(reFetcher).toHaveBeenCalledTimes(1);

    const postReread = await cache.get('k1', () => Promise.resolve('never-called'), {
      ttlMs: 60_000,
      swrMs: 0,
    });
    expect(postReread.source).toBe('cache_fresh');
    expect(postReread.data).toBe('v1-new');

    // Final invariant: the cap is still respected after the revalidator wrote back.
    expect(cache.size).toBeLessThanOrEqual(2);
  });

  it('cleans activeFetches bookkeeping when fetcher rejects and lets the next call refetch', async () => {
    jest.useRealTimers();

    const c = new SWRCache();
    const failing = jest.fn(
      () =>
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('upstream-down')), 10),
        ),
    );

    // Two concurrent gets on the same key: the fetcher must only run once
    // (true coalescing), and BOTH callers reject from the same promise.
    const p1 = c.get('k', failing, { ttlMs: 60_000, swrMs: 0 });
    const p2 = c.get('k', failing, { ttlMs: 60_000, swrMs: 0 });
    await expect(p1).rejects.toThrow('upstream-down');
    await expect(p2).rejects.toThrow('upstream-down');
    expect(failing).toHaveBeenCalledTimes(1);

    // After the rejection unwinds activeFetches, a follow-up get() refetches cleanly.
    const recovered = await c.get('k', () => Promise.resolve('v-new'), { ttlMs: 60_000, swrMs: 0 });
    expect(recovered.source).toBe('upstream');
    expect(recovered.data).toBe('v-new');
    expect(recovered.degraded).toBe(false);
  });
});