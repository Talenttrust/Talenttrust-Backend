/**
 * @module utils/swrCache.test
 * @description Deterministic unit tests for the SWRCache utility.
 *
 * This test suite verifies the core behavior of the Stale-While-Revalidate (SWR)
 * in-memory cache layer, including fresh hits, stale hits, cache misses,
 * concurrent request coalescing, background revalidation error handling, and
 * bounded LRU eviction policy.
 *
 * Jest fake timers are used to control the TTL and SWR expiration windows
 * deterministically without introducing real-world delays.
 */

import { SWRCache, CacheOptions, DEFAULT_MAX_ENTRIES } from './swrCache';
import { setWriteRecordImpl, LogRecord } from '../logger';

describe('SWRCache', () => {
  let cache: SWRCache;
  const ttlMs = 1000;
  const swrMs = 5000;
  const options: CacheOptions = { ttlMs, swrMs };

  beforeEach(() => {
    cache = new SWRCache();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('fresh hit', () => {
    it('returns cached value without calling the fetcher', async () => {
      const fetcher = jest.fn().mockResolvedValue('fresh');
      const key = 'test:key';

      const first = await cache.get(key, fetcher, options);

      expect(first).toEqual({ data: 'fresh', degraded: false, source: 'upstream' });

      const result = await cache.get(key, fetcher, options);

      expect(result).toEqual({ data: 'fresh', degraded: false, source: 'cache_fresh' });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('returns fresh value for entries within TTL', async () => {
      const fetcher = jest.fn().mockResolvedValue('data');
      const key = 'test:fresh-ttl';

      await cache.get(key, fetcher, options);

      jest.advanceTimersByTime(500);

      const result = await cache.get(key, fetcher, options);
      expect(result).toEqual({ data: 'data', degraded: false, source: 'cache_fresh' });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });
  });

  describe('stale hit', () => {
    it('returns stale value immediately and revalidates in background once', async () => {
      const fetcher = jest.fn().mockResolvedValue('initial');
      const key = 'test:stale';

      await cache.get(key, fetcher, options);

      expect(fetcher).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(ttlMs + 10);

      const revalidateFetcher = jest.fn().mockResolvedValue('v2');
      const p1 = cache.get(key, revalidateFetcher, options);
      const p2 = cache.get(key, revalidateFetcher, options);
      const p3 = cache.get(key, revalidateFetcher, options);

      const results = await Promise.all([p1, p2, p3]);

      expect(results[0]).toEqual({ data: 'initial', degraded: true, source: 'cache_stale' });
      expect(results[1]).toEqual({ data: 'initial', degraded: true, source: 'cache_stale' });
      expect(results[2]).toEqual({ data: 'initial', degraded: true, source: 'cache_stale' });

      expect(revalidateFetcher).toHaveBeenCalledTimes(1);

      await Promise.resolve();

      const after = await cache.get(key, revalidateFetcher, options);
      expect(after).toEqual({ data: 'v2', degraded: false, source: 'cache_fresh' });
    });
  });

  describe('cache miss', () => {
    it('awaits the fetcher and populates the entry', async () => {
      const fetcher = jest.fn().mockResolvedValue('upserted');
      const key = 'test:miss';

      const result = await cache.get(key, fetcher, options);

      expect(result).toEqual({ data: 'upserted', degraded: false, source: 'upstream' });
      expect(fetcher).toHaveBeenCalledTimes(1);

      const fresh = await cache.get(key, fetcher, options);
      expect(fresh).toEqual({ data: 'upserted', degraded: false, source: 'cache_fresh' });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('completely refetches if SWR window has expired', async () => {
      const fetcher = jest.fn()
        .mockResolvedValueOnce('initial')
        .mockResolvedValueOnce('renewed');
      const key = 'test:expired';

      await cache.get(key, fetcher, options);

      expect(fetcher).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(ttlMs + swrMs + 100);

      const result = await cache.get(key, fetcher, options);
      expect(result).toEqual({ data: 'renewed', degraded: false, source: 'upstream' });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });
  });

  describe('revalidation error', () => {
    let logSpy: jest.Mock;

    beforeEach(() => {
      logSpy = jest.fn();
      setWriteRecordImpl(logSpy);
    });

    afterEach(() => {
      setWriteRecordImpl((record: LogRecord) => {
        const line = JSON.stringify(record);
        if (record.level === 'error') {
          process.stderr.write(line + '\n');
        } else {
          process.stdout.write(line + '\n');
        }
      });
    });

    it('does not throw to callers and retains stale value after background revalidation fails', async () => {
      const seedFetcher = jest.fn().mockResolvedValue('stale-data');
      const key = 'test:reval-error';

      await cache.get(key, seedFetcher, options);

      expect(seedFetcher).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(ttlMs + 10);

      const failedFetcher = jest.fn().mockRejectedValue(new Error('network down'));

      const result = await cache.get(key, failedFetcher, options);

      expect(result).toEqual({ data: 'stale-data', degraded: true, source: 'cache_stale' });
      expect(failedFetcher).toHaveBeenCalledTimes(1);

      await Promise.resolve();

      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'error',
          message: 'SWR Cache: background revalidation failed',
          cacheKey: key,
        }),
      );

      const logRecord = logSpy.mock.calls[0][0];
      expect(logRecord.err).toEqual(
        expect.objectContaining({
          type: 'Error',
          message: 'network down',
        }),
      );
    });

    it('does not rethrow revalidation errors to stale callers', async () => {
      const fetcher = jest.fn().mockResolvedValue('original');
      const key = 'test:reval-no-throw';

      await cache.get(key, fetcher, options);

      jest.advanceTimersByTime(ttlMs + 10);

      const errorPromise = cache.get(key, jest.fn().mockRejectedValue(new Error('fetch failed')), options);

      const result = await errorPromise;

      expect(result).toEqual({ data: 'original', degraded: true, source: 'cache_stale' });

      await expect(errorPromise).resolves.toEqual(result);
    });
  });

  describe('concurrent miss coalescing', () => {
    it('awaits a single fetch for overlapping callers', async () => {
      let resolveFetcher: (value: string) => void;
      const fetcher = jest.fn().mockImplementation(
        () =>
          new Promise<string>((res) => {
            resolveFetcher = res;
          }),
      );
      const key = 'test:coalesce';

      const p1 = cache.get(key, fetcher, options);
      const p2 = cache.get(key, fetcher, options);
      const p3 = cache.get(key, fetcher, options);

      expect(fetcher).toHaveBeenCalledTimes(1);

      resolveFetcher!('coalesced');

      const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

      expect(r1).toEqual({ data: 'coalesced', degraded: false, source: 'upstream' });
      expect(r2).toEqual({ data: 'coalesced', degraded: false, source: 'upstream' });
      expect(r3).toEqual({ data: 'coalesced', degraded: false, source: 'upstream' });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });
  });

  describe('error handling', () => {
    it('propagates error on initial fetch failure', async () => {
      const fetcher = jest.fn().mockRejectedValue(new Error('upstream failed'));
      const key = 'test:error';

      await expect(cache.get(key, fetcher, options)).rejects.toThrow('upstream failed');
      expect(fetcher).toHaveBeenCalledTimes(1);
    });
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
      return new Promise((resolve) => setTimeout(() => resolve('coalesced-data'), 100));
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
    cache = new SWRCache({ maxEntries: 2 });

    // k1 has a short TTL; k2 has the long default so it stays fresh.
    await cache.get('k1', () => Promise.resolve('v1-initial'), { ttlMs: 1, swrMs: 60_000 });
    await cache.get('k2', () => Promise.resolve('v2'), { ttlMs: 60_000, swrMs: 0 });
    expect(cache.size).toBe(2);

    // Advance past k1's TTL
    jest.advanceTimersByTime(10);

    let resolveRevalidate!: (value: string) => void;
    const reFetcher = jest.fn(() => new Promise<string>((res) => {
      resolveRevalidate = res;
    }));

    const staleCall = await cache.get('k1', reFetcher, { ttlMs: 1, swrMs: 60_000 });
    expect(staleCall.source).toBe('cache_stale');
    expect(staleCall.data).toBe('v1-initial');

    // While k1's revalidation is in flight, push pressure: add k3, then k4.
    await cache.get('k3', () => Promise.resolve('v3'), { ttlMs: 60_000, swrMs: 0 });
    expect(cache.size).toBeLessThanOrEqual(2);

    await cache.get('k4', () => Promise.resolve('v4'), { ttlMs: 60_000, swrMs: 0 });
    expect(cache.size).toBeLessThanOrEqual(2);

    // Resolve the in-flight revalidation
    resolveRevalidate('v1-new');

    // Allow promise microtasks to run
    await Promise.resolve();
    await Promise.resolve();

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
    const c = new SWRCache();
    let rejectFetcher!: (reason: Error) => void;
    const failing = jest.fn(() => new Promise((_, rej) => {
      rejectFetcher = rej;
    }));

    // Two concurrent gets on the same key: the fetcher must only run once
    // (true coalescing), and BOTH callers reject from the same promise.
    const p1 = c.get('k', failing, { ttlMs: 60_000, swrMs: 0 });
    const p2 = c.get('k', failing, { ttlMs: 60_000, swrMs: 0 });

    rejectFetcher(new Error('upstream-down'));

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

describe('SWRCache structured error logging & onRevalidationError callback', () => {
  let cache: SWRCache;
  const ttlMs = 1000;
  const swrMs = 5000;
  const options: CacheOptions = { ttlMs, swrMs };
  let logSpy: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();
    logSpy = jest.fn();
    setWriteRecordImpl(logSpy);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    setWriteRecordImpl((record: LogRecord) => {
      const line = JSON.stringify(record);
      if (record.level === 'error') {
        process.stderr.write(line + '\n');
      } else {
        process.stdout.write(line + '\n');
      }
    });
  });

  it('emits a structured error log with cache key and serialised error on background revalidation failure', async () => {
    cache = new SWRCache();
    const seedFetcher = jest.fn().mockResolvedValue('stale');
    const key = 'log:test';

    await cache.get(key, seedFetcher, options);
    jest.advanceTimersByTime(ttlMs + 10);

    const failFetcher = jest.fn().mockRejectedValue(new Error('boom'));
    await cache.get(key, failFetcher, options);

    await Promise.resolve();

    expect(logSpy).toHaveBeenCalledTimes(1);
    const record: LogRecord = logSpy.mock.calls[0][0];
    expect(record.level).toBe('error');
    expect(record.message).toBe('SWR Cache: background revalidation failed');
    expect(record.cacheKey).toBe(key);
    expect(record.err).toEqual(
      expect.objectContaining({ type: 'Error', message: 'boom' }),
    );
    expect(record.service).toBe('talenttrust-backend');
  });

  it('fires the onRevalidationError callback with key and original error', async () => {
    const onRevalidationError = jest.fn();
    cache = new SWRCache({ onRevalidationError });

    const seedFetcher = jest.fn().mockResolvedValue('v1');
    const key = 'cb:test';

    await cache.get(key, seedFetcher, options);
    jest.advanceTimersByTime(ttlMs + 10);

    const originalError = new Error('upstream timeout');
    const failFetcher = jest.fn().mockRejectedValue(originalError);

    const result = await cache.get(key, failFetcher, options);

    expect(result).toEqual({ data: 'v1', degraded: true, source: 'cache_stale' });

    await Promise.resolve();

    expect(onRevalidationError).toHaveBeenCalledTimes(1);
    expect(onRevalidationError).toHaveBeenCalledWith(key, originalError);
  });

  it('does not fire onRevalidationError when revalidation succeeds', async () => {
    const onRevalidationError = jest.fn();
    cache = new SWRCache({ onRevalidationError });

    const seedFetcher = jest.fn().mockResolvedValue('v1');
    const key = 'cb:success';

    await cache.get(key, seedFetcher, options);
    jest.advanceTimersByTime(ttlMs + 10);

    const okFetcher = jest.fn().mockResolvedValue('v2');
    await cache.get(key, okFetcher, options);

    await Promise.resolve();

    expect(onRevalidationError).not.toHaveBeenCalled();
  });

  it('does not crash when onRevalidationError callback is omitted', async () => {
    cache = new SWRCache();

    const seedFetcher = jest.fn().mockResolvedValue('v1');
    const key = 'no-cb:test';

    await cache.get(key, seedFetcher, options);
    jest.advanceTimersByTime(ttlMs + 10);

    const failFetcher = jest.fn().mockRejectedValue(new Error('fail'));
    const result = await cache.get(key, failFetcher, options);

    expect(result).toEqual({ data: 'v1', degraded: true, source: 'cache_stale' });

    await Promise.resolve();
  });

  it('catches callback errors so a throwing callback never crashes the cache', async () => {
    const brokenCallback = jest.fn(() => {
      throw new Error('callback exploded');
    });
    cache = new SWRCache({ onRevalidationError: brokenCallback });

    const seedFetcher = jest.fn().mockResolvedValue('v1');
    const key = 'cb:throw';

    await cache.get(key, seedFetcher, options);
    jest.advanceTimersByTime(ttlMs + 10);

    const failFetcher = jest.fn().mockRejectedValue(new Error('upstream err'));
    const result = await cache.get(key, failFetcher, options);

    expect(result).toEqual({ data: 'v1', degraded: true, source: 'cache_stale' });

    await Promise.resolve();

    expect(brokenCallback).toHaveBeenCalledTimes(1);

    // The cache must still be functional after a throwing callback.
    // Advance past the SWR window so the next call is a full miss.
    jest.advanceTimersByTime(ttlMs + swrMs + 100);
    const recovered = await cache.get(key, () => Promise.resolve('v2'), options);
    expect(recovered.source).toBe('upstream');
    expect(recovered.data).toBe('v2');
  });

  it('fires the callback on concurrent stale callers only once (single revalidation)', async () => {
    const onRevalidationError = jest.fn();
    cache = new SWRCache({ onRevalidationError });

    const seedFetcher = jest.fn().mockResolvedValue('v1');
    const key = 'concurrent:cb';

    await cache.get(key, seedFetcher, options);
    jest.advanceTimersByTime(ttlMs + 10);

    const failFetcher = jest.fn().mockRejectedValue(new Error('fail'));

    const p1 = cache.get(key, failFetcher, options);
    const p2 = cache.get(key, failFetcher, options);
    const p3 = cache.get(key, failFetcher, options);

    const results = await Promise.all([p1, p2, p3]);

    expect(results.every((r) => r.degraded && r.data === 'v1')).toBe(true);

    await Promise.resolve();

    expect(failFetcher).toHaveBeenCalledTimes(1);
    expect(onRevalidationError).toHaveBeenCalledTimes(1);
    expect(onRevalidationError).toHaveBeenCalledWith(key, expect.any(Error));
  });

  it('background revalidation failure does not corrupt activeFetches bookkeeping', async () => {
    cache = new SWRCache();

    const seedFetcher = jest.fn().mockResolvedValue('v1');
    const key = 'bookkeeping:test';

    await cache.get(key, seedFetcher, options);
    jest.advanceTimersByTime(ttlMs + 10);

    const failFetcher = jest.fn().mockRejectedValue(new Error('fail'));
    await cache.get(key, failFetcher, options);

    await Promise.resolve();

    // The next call should trigger a fresh fetch, not be stuck on activeFetches.
    // Advance past the SWR window so the next call is a full miss.
    jest.advanceTimersByTime(ttlMs + swrMs + 100);
    const okFetcher = jest.fn().mockResolvedValue('v2');
    const recovered = await cache.get(key, okFetcher, options);

    expect(recovered.source).toBe('upstream');
    expect(recovered.data).toBe('v2');
    expect(okFetcher).toHaveBeenCalledTimes(1);
  });

  it('no timers are leaked after background revalidation completes', async () => {
    cache = new SWRCache();

    const seedFetcher = jest.fn().mockResolvedValue('v1');
    const key = 'timer:leak';

    await cache.get(key, seedFetcher, options);
    jest.advanceTimersByTime(ttlMs + 10);

    const failFetcher = jest.fn().mockRejectedValue(new Error('fail'));
    await cache.get(key, failFetcher, options);

    await Promise.resolve();

    // Verify no remaining active fetches for the key.
    // Accessing the private map is acceptable in tests to verify cleanup.
    expect((cache as unknown as { activeFetches: Map<string, unknown> }).activeFetches.has(key)).toBe(false);
  });
});
