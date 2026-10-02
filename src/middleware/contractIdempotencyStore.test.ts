import { InMemoryContractIdempotencyStore } from './contractIdempotencyStore';

describe('InMemoryContractIdempotencyStore', () => {
  function makeStore(options: { ttlMs?: number; maxSize?: number; start?: number } = {}) {
    let now = options.start ?? 1_000_000;
    const store = new InMemoryContractIdempotencyStore({
      ttlMs: options.ttlMs,
      maxSize: options.maxSize,
      clock: () => now,
    });
    return {
      store,
      now: () => now,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  const TTL = 1_000;

  describe('atomic reservation', () => {
    it('reserves an absent key exactly once', () => {
      const { store } = makeStore();
      expect(store.reserve('key', 'fp-1', TTL)).toEqual({ kind: 'reserved' });
      expect(store.reserve('key', 'fp-1', TTL)).toEqual({ kind: 'in_progress' });
    });

    it('returns conflict for the same key with a different fingerprint while in progress', () => {
      const { store } = makeStore();
      store.reserve('key', 'fp-1', TTL);
      expect(store.reserve('key', 'fp-2', TTL)).toEqual({ kind: 'conflict' });
    });
  });

  describe('completion and replay', () => {
    it('replays the stored status and body after completion', () => {
      const { store } = makeStore();
      store.reserve('key', 'fp-1', TTL);
      store.complete('key', 'fp-1', 201, { ok: true }, TTL);

      const result = store.reserve('key', 'fp-1', TTL);
      expect(result.kind).toBe('replay');
      if (result.kind === 'replay') {
        expect(result.record.statusCode).toBe(201);
        expect(result.record.body).toEqual({ ok: true });
      }
    });

    it('returns conflict for a different fingerprint after completion', () => {
      const { store } = makeStore();
      store.reserve('key', 'fp-1', TTL);
      store.complete('key', 'fp-1', 201, { ok: true }, TTL);
      expect(store.reserve('key', 'fp-2', TTL)).toEqual({ kind: 'conflict' });
    });

    it('preserves the original reservation expiry on completion', () => {
      const { store, advance } = makeStore({ ttlMs: TTL });
      store.reserve('key', 'fp-1', TTL);
      const reservedEntry = store.get('key');
      advance(50);
      store.complete('key', 'fp-1', 201, {}, TTL);

      const completedEntry = store.get('key');
      expect(completedEntry?.expiresAt).toBe(reservedEntry?.expiresAt);
    });
  });

  describe('release', () => {
    it('frees a reservation so the key can be reserved again', () => {
      const { store } = makeStore();
      store.reserve('key', 'fp-1', TTL);
      store.release('key', 'fp-1');
      expect(store.reserve('key', 'fp-1', TTL)).toEqual({ kind: 'reserved' });
    });

    it('does not release a completed entry', () => {
      const { store } = makeStore();
      store.reserve('key', 'fp-1', TTL);
      store.complete('key', 'fp-1', 201, {}, TTL);
      store.release('key', 'fp-1');
      expect(store.reserve('key', 'fp-1', TTL).kind).toBe('replay');
    });
  });

  describe('expiration', () => {
    it('defaults records to a 24-hour TTL when none is supplied', () => {
      const { store } = makeStore(); // no ttlMs → constructor default (24h)
      store.reserve('key', 'fp'); // no explicit ttl → store default
      const entry = store.get('key');
      expect(entry?.expiresAt).toBe(1_000_000 + 24 * 60 * 60 * 1000);
    });

    it('treats an expired record as absent on reserve', () => {
      const { store, advance } = makeStore({ ttlMs: 100 });
      store.reserve('key', 'fp-1', 100);
      store.complete('key', 'fp-1', 201, {}, 100);

      advance(101);
      expect(store.reserve('key', 'fp-1', 100)).toEqual({ kind: 'reserved' });
    });

    it('lazy-expires on get()', () => {
      const { store, advance } = makeStore({ ttlMs: 100 });
      store.reserve('key', 'fp-1', 100);
      store.complete('key', 'fp-1', 201, {}, 100);

      advance(101);
      expect(store.get('key')).toBeUndefined();
      expect(store.size()).toBe(0);
    });

    it('purgeExpired removes expired entries and returns the count', () => {
      const { store, advance } = makeStore({ ttlMs: 100 });
      store.reserve('a', 'fp', 100);
      store.complete('a', 'fp', 201, {}, 100);
      store.reserve('b', 'fp', 100); // left in_progress

      advance(101);
      expect(store.purgeExpired()).toBe(2);
      expect(store.size()).toBe(0);
    });

    it('bounds memory via maxSize eviction of the oldest entry', () => {
      const { store } = makeStore({ maxSize: 2, ttlMs: 100 });
      store.reserve('a', 'fp', 100);
      store.reserve('b', 'fp', 100);
      store.reserve('c', 'fp', 100);
      expect(store.size()).toBe(2);
    });
  });

  describe('tenant isolation', () => {
    it('keeps the same fingerprint independent across scope keys', () => {
      const { store } = makeStore();
      expect(store.reserve('scope-a', 'fp', TTL)).toEqual({ kind: 'reserved' });
      expect(store.reserve('scope-b', 'fp', TTL)).toEqual({ kind: 'reserved' });
    });
  });

  describe('response immutability', () => {
    it('never shares the stored body reference with the caller', () => {
      const { store } = makeStore();
      store.reserve('key', 'fp-1', TTL);
      store.complete(
        'key',
        'fp-1',
        200,
        { nested: { value: 1 } },
        TTL,
      );

      const first = store.reserve('key', 'fp-1', TTL);
      if (first.kind !== 'replay') {
        throw new Error('expected replay');
      }
      (first.record.body as { nested: { value: number } }).nested.value = 999;

      const second = store.reserve('key', 'fp-1', TTL);
      if (second.kind !== 'replay') {
        throw new Error('expected replay');
      }
      expect(
        (second.record.body as { nested: { value: number } }).nested.value,
      ).toBe(1);
    });
  });
});
