import { InMemoryCache } from './in-memory-cache';

describe('InMemoryCache', () => {
  it('returns cached values before expiry', () => {
    let now = 1_000;
    const cache = new InMemoryCache({ maxItems: 10, now: () => now });

    cache.set('key', { ok: true }, 5);

    expect(cache.get<{ ok: boolean }>('key')).toEqual({ ok: true });
    now += 4_000;
    expect(cache.get<{ ok: boolean }>('key')).toEqual({ ok: true });
  });

  it('expires entries after their ttl', () => {
    let now = 1_000;
    const cache = new InMemoryCache({ maxItems: 10, now: () => now });

    cache.set('key', 'value', 1);
    now += 1_100;

    expect(cache.get('key')).toBeUndefined();
    expect(cache.size()).toBe(0);
  });

  it('evicts the oldest entry when maxItems is reached', () => {
    let now = 1_000;
    const cache = new InMemoryCache({ maxItems: 2, now: () => now });

    cache.set('one', 1, 30);
    now += 1;
    cache.set('two', 2, 30);
    now += 1;
    cache.set('three', 3, 30);

    expect(cache.get('one')).toBeUndefined();
    expect(cache.get('two')).toBe(2);
    expect(cache.get('three')).toBe(3);
  });

  it('deletes and clears entries explicitly', () => {
    const cache = new InMemoryCache({ maxItems: 10 });

    cache.set('one', 1, 30);
    cache.set('two', 2, 30);
    cache.delete('one');

    expect(cache.get('one')).toBeUndefined();
    cache.clear();
    expect(cache.size()).toBe(0);
  });
});
