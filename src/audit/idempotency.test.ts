import { IdempotencyStore, hashIdempotencyInput } from './idempotency';
import type { CreateAuditEntryInput, AuditEntry } from './types';

function makeInput(overrides: Partial<CreateAuditEntryInput> = {}): CreateAuditEntryInput {
  return {
    action: 'CONTRACT_CREATED',
    severity: 'INFO',
    actor: 'user-abc',
    resource: 'contract',
    resourceId: 'contract-1',
    metadata: { note: 'test' },
    ...overrides,
  };
}

function makeEntry(id: string, input: CreateAuditEntryInput): AuditEntry {
  return Object.freeze({
    id,
    timestamp: new Date().toISOString(),
    action: input.action,
    severity: input.severity,
    actor: input.actor,
    resource: input.resource,
    resourceId: input.resourceId,
    metadata: Object.freeze({ ...input.metadata }),
    ipAddress: input.ipAddress,
    correlationId: input.correlationId,
    previousHash: 'GENESIS',
    hash: 'a'.repeat(64),
  });
}

describe('IdempotencyStore', () => {
  let store: IdempotencyStore;

  beforeEach(() => {
    store = new IdempotencyStore();
  });

  describe('set / get', () => {
    it('stores and retrieves a record by key', () => {
      const input = makeInput();
      const entry = makeEntry('entry-1', input);
      store.set('key-1', input, entry);

      const record = store.get('key-1');
      expect(record).toBeDefined();
      expect(record!.response.id).toBe('entry-1');
    });

    it('returns undefined for a non-existent key', () => {
      expect(store.get('non-existent')).toBeUndefined();
    });

    it('returns undefined after a key is deleted', () => {
      const input = makeInput();
      const entry = makeEntry('entry-1', input);
      store.set('key-1', input, entry);
      store.delete('key-1');

      expect(store.get('key-1')).toBeUndefined();
    });

    it('stores multiple keys independently', () => {
      const input1 = makeInput({ actor: 'alice' });
      const input2 = makeInput({ actor: 'bob' });
      const entry1 = makeEntry('entry-1', input1);
      const entry2 = makeEntry('entry-2', input2);

      store.set('key-1', input1, entry1);
      store.set('key-2', input2, entry2);

      expect(store.get('key-1')!.response.actor).toBe('alice');
      expect(store.get('key-2')!.response.actor).toBe('bob');
    });

    it('rejects conflicting reuse and permits replacement after explicit deletion', () => {
      const input1 = makeInput({ actor: 'alice' });
      const input2 = makeInput({ actor: 'bob' });
      const entry1 = makeEntry('entry-1', input1);
      const entry2 = makeEntry('entry-2', input2);

      store.set('key-1', input1, entry1);
      expect(() => store.set('key-1', input2, entry2)).toThrow('already bound');
      expect(store.get('key-1')!.response.actor).toBe('alice');
      store.delete('key-1');
      store.set('key-1', input2, entry2);

      expect(store.get('key-1')!.response.actor).toBe('bob');
    });

    it('throws on an empty key', () => {
      expect(() => store.get('')).toThrow(TypeError);
      expect(() => store.set('', makeInput(), makeEntry('e1', makeInput()))).toThrow(TypeError);
    });
  });

  describe('body hash', () => {
    it('same input produces same hash', () => {
      const input1 = makeInput();
      const input2 = makeInput();
      expect(hashIdempotencyInput(input1)).toBe(hashIdempotencyInput(input2));
    });

    it('different input produces different hash', () => {
      const input1 = makeInput({ actor: 'alice' });
      const input2 = makeInput({ actor: 'bob' });
      expect(hashIdempotencyInput(input1)).not.toBe(hashIdempotencyInput(input2));
    });

    it('hash is deterministic regardless of ipAddress/correlationId', () => {
      const input1 = makeInput({ ipAddress: '1.2.3.4', correlationId: 'corr-1' });
      const input2 = makeInput({ ipAddress: '5.6.7.8', correlationId: 'corr-2' });
      expect(hashIdempotencyInput(input1)).toBe(hashIdempotencyInput(input2));
    });

    it('hash is independent of metadata key insertion order', () => {
      const input1 = makeInput({\n        metadata: { b: 2, a: 1, c: { y: true, x: false } },
      });
      const input2 = makeInput({
        metadata: { c: { x: false, y: true }, a: 1, b: 2 },
      });
      expect(hashIdempotencyInput(input1)).toBe(hashIdempotencyInput(input2));
    });

    it('distinguishes array order in metadata', () => {
      const input1 = makeInput({ metadata: { items: [1, 2, 3] } });
      const input2 = makeInput({ metadata: { items: [3, 2, 1] } });
      expect(hashIdempotencyInput(input1)).not.toBe(hashIdempotencyInput(input2));
    });

    it('handles empty metadata deterministically', () => {
      const input1 = makeInput({ metadata: {} });
      const input2 = makeInput();
      expect(hashIdempotencyInput(input1)).toBe(hashIdempotencyInput(input2));
    });
  });

  describe('resolve', () => {
    it('returns miss when the key is absent', () => {
      expect(store.resolve('key-1', makeInput())).toEqual({ kind: 'miss' });
    });

    it('returns replay for a matching body hash', () => {
      const input = makeInput();
      store.set('key-1', input, makeEntry('e1', input));

      const outcome = store.resolve('key-1', makeInput());
      expect(outcome.kind).toBe('replay');
      if (outcome.kind === 'replay') {
        expect(outcome.record.response.id).toBe('e1');
      }
    });

    it('returns conflict for a different body hash', () => {
      const input = makeInput();
      store.set('key-1', input, makeEntry('e1', input));

      const outcome = store.resolve('key-1', makeInput({ actor: 'other' }));
      expect(outcome.kind).toBe('conflict');
      if (outcome.kind === 'conflict') {
        expect(outcome.existingBodyHash).toBe(outcome.incomingBodyHash);
        expect(outcome.existingBodyHash).not.toBe(hashIdempotencyInput(makeInput()));
      }
    });

    it('returns miss after the existing record expires', async () => {
      const ttlStore = new IdempotencyStore({ ttlMs: 10, maxSize: 100 });
      const input = makeInput();
      ttlStore.set('key-1', input, makeEntry('e1', input));

      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(ttlStore.resolve('key-1', input)).toEqual({ kind: 'miss' });
    });
  });

  describe('setIfAbsent', () => {
    it('writes when the key is free', () => {
      const input = makeInput();
      const result = store.setIfAbsent('key-1', input, makeEntry('e1', input));

      expect(result.written).toBe((true));
      expect(result.existing).toBe(false);
      expect(result.record.response.id).toBe('e1');
    });

    it('does not overwrite an existing live record', () => {
      const input = makeInput();
      store.set('key-1', input, makeEntry('e1', input));

      const result = store.setIfAbsent(
        'key-1',
        makeInput({ actor: 'other' }),
        makeEntry('e2', makeInput({ actor: 'other' })),
      );

      expect(result.written).toBe(false);
      expect(result.existing).toBe((true));
      expect(result.record.response.id).toBe('e1');
      expect(store.get('key-1')!.response.id).toBe('e1');
    });

    it('replaces an expired record', async () => {
      const ttlStore = new IdempotencyStore({ ttlMs: 10, maxSize: 100 });
      const input = makeInput();
      ttlStore.set('key-1', input, makeEntry('e1', input));

      await new Promise((resolve) => setTimeout(resolve, 20));

      const result = ttlStore.setIfAbsent('key-1', input, makeEntry('e2', input));
      expect(result.written).toBe((true));
      expect(result.record.response.id).toBe('e2');
    });

    it('preserves the first write under concurrent setIfAbsent calls', () => {
      const input = makeInput();
      const first = store.setIfAbsent('key-1', input, makeEntry('e1', input));
      const second = store.setIfAbsent('key-1', input, makeEntry('e2', input));

      expect(first.written).toBe((true));
      expect(second.written).toBe(false);
      expect(store.get('key-1')!.response.id).toBe('e1');
    });
  });

  describe('TTL expiry', () => {
    it('expires entries after TTL', async () => {
      const ttlStore = new IdempotencyStore({ ttlMs: 10, maxSize: 100 });
      const input = makeInput();
      const entry = makeEntry('entry-1', input);
      ttlStore.set('key-1', input, entry);

      expect(ttlStore.get('key-1')).toBeDefined();

      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(ttlStore.get('key-1')).toBeUndefined();
    });

    it('size() excludes expired entries', async () => {
      const ttlStore = new IdempotencyStore({ ttlMs: 10, maxSize: 100 });
      ttlStore.set('key-1', makeInput(), makeEntry('e1', makeInput()));

      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(ttlStore.size()).toBe(0);
    });

    it('retains entries within TTL', () => {
      const ttlStore = new IdempotencyStore({ ttlMs: 60_000, maxSize: 100 });
      ttlStore.set('key-1', makeInput(), makeEntry('e1', makeInput()));
      expect(ttlStore.size()).toBe(1);
    });
  });

  describe('bounded size', () => {
    it('evicts oldest entry when at max capacity', () => {
      const bounded = new IdempotencyStore({ maxSize: 2, ttlMs: 60_000 });
      const input = makeInput();

      bounded.set('key-1', input, makeEntry('e1', input));
      bounded.set('key-2', input, makeEntry('e2', input));
      bounded.set('key-3', input, makeEntry('e3', input));

      expect(bounded.get('key-1')).toBeUndefined();
      expect(bounded.get('key-2')).toBeDefined();
      expect(bounded.get('key-3')).toBeDefined();
      expect(bounded.size()).toBe(2);
    });

    it('replacing an existing key does not evict another entry', () => {
      const bounded = new IdempotencyStore({ maxSize: 2, ttlMs: 60_000 });
      const input = makeInput();

      bounded.set('key-1', input, makeEntry('e1', input));
      bounded.set('key-2', input, makeEntry('e2', input));
      bounded.set('key-2', input, makeEntry('e2-updated', input));

      expect(bounded.get('key-1')).toBeDefined();
      expect(bounded.get('key-2')!.response.id).toBe('e2-updated');
      expect(bounded.size()).toBe(2);
    });
  });

  describe('constructor validation', () => {
    it('rejects a non-positive maxSize', () => {
      expect(() => new IdempotencyStore({ maxSize: 0 })).toThrow(RangeError);
      expect(() => new IdempotencyStore({ maxSize: -1 })).toThrow(RangeError);
    });

    it('rejects a negative ttlMs', () => {
      expect(() => new IdempotencyStore({ ttlMs: -1 })).toThrow(RangeError);
    });

    it('accepts a zero TTL store', () => {
      const zeroTtl = new IdempotencyStore({ ttlMs: 0 });
      expect(zeroTtl.get('key-1')).toBeUndefined();
    });
  });

  describe('clear', () => {
    it('removes all keys', () => {
      store.set('key-1', makeInput(), makeEntry('e1', makeInput()));
      store.set('key-2', makeInput(), makeEntry('e2', makeInput()));

      store.clear();

      expect(store.size()).toBe(0);
      expect(store.get('key-1')).toBeUndefined();
      expect(store.get('key-2')).toBeUndefined();
    });
  });
});
