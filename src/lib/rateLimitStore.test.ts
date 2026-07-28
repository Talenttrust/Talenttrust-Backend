import {
  RateLimitStore,
  type RateLimitEntry,
  type RateLimitStoreInterface,
  type TokenBucketEntry,
} from './rateLimitStore';

function counterEntry(overrides: Partial<RateLimitEntry> = {}): RateLimitEntry {
  return {
    count: 1,
    windowStart: Date.now(),
    blocked: false,
    blockedUntil: 0,
    ...overrides,
  };
}

function bucketEntry(overrides: Partial<TokenBucketEntry> = {}): TokenBucketEntry {
  return {
    tokens: 1,
    lastRefillMs: Date.now(),
    queue: [],
    ...overrides,
  };
}

describe('RateLimitStore unified interface', () => {
  let store: RateLimitStore;

  beforeEach(() => {
    store = new RateLimitStore({ sweepIntervalMs: 0 });
  });

  afterEach(() => {
    store.destroy();
  });

  it('implements the unified rate-limit store interface', () => {
    const unifiedStore: RateLimitStoreInterface = store;
    unifiedStore.set('client-a', counterEntry());
    unifiedStore.setTokenBucket('provider-a', bucketEntry());

    expect(unifiedStore.get('client-a')?.count).toBe(1);
    expect(unifiedStore.getTokenBucket('provider-a')?.tokens).toBe(1);
  });

  it('hashes raw keys deterministically without exposing the raw value', () => {
    const hash = RateLimitStore.hashKey('192.168.0.1');

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(RateLimitStore.hashKey('192.168.0.1'));
    expect(hash).not.toContain('192.168.0.1');
  });

  it('stores fixed-window counters independently for multiple keys', () => {
    store.set('client-a', counterEntry({ count: 2 }));
    store.set('client-b', counterEntry({ count: 7 }));

    expect(store.get('client-a')?.count).toBe(2);
    expect(store.get('client-b')?.count).toBe(7);
    expect(store.size).toBe(2);
  });

  it('stores token buckets independently from fixed-window counters', () => {
    store.set('shared-key', counterEntry({ count: 3 }));
    store.setTokenBucket('shared-key', bucketEntry({ tokens: 0.5 }));

    expect(store.get('shared-key')?.count).toBe(3);
    expect(store.getTokenBucket('shared-key')?.tokens).toBe(0.5);
    expect(store.size).toBe(1);
    expect(store.tokenBucketSize).toBe(1);
  });

  it('delete removes counter and token-bucket state for the same raw key', () => {
    store.set('shared-key', counterEntry());
    store.setTokenBucket('shared-key', bucketEntry());

    store.delete('shared-key');

    expect(store.get('shared-key')).toBeUndefined();
    expect(store.getTokenBucket('shared-key')).toBeUndefined();
  });

  it('sweep removes expired counters but leaves live token buckets untouched', () => {
    store.set('expired-client', counterEntry({ windowStart: Date.now() - 60_001 }));
    store.setTokenBucket('provider-a', bucketEntry({ tokens: 0 }));

    store.sweep(60_000);

    expect(store.get('expired-client')).toBeUndefined();
    expect(store.getTokenBucket('provider-a')).toBeDefined();
  });

  it('sweep retains blocked counters until the block expires', () => {
    store.set(
      'blocked-client',
      counterEntry({
        windowStart: Date.now() - 60_001,
        blocked: true,
        blockedUntil: Date.now() + 10_000,
      }),
    );

    store.sweep(60_000);

    expect(store.get('blocked-client')).toBeDefined();
  });

  it('destroy clears all counter and token-bucket state', () => {
    store.set('client-a', counterEntry());
    store.setTokenBucket('provider-a', bucketEntry());

    store.destroy();

    expect(store.size).toBe(0);
    expect(store.tokenBucketSize).toBe(0);
  });
});
