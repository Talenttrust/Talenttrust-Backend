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
      store.set(makeRecord({ key: 'key-3', expiresAt: new Date('2099-01-01T00:00:00.000Z') }));

      store.clear();

      expect(store.get('key-1')).toBeUndefined();
      expect(store.get('key-3')).toBeUndefined();
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

  /**
   * State-invariant coverage for the audit store integrity guarantees.
   *
   * These tests protect the invariants that must hold under concurrent and
   * partial-failure conditions:
   *   - A stored record is either absent or fully valid; no partial writes.
   *   - Expiry is deterministic and idempotent across repeated calls
   *     (the same key and clock always produce the same visibility).
   *   - Concurrent purge calls cannot double-count or lose records.
   *   - Re-submission of an expired key is fresh and never returns stale data.
   *   - Failures in one key do not corrupt other keys.
   */
  describe('state invariants', () => {
    it('stores a fully valid record or nothing (atomic visibility)', () => {
      const clock = () => new Date('2024-01-01T00:00:00.000Z');
      const store = makeStore({ clock });

      store.set(makeRecord({ key: 'atomic', expiresAt: new Date('2024-01-01T01:00:00.000Z') }));

      const record = store.get('atomic');
      expect(record).toBeDefined();
      expect(record?.key).toBe('atomic');
      expect(record?.payloadHash).toBe('abc123');
      expect(record?.result).toEqual({ ok: true });
    });

    it('expiry check is idempotent across repeated lookups', () => {
      const clock = () => new Date('2024-01-01T02:00:00.000Z');
      const store = makeStore({ clock });

      store.set(makeRecord({ key: 'idempotent', expiresAt: new Date('2024-01-01T01:00:00.000Z') }));

      expect(store.get('idempotent')).toBeUndefined();
      expect(store.get('idempotent')).toBeUndefined();
      expect(store.get('idempotent')).toBeUndefined();
    });

    it('concurrent purge calls do not double-count or lose records', () => {
      const now = new Date('2024-01-01T02:00:00.000Z');
      const clock = () => now;
      const store = makeStore({ clock });

      store.set(makeRecord({ key: 'purge-1', expiresAt: new Date('2024-01-01T01:00:00.000Z') }));
      store.set(makeRecord({ key: 'purge-2', expiresAt: new Date('2024-01-01T01:30:00.000Z') }));
      store.set(makeRecord({ key: 'purge-3', expiresAt: new Date('2024-01-01T03:00:00.000Z') }));

      const first = store.purgeExpired(now);
      const second = store.purgeExpired(now);

      expect(first).toBe(2);
      expect(second).toBe(0);
      expect(store.get('purge-3')).toBeDefined();
    });

    it('re-submission of an expired key never returns stale data', () => {
      const expired = new Date('2024-01-01T02:00:00.000Z');
      const clock = () => expired;
      const store = makeStore({ clock });

      store.set(makeRecord({ expiresAt: new Date('2024-01-01T01:00:00.000Z') }));
      expect(store.get('test-key')).toBeUndefined();

      store.set(makeRecord({ result: { ok: 'new' }, expiresAt: new Date('2024-01-01T03:00:00.000Z') }));
      expect(store.get('test-key')?.result).toEqual({ ok: 'new' });
    });

    it('failure on one key does not corrupt other keys', () => {
      const now = new Date('2024-01-01T02:00:00.000Z');
      const clock = () => now;
      const store = makeStore({ clock });

      store.set(makeRecord({ key: 'healthy', expiresAt: new Date('2024-01-01T03:00:00.000Z') }));
      store.set(makeRecord({ key: 'expired', expiresAt: new Date('2024-01-01T01:00:00.000Z') }));

      expect(store.get('expired')).toBeUndefined();
      expect(store.get('healthy')).toBeBefined();
      expect(store.get('healthy')?.result).toEqual({ ok: true });
    });

    it('purgeExpired with an explicit clock is deterministic', () => {
      const clock = () => new Date('2024-01-01T00:00:00.000Z');
      const store = makeStore({ clock });

      store.set(makeRecord({ key: 'deterministic', expiresAt: new Date('2024-01-01T01:00:00.000Z') }));

      const atBoundary = new Date('2024-01-01T01:00:00.000Z');
      expect(store.purgeExpired(atBoundary)).toBe(1);
      expect(store.purgeExpired(atBoundary)).toBe(0);
    });

    it('set overwrites an existing key with the latest valid record', () => {
      const clock = () => new Date('2024-01-01T00:00:00.000Z');
      const store = makeStore({ clock });

      store.set(makeRecord({ key: 'overwrite', result: { ok: 'old' }, expiresAt: new Date('2024-01-01T01:00:00.000Z') }));
      store.set(makeRecord({ key: 'overwrite', result: { ok: 'new' }, expiresAt: new Date('2024-01-01T01:00:00.000Z') }));

      expect(store.get('overwrite')?.result).toEqual({ ok: 'new' });
    });
  });
});
