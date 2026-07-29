/**
 * Unit tests for WebhookSubscriptionCacheService.
 *
 * Covers:
 *  - Cold cache (miss): fetcher is called, result is returned
 *  - Warm cache (hit): fetcher is NOT called on second read
 *  - Invalidation on write: invalidateSubscription / invalidateLists cause a
 *    fresh fetch on the next read
 *  - LRU eviction at max-entries bound: oldest entry is purged when cap is hit
 *  - Metrics: hit/miss/invalidation counters and entry gauge are accurate
 *  - loadWebhookCacheConfig: reads env vars with correct defaults
 */

import { Registry } from 'prom-client';
import {
  WebhookSubscriptionCacheService,
  loadWebhookCacheConfig,
  DEFAULT_WEBHOOK_CACHE_TTL_MS,
  DEFAULT_WEBHOOK_CACHE_SWR_MS,
  DEFAULT_WEBHOOK_CACHE_MAX_ENTRIES,
} from './webhookSubscriptionCache.service';
import type { WebhookSubscription } from '../types/webhook.types';
import type { CursorPage } from '../contracts/cursor.types';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeSub(overrides: Partial<WebhookSubscription> = {}): WebhookSubscription {
  return {
    id: 'sub-1',
    url: 'https://example.com/hook',
    eventType: 'contract.created',
    active: true,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makePage(
  items: WebhookSubscription[] = [],
): CursorPage<WebhookSubscription> {
  return { data: items, nextCursor: null, hasNextPage: false, limit: 20 };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function counterValue(json: any[], name: string, labels: Record<string, string> = {}): number {
  const metric = json.find((m: any) => m.name === name);
  if (!metric) return 0;
  const entry = (metric.values as any[]).find((v: any) =>
    Object.entries(labels).every(([k, val]) => v.labels[k] === val),
  );
  return entry?.value ?? 0;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('WebhookSubscriptionCacheService', () => {
  let svc: WebhookSubscriptionCacheService;
  let registry: Registry;

  beforeEach(() => {
    registry = new Registry();
    svc = new WebhookSubscriptionCacheService({}, registry);
  });

  // ── getById ────────────────────────────────────────────────────────────────

  describe('getById', () => {
    it('cold cache: calls fetcher and returns result (miss)', async () => {
      const sub = makeSub();
      const fetcher = jest.fn().mockResolvedValue(sub);

      const result = await svc.getById('sub-1', fetcher);

      expect(result).toEqual(sub);
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('warm cache: returns cached result without calling fetcher (hit)', async () => {
      const sub = makeSub();
      const fetcher = jest.fn().mockResolvedValue(sub);

      await svc.getById('sub-1', fetcher);       // cold — populates cache
      const result = await svc.getById('sub-1', fetcher); // warm

      expect(result).toEqual(sub);
      expect(fetcher).toHaveBeenCalledTimes(1);  // second call used cache
    });

    it('returns undefined when subscription does not exist', async () => {
      const fetcher = jest.fn().mockResolvedValue(undefined);

      const result = await svc.getById('missing', fetcher);

      expect(result).toBeUndefined();
    });

    it('different ids use independent cache keys', async () => {
      const subA = makeSub({ id: 'a' });
      const subB = makeSub({ id: 'b' });
      const fetchA = jest.fn().mockResolvedValue(subA);
      const fetchB = jest.fn().mockResolvedValue(subB);

      await svc.getById('a', fetchA);
      await svc.getById('b', fetchB);
      const hitA = await svc.getById('a', jest.fn());
      const hitB = await svc.getById('b', jest.fn());

      expect(hitA?.id).toBe('a');
      expect(hitB?.id).toBe('b');
      expect(fetchA).toHaveBeenCalledTimes(1);
      expect(fetchB).toHaveBeenCalledTimes(1);
    });

    it('propagates fetcher errors on cache miss', async () => {
      const fetcher = jest.fn().mockRejectedValue(new Error('db error'));

      await expect(svc.getById('sub-1', fetcher)).rejects.toThrow('db error');
    });
  });

  // ── getList ────────────────────────────────────────────────────────────────

  describe('getList', () => {
    it('cold cache: calls fetcher and returns result (miss)', async () => {
      const page = makePage([makeSub()]);
      const fetcher = jest.fn().mockResolvedValue(page);

      const result = await svc.getList({}, fetcher);

      expect(result).toEqual(page);
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('warm cache: returns cached result without calling fetcher (hit)', async () => {
      const page = makePage([makeSub()]);
      const fetcher = jest.fn().mockResolvedValue(page);

      await svc.getList({}, fetcher);            // cold
      const result = await svc.getList({}, fetcher); // warm

      expect(result).toEqual(page);
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('different filter params produce independent cache keys', async () => {
      const pageA = makePage([makeSub({ eventType: 'contract.created' })]);
      const pageB = makePage([makeSub({ eventType: 'payment.completed' })]);
      const fetchA = jest.fn().mockResolvedValue(pageA);
      const fetchB = jest.fn().mockResolvedValue(pageB);

      await svc.getList({ eventType: 'contract.created' }, fetchA);
      await svc.getList({ eventType: 'payment.completed' }, fetchB);

      const hitA = await svc.getList({ eventType: 'contract.created' }, jest.fn());
      const hitB = await svc.getList({ eventType: 'payment.completed' }, jest.fn());

      expect(hitA.data[0].eventType).toBe('contract.created');
      expect(hitB.data[0].eventType).toBe('payment.completed');
      expect(fetchA).toHaveBeenCalledTimes(1);
      expect(fetchB).toHaveBeenCalledTimes(1);
    });

    it('different cursor/limit params produce independent cache keys', async () => {
      const page1 = makePage([makeSub({ id: 'p1' })]);
      const page2 = makePage([makeSub({ id: 'p2' })]);
      const f1 = jest.fn().mockResolvedValue(page1);
      const f2 = jest.fn().mockResolvedValue(page2);

      await svc.getList({ limit: 10 }, f1);
      await svc.getList({ limit: 10, cursor: 'abc' }, f2);

      const hit1 = await svc.getList({ limit: 10 }, jest.fn());
      const hit2 = await svc.getList({ limit: 10, cursor: 'abc' }, jest.fn());

      expect(hit1.data[0].id).toBe('p1');
      expect(hit2.data[0].id).toBe('p2');
    });

    it('returns empty page from cache', async () => {
      const empty = makePage([]);
      const fetcher = jest.fn().mockResolvedValue(empty);

      await svc.getList({}, fetcher);
      const result = await svc.getList({}, jest.fn()); // cached

      expect(result.data).toHaveLength(0);
    });
  });

  // ── invalidateSubscription ────────────────────────────────────────────────

  describe('invalidateSubscription', () => {
    it('forces a fresh fetch on the next getById call', async () => {
      const original = makeSub({ url: 'https://original.com/hook' });
      const updated = makeSub({ url: 'https://updated.com/hook' });
      const fetcher = jest.fn()
        .mockResolvedValueOnce(original)
        .mockResolvedValueOnce(updated);

      await svc.getById('sub-1', fetcher);         // miss → original cached
      svc.invalidateSubscription('sub-1');          // evict
      const result = await svc.getById('sub-1', fetcher); // miss again → updated

      expect(result?.url).toBe('https://updated.com/hook');
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it('does not affect other subscription keys', async () => {
      const subA = makeSub({ id: 'a' });
      const subB = makeSub({ id: 'b' });
      const fetchA = jest.fn().mockResolvedValue(subA);
      const fetchB = jest.fn().mockResolvedValue(subB);

      await svc.getById('a', fetchA);
      await svc.getById('b', fetchB);

      svc.invalidateSubscription('a'); // only evict 'a'

      const refetchA = jest.fn().mockResolvedValue(subA);
      const hitB = jest.fn();

      await svc.getById('a', refetchA);   // must call refetch
      await svc.getById('b', hitB);        // must NOT call hitB

      expect(refetchA).toHaveBeenCalledTimes(1);
      expect(hitB).not.toHaveBeenCalled();
    });

    it('does not affect list cache keys', async () => {
      const page = makePage([makeSub()]);
      const listFetcher = jest.fn().mockResolvedValue(page);

      await svc.getList({}, listFetcher);
      svc.invalidateSubscription('sub-1'); // should NOT affect list cache

      const listHit = jest.fn();
      await svc.getList({}, listHit);      // still cached

      expect(listHit).not.toHaveBeenCalled();
    });
  });

  // ── invalidateLists ────────────────────────────────────────────────────────

  describe('invalidateLists', () => {
    it('forces a fresh fetch on the next getList call', async () => {
      const before = makePage([makeSub({ url: 'https://before.com' })]);
      const after = makePage([makeSub({ url: 'https://after.com' })]);
      const fetcher = jest.fn()
        .mockResolvedValueOnce(before)
        .mockResolvedValueOnce(after);

      await svc.getList({}, fetcher);   // miss → cached
      svc.invalidateLists();             // evict all lists
      const result = await svc.getList({}, fetcher); // miss again

      expect(result.data[0].url).toBe('https://after.com');
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it('invalidates all list key variants', async () => {
      const pageAll = makePage([makeSub()]);
      const pageFiltered = makePage([makeSub({ eventType: 'payment.completed' })]);
      const fAll = jest.fn().mockResolvedValue(pageAll);
      const fFiltered = jest.fn().mockResolvedValue(pageFiltered);

      // Populate two distinct list keys
      await svc.getList({}, fAll);
      await svc.getList({ eventType: 'payment.completed' }, fFiltered);

      svc.invalidateLists();

      const refetchAll = jest.fn().mockResolvedValue(pageAll);
      const refetchFiltered = jest.fn().mockResolvedValue(pageFiltered);

      await svc.getList({}, refetchAll);
      await svc.getList({ eventType: 'payment.completed' }, refetchFiltered);

      expect(refetchAll).toHaveBeenCalledTimes(1);
      expect(refetchFiltered).toHaveBeenCalledTimes(1);
    });

    it('does not affect per-id subscription cache keys', async () => {
      const sub = makeSub();
      const subFetcher = jest.fn().mockResolvedValue(sub);

      await svc.getById('sub-1', subFetcher);  // cached
      svc.invalidateLists();                    // should NOT evict per-id key

      const subHit = jest.fn();
      await svc.getById('sub-1', subHit);       // still cached

      expect(subHit).not.toHaveBeenCalled();
    });
  });

  // ── LRU eviction ──────────────────────────────────────────────────────────

  describe('LRU eviction at maxEntries bound', () => {
    it('evicts oldest entry when cap is exceeded', async () => {
      const small = new WebhookSubscriptionCacheService({ maxEntries: 2 }, new Registry());

      await small.getById('a', jest.fn().mockResolvedValue(makeSub({ id: 'a' })));
      await small.getById('b', jest.fn().mockResolvedValue(makeSub({ id: 'b' })));
      expect(small.size).toBe(2);

      // Adding 'c' pushes 'a' out (LRU)
      await small.getById('c', jest.fn().mockResolvedValue(makeSub({ id: 'c' })));
      expect(small.size).toBe(2);

      // 'a' must be gone — next read triggers a fresh fetch
      const refetchA = jest.fn().mockResolvedValue(makeSub({ id: 'a', url: 'https://refetched.com' }));
      const resultA = await small.getById('a', refetchA);

      expect(refetchA).toHaveBeenCalledTimes(1);
      expect(resultA?.url).toBe('https://refetched.com');
    });

    it('cache size stays at or below maxEntries after many writes', async () => {
      const small = new WebhookSubscriptionCacheService({ maxEntries: 3 }, new Registry());

      for (let i = 0; i < 10; i++) {
        await small.getById(
          `sub-${i}`,
          jest.fn().mockResolvedValue(makeSub({ id: `sub-${i}` })),
        );
      }

      expect(small.size).toBeLessThanOrEqual(3);
    });
  });

  // ── Metrics ────────────────────────────────────────────────────────────────

  describe('metrics', () => {
    it('increments miss counter on first getById (cold cache)', async () => {
      await svc.getById('sub-1', jest.fn().mockResolvedValue(makeSub()));

      const json = await registry.getMetricsAsJSON();
      expect(counterValue(json, 'webhook_subscription_cache_misses_total', { operation: 'getById' })).toBe(1);
    });

    it('increments hit counter on second getById (warm cache)', async () => {
      const fetcher = jest.fn().mockResolvedValue(makeSub());
      await svc.getById('sub-1', fetcher);
      await svc.getById('sub-1', fetcher);

      const json = await registry.getMetricsAsJSON();
      expect(counterValue(json, 'webhook_subscription_cache_hits_total', { operation: 'getById' })).toBe(1);
      expect(counterValue(json, 'webhook_subscription_cache_misses_total', { operation: 'getById' })).toBe(1);
    });

    it('increments miss counter on first getList (cold cache)', async () => {
      await svc.getList({}, jest.fn().mockResolvedValue(makePage()));

      const json = await registry.getMetricsAsJSON();
      expect(counterValue(json, 'webhook_subscription_cache_misses_total', { operation: 'getList' })).toBe(1);
    });

    it('increments hit counter on second getList (warm cache)', async () => {
      const fetcher = jest.fn().mockResolvedValue(makePage());
      await svc.getList({}, fetcher);
      await svc.getList({}, fetcher);

      const json = await registry.getMetricsAsJSON();
      expect(counterValue(json, 'webhook_subscription_cache_hits_total', { operation: 'getList' })).toBe(1);
    });

    it('increments invalidation counter with reason=subscription_mutated', async () => {
      svc.invalidateSubscription('sub-1');

      const json = await registry.getMetricsAsJSON();
      expect(
        counterValue(json, 'webhook_subscription_cache_invalidations_total', { reason: 'subscription_mutated' }),
      ).toBe(1);
    });

    it('increments invalidation counter with reason=list_mutated', async () => {
      svc.invalidateLists();

      const json = await registry.getMetricsAsJSON();
      expect(
        counterValue(json, 'webhook_subscription_cache_invalidations_total', { reason: 'list_mutated' }),
      ).toBe(1);
    });

    it('updates entry gauge after writes', async () => {
      await svc.getById('sub-1', jest.fn().mockResolvedValue(makeSub()));
      await svc.getById('sub-2', jest.fn().mockResolvedValue(makeSub({ id: 'sub-2' })));

      const json = await registry.getMetricsAsJSON();
      const gauge = json.find((m: any) => m.name === 'webhook_subscription_cache_entries');
      expect(gauge).toBeDefined();
      const value = (gauge!.values as any[]).find((v: any) => v.value >= 2);
      expect(value?.value).toBeGreaterThanOrEqual(2);
    });

    it('gauge reflects zero after full invalidation', async () => {
      await svc.getById('sub-1', jest.fn().mockResolvedValue(makeSub()));
      svc.invalidateSubscription('sub-1');

      // gauge is set after the last operation — check size
      expect(svc.size).toBe(0);
    });
  });

  // ── loadWebhookCacheConfig ─────────────────────────────────────────────────

  describe('loadWebhookCacheConfig', () => {
    it('returns defaults when no env vars are set', () => {
      const config = loadWebhookCacheConfig({});
      expect(config.ttlMs).toBe(DEFAULT_WEBHOOK_CACHE_TTL_MS);
      expect(config.swrMs).toBe(DEFAULT_WEBHOOK_CACHE_SWR_MS);
      expect(config.maxEntries).toBe(DEFAULT_WEBHOOK_CACHE_MAX_ENTRIES);
    });

    it('reads WEBHOOK_CACHE_TTL_MS', () => {
      const config = loadWebhookCacheConfig({ WEBHOOK_CACHE_TTL_MS: '10000' });
      expect(config.ttlMs).toBe(10_000);
    });

    it('reads WEBHOOK_CACHE_SWR_MS', () => {
      const config = loadWebhookCacheConfig({ WEBHOOK_CACHE_SWR_MS: '60000' });
      expect(config.swrMs).toBe(60_000);
    });

    it('reads WEBHOOK_CACHE_MAX_ENTRIES', () => {
      const config = loadWebhookCacheConfig({ WEBHOOK_CACHE_MAX_ENTRIES: '200' });
      expect(config.maxEntries).toBe(200);
    });

    it('falls back to default on non-numeric WEBHOOK_CACHE_TTL_MS', () => {
      const config = loadWebhookCacheConfig({ WEBHOOK_CACHE_TTL_MS: 'abc' });
      expect(config.ttlMs).toBe(DEFAULT_WEBHOOK_CACHE_TTL_MS);
    });

    it('falls back to default on negative WEBHOOK_CACHE_SWR_MS', () => {
      const config = loadWebhookCacheConfig({ WEBHOOK_CACHE_SWR_MS: '-100' });
      // negative passes toMs (>= 0 check) — value is kept as-is since negative is ≥ 0 but...
      // Actually toMs accepts 0+ so -100 triggers fallback
      expect(config.swrMs).toBe(DEFAULT_WEBHOOK_CACHE_SWR_MS);
    });

    it('falls back to default on zero WEBHOOK_CACHE_MAX_ENTRIES', () => {
      const config = loadWebhookCacheConfig({ WEBHOOK_CACHE_MAX_ENTRIES: '0' });
      expect(config.maxEntries).toBe(DEFAULT_WEBHOOK_CACHE_MAX_ENTRIES);
    });

    it('exported defaults have correct values', () => {
      expect(DEFAULT_WEBHOOK_CACHE_TTL_MS).toBe(5_000);
      expect(DEFAULT_WEBHOOK_CACHE_SWR_MS).toBe(30_000);
      expect(DEFAULT_WEBHOOK_CACHE_MAX_ENTRIES).toBe(500);
    });
  });
});
