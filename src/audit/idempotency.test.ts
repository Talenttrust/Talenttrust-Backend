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

    it('overwrites an existing key on re-set', () => {
      const input1 = makeInput({ actor: 'alice' });
      const input2 = makeInput({ actor: 'bob' });
      const entry1 = makeEntry('entry-1', input1);
      const entry2 = makeEntry('entry-2', input2);

      store.set('key-1', input1, entry1);
      store.set('key-1', input2, entry2);

      expect(store.get('key-1')!.response.actor).toBe('bob');
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
