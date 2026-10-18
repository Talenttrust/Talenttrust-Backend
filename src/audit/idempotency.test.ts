import { IdempotencyConflictError, IdempotencyStore, hashIdempotencyInput } from './idempotency';
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

    it('keeps the original response for an identical duplicate', () => {
      const input = makeInput();
      const firstEntry = makeEntry('entry-1', input);
      const duplicateEntry = makeEntry('entry-2', input);

      store.set('key-1', input, firstEntry);
      store.set('key-1', input, duplicateEntry);

      expect(store.get('key-1')!.response.id).toBe('entry-1');
    });

    it('isolates stored records from mutations by callers', () => {
      const input = makeInput({ metadata: { nested: { note: 'test' } } });
      const entry: AuditEntry = {
        ...makeEntry('entry-1', input),
        metadata: JSON.parse(JSON.stringify(input.metadata)) as Record<string, unknown>,
      };
      store.set('key-1', input, entry);

      entry.actor = 'mutated';
      ((entry.metadata.nested as Record<string, unknown>).note) = 'mutated';
      const retrieved = store.get('key-1')!;
      retrieved.bodyHash = 'tampered';
      (((retrieved.response.metadata.nested as Record<string, unknown>).note)) = 'also mutated';

      expect(() => store.set('key-1', input, makeEntry('entry-2', input))).not.toThrow();
      expect(store.get('key-1')?.response.actor).toBe('user-abc');
      expect(
        (store.get('key-1')?.response.metadata.nested as Record<string, unknown>).note,
      ).toBe('test');
    });

    it('rejects an invalid response without storing the key', () => {
      const input = makeInput();
      const invalidResponse = makeEntry('entry-1', makeInput({ actor: '' }));

      expect(() => store.set('key-1', input, invalidResponse)).toThrow(TypeError);
      expect(store.get('key-1')).toBeUndefined();
    });

    it('rejects reuse of a key for different input without replacing the record', () => {
      const input1 = makeInput({ actor: 'alice' });
      const input2 = makeInput({ actor: 'bob' });
      const entry1 = makeEntry('entry-1', input1);
      const entry2 = makeEntry('entry-2', input2);

      store.set('key-1', input1, entry1);
      expect(() => store.set('key-1', input2, entry2)).toThrow(IdempotencyConflictError);

      expect(store.get('key-1')!.response.actor).toBe('alice');
    });

    it.each(['', '   ', 'bad\nkey', 'x'.repeat(256)])('rejects invalid keys: %j', (key) => {
      expect(() => store.get(key)).toThrow(TypeError);
      expect(() => store.set(key, makeInput(), makeEntry('entry-1', makeInput()))).toThrow(TypeError);
      expect(() => store.delete(key)).toThrow(TypeError);
    });

    it('accepts a key at the maximum supported length', () => {
      const input = makeInput();
      const key = 'x'.repeat(255);
      store.set(key, input, makeEntry('entry-1', input));

      expect(store.get(key)?.response.id).toBe('entry-1');
    });

    it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid maxSize: %p', (maxSize) => {
      expect(() => new IdempotencyStore({ maxSize })).toThrow(RangeError);
    });

    it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid ttlMs: %p', (ttlMs) => {
      expect(() => new IdempotencyStore({ ttlMs })).toThrow(RangeError);
    });

    it('accepts the smallest valid store limits', () => {
      expect(() => new IdempotencyStore({ maxSize: 1, ttlMs: 1 })).not.toThrow();
    });

    it('rejects malformed audit input before storing it', () => {
      const invalidInput = makeInput({ actor: '' });
      expect(() => hashIdempotencyInput(invalidInput)).toThrow(TypeError);
      expect(() => store.set('key-1', invalidInput, makeEntry('entry-1', invalidInput))).toThrow(TypeError);
      expect(store.size()).toBe(0);
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

    it('canonicalizes metadata object keys while preserving array order', () => {
      const input1 = makeInput({ metadata: { nested: { a: 1, b: 2 }, list: [1, 2] } });
      const input2 = makeInput({ metadata: { list: [1, 2], nested: { b: 2, a: 1 } } });
      const input3 = makeInput({ metadata: { list: [2, 1], nested: { b: 2, a: 1 } } });

      expect(hashIdempotencyInput(input1)).toBe(hashIdempotencyInput(input2));
      expect(hashIdempotencyInput(input1)).not.toBe(hashIdempotencyInput(input3));
    });

    it('rejects non-JSON object values instead of colliding with empty metadata', () => {
      const emptyMetadata = makeInput({ metadata: {} });
      const dateMetadata = makeInput({ metadata: new Date('2026-01-01T00:00:00.000Z') as unknown as Record<string, unknown> });

      expect(() => hashIdempotencyInput(dateMetadata)).toThrow(TypeError);
      expect(() => hashIdempotencyInput(emptyMetadata)).not.toThrow();
    });

    it('hash is deterministic regardless of ipAddress/correlationId', () => {
      const input1 = makeInput({ ipAddress: '1.2.3.4', correlationId: 'corr-1' });
      const input2 = makeInput({ ipAddress: '5.6.7.8', correlationId: 'corr-2' });
      expect(hashIdempotencyInput(input1)).toBe(hashIdempotencyInput(input2));
    });
  });

  describe('TTL expiry', () => {
    it('expires entries after TTL', async () => {
      const store = new IdempotencyStore({ ttlMs: 10, maxSize: 100 });
      const input = makeInput();
      const entry = makeEntry('entry-1', input);
      store.set('key-1', input, entry);

      expect(store.get('key-1')).toBeDefined();

      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(store.get('key-1')).toBeUndefined();
    });

    it('size() excludes expired entries', async () => {
      const store = new IdempotencyStore({ ttlMs: 10, maxSize: 100 });
      store.set('key-1', makeInput(), makeEntry('e1', makeInput()));

      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(store.size()).toBe(0);
    });

    it('retains entries within TTL', () => {
      const store = new IdempotencyStore({ ttlMs: 60_000, maxSize: 100 });
      store.set('key-1', makeInput(), makeEntry('e1', makeInput()));
      expect(store.size()).toBe(1);
    });

    it('expires an entry exactly at the TTL boundary', () => {
      jest.useFakeTimers();
      try {
        const store = new IdempotencyStore({ ttlMs: 100 });
        const input = makeInput();
        store.set('key-1', input, makeEntry('entry-1', input));

        jest.advanceTimersByTime(100);

        expect(store.get('key-1')).toBeUndefined();
      } finally {
        jest.useRealTimers();
      }
    });

    it('allows a key to be reused at the TTL boundary', () => {
      jest.useFakeTimers();
      try {
        const store = new IdempotencyStore({ ttlMs: 100 });
        const originalInput = makeInput({ actor: 'alice' });
        const replacementInput = makeInput({ actor: 'bob' });
        store.set('key-1', originalInput, makeEntry('entry-1', originalInput));

        jest.advanceTimersByTime(100);
        store.set('key-1', replacementInput, makeEntry('entry-2', replacementInput));

        expect(store.get('key-1')?.response.id).toBe('entry-2');
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('bounded size', () => {
    it('evicts oldest entry when at max capacity', () => {
      const store = new IdempotencyStore({ maxSize: 2, ttlMs: 60_000 });
      const input = makeInput();

      store.set('key-1', input, makeEntry('e1', input));
      store.set('key-2', input, makeEntry('e2', input));
      store.set('key-3', input, makeEntry('e3', input));

      expect(store.get('key-1')).toBeUndefined();
      expect(store.get('key-2')).toBeDefined();
      expect(store.get('key-3')).toBeDefined();
      expect(store.size()).toBe(2);
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
