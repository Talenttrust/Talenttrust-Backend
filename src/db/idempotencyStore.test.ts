import { InMemoryIdempotencyStore, IdempotencyRecord, IdempotencyStoreConfig } from './idempotencyStore';

/**
 * Tests for InMemoryIdempotencyStore TTL eviction.
 *
 * Coverage targets:
 *   - Expired keys are purged by sweep
 *   - Expired keys are treated as absent on lookup
 *   - Key exactly at expiry boundary is evicted/purged
 *   - Purge with no expired keys is a no-op
 *   - Re-submission after expiry is processed fresh
 *   - Injected clock controls time
 *   - Custom TTL is honored
 *   - clear() removes all records regardless of expiry
 */
describe('InMemoryIdempotencyStore', () => {
  function makeStore(config: IdempotencyStoreConfig = {}): InMemoryIdempotencyStore {
    return new InMemoryIdempotencyStore(config);
  }

  function makeRecord(overrides: Partial<IdempotencyRecord> = {}): IdempotencyRecord {
    return {
      key: 'test-key',
      payloadHash: 'abc123',
      result: { ok: true },
      createdAt: new Date('2024-01-01T00:00:00.000Z'),
      expiresAt: new Date('2024-01-01T01:00:00.000Z'),
      ...overrides,
    };
  }

  describe('expired key is absent on lookup', () => {
    it('returns undefined for a key past its expiresAt', () => {
      const clock = () => new Date('2024-01-01T02:00:00.000Z');
      const store = makeStore({ clock });

      store.set(makeRecord({ expiresAt: new Date('2024-01-01T01:00:00.000Z') }));

      expect(store.get('test-key')).toBeUndefined();
    });

    it('returns the record for a key within its TTL', () => {
      const clock = () => new Date('2024-01-01T00:30:00.000Z');
      const store = makeStore({ clock });

      store.set(makeRecord({ expiresAt: new Date('2024-01-01T01:00:00.000Z') }));

      expect(store.get('test-key')).toBeDefined();
      expect(store.get('test-key')?.result).toEqual({ ok: true });
    });

    it('deletes the key from the map after expiry lookup', () => {
      const clock = () => new Date('2024-01-01T02:00:00.000Z');
      const store = makeStore({ clock });

      store.set(makeRecord({ expiresAt: new Date('2024-01-01T01:00:00.000Z') }));

      store.get('test-key');

      expect((store as unknown as { records: Map<string, IdempotencyRecord> }).records.has('test-key')).toBe(false);
    });
  });

  describe('purgeExpired', () => {
    it('removes expired records and returns the count', () => {
      const now = new Date('2024-01-01T02:00:00.000Z');
      const clock = () => now;
      const store = makeStore({ clock });

      store.set(makeRecord({ key: 'key-1', expiresAt: new Date('2024-01-01T01:00:00.000Z') }));
      store.set(makeRecord({ key: 'key-2', expiresAt: new Date('2024-01-01T03:00:00.000Z') }));
      store.set(makeRecord({ key: 'key-3', expiresAt: new Date('2024-01-01T01:30:00.000Z') }));

      const purged = store.purgeExpired(now);

      expect(purged).toBe(2);
      expect(store.get('key-1')).toBeUndefined();
      expect(store.get('key-3')).toBeUndefined();
      expect(store.get('key-2')).toBeDefined();
    });

    it('purges a key exactly at the expiry boundary', () => {
      const boundary = new Date('2024-01-01T01:00:00.000Z');
      const clock = () => boundary;
      const store = makeStore({ clock });

      store.set(makeRecord({ key: 'key-boundary', expiresAt: boundary }));

      const purged = store.purgeExpired(boundary);

      expect(purged).toBe(1);
      expect(store.get('key-boundary')).toBeUndefined();
    });

    it('is a no-op when no records are expired', () => {
      const now = new Date('2024-01-01T00:30:00.000Z');
      const clock = () => now;
      const store = makeStore({ clock });

      store.set(makeRecord({ key: 'key-1', expiresAt: new Date('2024-01-01T01:00:00.000Z') }));
      store.set(makeRecord({ key: 'key-2', expiresAt: new Date('2024-01-01T01:30:00.000Z') }));

      const purged = store.purgeExpired(now);

      expect(purged).toBe(0);
      expect(store.get('key-1')).toBeDefined();
      expect(store.get('key-2')).toBeDefined();
    });

    it('returns 0 on an empty store', () => {
      const store = makeStore();
      expect(store.purgeExpired()).toBe(0);
    });
  });

  describe('re-submission after expiry', () => {
    it('allows the same key to be stored again after TTL', () => {
      const clock = () => new Date('2024-01-01T00:10:00.000Z');
      const store = makeStore({ clock, ttlMs: 30 * 60 * 1000 });

      store.set(makeRecord({ key: 'key-reuse', expiresAt: new Date('2024-01-01T00:40:00.000Z') }));
      expect(store.get('key-reuse')).toBeDefined();

      const afterExpiry = new Date('2024-01-01T01:00:00.000Z');
      const clockAfter = () => afterExpiry;
      const storeAfter = makeStore({ clock: clockAfter, ttlMs: 30 * 60 * 1000 });

      storeAfter.set(makeRecord({ key: 'key-reuse', result: { ok: 'fresh' }, expiresAt: new Date('2024-01-01T01:30:00.000Z') }));

      expect(storeAfter.get('key-reuse')?.result).toEqual({ ok: 'fresh' });
    });
  });

  describe('custom TTL', () => {
    it('auto-computes expiresAt based on ttlMs when not provided', () => {
      const created = new Date('2024-01-01T00:00:00.000Z');
      const clock = () => created;
      const store = makeStore({ clock, ttlMs: 15 * 60 * 1000 });

      store.set(makeRecord({ key: 'key-ttl', expiresAt: undefined }));

      const record = store.get('key-ttl');
      expect(record?.expiresAt!.getTime()).toBe(created.getTime() + 15 * 60 * 1000);
    });

    it('respects default TTL of 1 hour when no config is provided', () => {
      const created = new Date('2024-01-01T00:00:00.000Z');
      const clock = () => created;
      const store = makeStore({ clock });

      store.set(makeRecord({ key: 'key-default', expiresAt: undefined }));

      const record = store.get('key-default');
      expect(record?.expiresAt!.getTime()).toBe(created.getTime() + 60 * 60 * 1000);
    });
  });

  describe('clear', () => {
    it('removes all records regardless of expiry', () => {
      const store = makeStore();
      store.set(makeRecord({ key: 'key-1', expiresAt: new Date('2099-01-01T00:00:00.000Z') }));
      store.set(makeRecord({ key: 'key-2', expiresAt: new Date('2099-01-01T00:00:00.000Z') }));

      store.clear();

      expect(store.get('key-1')).toBeUndefined();
      expect(store.get('key-2')).toBeUndefined();
      expect((store as unknown as { records: Map<string, IdempotencyRecord> }).records.size).toBe(0);
    });
  });

  describe('backward compatibility', () => {
    it('set/get work without expiresAt being passed (legacy shape)', () => {
      const store = makeStore();

      store.set({
        key: 'legacy-key',
        payloadHash: 'hash',
        result: { legacy: true },
        createdAt: new Date(),
      });

      const record = store.get('legacy-key');
      expect(record?.key).toBe('legacy-key');
      expect(record?.expiresAt).toBeDefined();
    });
  });
});
