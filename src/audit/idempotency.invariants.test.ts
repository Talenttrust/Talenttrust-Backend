import { AuditIdempotencyError, IdempotencyStore, hashIdempotencyInput } from './idempotency';
import type { AuditEntry, CreateAuditEntryInput } from './types';

function input(metadata: Record<string, unknown> = {}): CreateAuditEntryInput {
  return { action: 'USER_CREATED', severity: 'INFO', actor: 'alice', resource: 'user', resourceId: 'u1', metadata };
}
function entry(payload: CreateAuditEntryInput, id = 'entry-1'): AuditEntry {
  return { ...payload, id, timestamp: '2026-09-30T00:00:00.000Z', previousHash: 'GENESIS', hash: 'a'.repeat(64) };
}

describe('audit idempotency state invariants', () => {
  beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(1000); });
  afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid maxSize %s', maxSize => {
    expect(() => new IdempotencyStore({ maxSize })).toThrow(RangeError);
  });
  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid ttlMs %s', ttlMs => {
    expect(() => new IdempotencyStore({ ttlMs })).toThrow(RangeError);
  });
  it.each(['', ' ', '\n', 'x'.repeat(257)])('rejects invalid keys without touching a full store', key => {
    const store = new IdempotencyStore({ maxSize: 1 });
    const payload = input();
    store.set('original', payload, entry(payload));
    expect(() => store.set(key, payload, entry(payload))).toThrow(AuditIdempotencyError);
    expect(store.get('original')!.response.id).toBe('entry-1');
    expect(store.size()).toBe(1);
    expect(() => store.get(key)).toThrow(AuditIdempotencyError);
    expect(() => store.delete(key)).toThrow(AuditIdempotencyError);
  });

  it('accepts the maximum key length and one-record/one-millisecond bounds', () => {
    const store = new IdempotencyStore({ maxSize: 1, ttlMs: 1 });
    const payload = input();
    store.set('x'.repeat(256), payload, entry(payload));
    expect(store.size()).toBe(1);
    jest.setSystemTime(1001);
    expect(store.get('x'.repeat(256))).toBeUndefined();
    expect(store.size()).toBe(0);
  });

  it('failed preparation cannot evict an unrelated live record', () => {
    const store = new IdempotencyStore({ maxSize: 1 });
    const payload = input();
    store.set('original', payload, entry(payload));
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const bad = input(circular);
    expect(() => store.set('replacement', bad, entry(bad))).toThrow(AuditIdempotencyError);
    expect(store.get('original')!.response.id).toBe('entry-1');
    expect(store.get('replacement')).toBeUndefined();
    expect(store.size()).toBe(1);
    store.set('replacement', payload, entry(payload, 'entry-2'));
    expect(store.get('original')).toBeUndefined();
    expect(store.get('replacement')!.response.id).toBe('entry-2');
  });

  it('equivalent replay retains the first response, timestamp and FIFO position', () => {
    const store = new IdempotencyStore({ maxSize: 2, ttlMs: 100 });
    const payload = input({ a: 1, b: { x: 2, y: 3 } });
    store.set('first', payload, entry(payload));
    const original = store.get('first');
    store.set('second', payload, entry(payload, 'entry-2'));
    jest.setSystemTime(1050);
    const reordered = input({ b: { y: 3, x: 2 }, a: 1 });
    store.set('first', reordered, entry(reordered, 'different-result'));
    expect(store.get('first')).toBe(original);
    expect(store.get('first')!.createdAt).toBe(1000);
    expect(store.size()).toBe(2);
    store.set('third', payload, entry(payload, 'entry-3'));
    expect(store.get('first')).toBeUndefined();
    expect(store.get('second')!.response.id).toBe('entry-2');
  });

  it('conflicting actor/resource reuse is rejected with a stable safe error and preserves all records', () => {
    const store = new IdempotencyStore({ maxSize: 2 });
    const payload = input({ secret: 'CANARY' });
    store.set('secret-key', payload, entry(payload));
    store.set('other', payload, entry(payload, 'entry-2'));
    const conflict = { ...payload, actor: 'bob', resourceId: 'u2' };
    try {
      store.set('secret-key', conflict, entry(conflict));
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toMatchObject({ code: 'audit_idempotency_conflict' });
      expect(String(error)).not.toMatch(/CANARY|secret-key|alice|bob|u2/);
    }
    expect(store.get('secret-key')!.response.actor).toBe('alice');
    expect(store.get('other')!.response.id).toBe('entry-2');
    expect(store.size()).toBe(2);
  });

  it('snapshots nested response data and exposes deeply frozen records', () => {
    const store = new IdempotencyStore();
    const nested = { tags: ['original'], detail: { count: 1 } };
    const payload = input(nested);
    const response = entry(payload);
    store.set('key', payload, response);
    const stored = store.get('key')!;
    nested.tags.push('mutated');
    nested.detail.count = 99;
    Reflect.set(response, 'actor', 'changed');
    expect(stored.response.metadata).toEqual({ tags: ['original'], detail: { count: 1 } });
    expect(stored.response.actor).toBe('alice');
    expect(Reflect.set(stored, 'createdAt', 9999)).toBe(false);
    expect(Reflect.set(stored.response.metadata.detail as object, 'count', 3)).toBe(false);
    expect(Object.isFrozen(stored.response.metadata.tags)).toBe(true);
    expect(stored.bodyHash).toBe(hashIdempotencyInput(input({ tags: ['original'], detail: { count: 1 } })));
  });

  it('rejects an input/response mismatch before changing capacity or an existing binding', () => {
    const store = new IdempotencyStore({ maxSize: 1 });
    const payload = input();
    store.set('existing', payload, entry(payload));
    expect(() => store.set('new', payload, entry({ ...payload, actor: 'bob' }))).toThrow(AuditIdempotencyError);
    expect(() => store.set('existing', payload, {} as AuditEntry)).toThrow(AuditIdempotencyError);
    expect(store.get('existing')!.response.actor).toBe('alice');
    expect(store.size()).toBe(1);
  });

  it('expires at the exact TTL boundary and allows a fresh binding', () => {
    const store = new IdempotencyStore({ ttlMs: 100 });
    const payload = input();
    store.set('key', payload, entry(payload));
    jest.setSystemTime(1099);
    expect(store.get('key')).toBeDefined();
    store.set('key', payload, entry(payload, 'replay'));
    jest.setSystemTime(1100);
    expect(store.get('key')).toBeUndefined();
    const different = { ...payload, actor: 'bob' };
    store.set('key', different, entry(different));
    expect(store.get('key')!.response.actor).toBe('bob');
    expect(store.get('key')!.createdAt).toBe(1100);
  });

  it('size and insertion use the same expiry boundary', () => {
    const store = new IdempotencyStore({ maxSize: 2, ttlMs: 100 });
    const payload = input();
    store.set('old', payload, entry(payload));
    jest.setSystemTime(1050);
    store.set('live', payload, entry(payload));
    jest.setSystemTime(1100);
    expect(store.size()).toBe(1);
    store.set('new', payload, entry(payload));
    expect(store.get('old')).toBeUndefined();
    expect(store.get('live')).toBeDefined();
    expect(store.size()).toBe(2);
  });

  it('clock rollback cannot rejuvenate an already aged record', () => {
    const store = new IdempotencyStore({ ttlMs: 100 });
    const payload = input();
    store.set('key', payload, entry(payload));
    jest.setSystemTime(1099);
    store.get('key');
    jest.setSystemTime(900);
    store.set('other', payload, entry(payload));
    expect(store.get('other')!.createdAt).toBe(1099);
    jest.setSystemTime(1100);
    expect(store.get('key')).toBeUndefined();
    expect(store.get('other')).toBeDefined();
  });

  it('delete and clear intentionally release completed bindings', () => {
    const store = new IdempotencyStore();
    const payload = input();
    store.set('key', payload, entry(payload));
    store.delete('key');
    store.delete('key');
    const replacement = { ...payload, actor: 'bob' };
    store.set('key', replacement, entry(replacement));
    store.clear();
    store.clear();
    expect(store.size()).toBe(0);
    store.set('key', payload, entry(payload));
    expect(store.get('key')!.response.actor).toBe('alice');
  });

  it('overlapping promise continuations retain one result without exceeding capacity', async () => {
    const store = new IdempotencyStore({ maxSize: 1 });
    const payload = input();
    await Promise.all(Array.from({ length: 20 }, (_, index) => Promise.resolve().then(() => {
      store.set('key', payload, entry(payload, `entry-${index}`));
    })));
    expect(store.get('key')!.response.id).toBe('entry-0');
    expect(store.size()).toBe(1);
  });

  it('canonical fingerprints sort objects recursively but preserve array order', () => {
    expect(hashIdempotencyInput(input({ b: [1, 2], a: { z: 1, x: 2 } })))
      .toBe(hashIdempotencyInput(input({ a: { x: 2, z: 1 }, b: [1, 2] })));
    expect(hashIdempotencyInput(input({ a: [1, 2] }))).not.toBe(hashIdempotencyInput(input({ a: [2, 1] })));
  });

  it.each([undefined, NaN, Infinity, BigInt(1), new Date(), new Map(), () => 1])('rejects non-JSON metadata %s', value => {
    expect(() => hashIdempotencyInput(input({ value }))).toThrow(AuditIdempotencyError);
  });
  it('rejects accessors without executing them, and rejects sparse/extended arrays', () => {
    const getter = jest.fn(() => 'secret');
    const metadata = Object.defineProperty({}, 'value', { enumerable: true, get: getter });
    expect(() => hashIdempotencyInput(input(metadata))).toThrow(AuditIdempotencyError);
    expect(getter).not.toHaveBeenCalled();
    expect(() => hashIdempotencyInput(input({ sparse: Array(2) }))).toThrow(AuditIdempotencyError);
    expect(() => hashIdempotencyInput(input({ array: Object.assign([1], { extra: 2 }) }))).toThrow(AuditIdempotencyError);
  });
  it('rejects missing fields and unknown action/severity using safe messages', () => {
    for (const payload of [null, { ...input(), actor: '' }, { ...input(), action: 'unknown' }, { ...input(), severity: 'unknown' }]) {
      expect(() => hashIdempotencyInput(payload as CreateAuditEntryInput)).toThrow(AuditIdempotencyError);
    }
  });
  it.each([null, [], 'metadata'])('rejects metadata that is not a JSON object: %s', metadata => {
    expect(() => hashIdempotencyInput({ ...input(), metadata } as CreateAuditEntryInput)).toThrow(AuditIdempotencyError);
  });
  it('supports all additional actions in the public typed contract', () => {
    for (const action of ['CONTRACT_DELETED', 'MILESTONES_CREATED', 'MILESTONES_UPDATED', 'MILESTONES_DELETED'] as const) {
      expect(hashIdempotencyInput({ ...input(), action })).toMatch(/^[a-f0-9]{64}$/);
    }
  });
  it('rejects excessive depth and symbol data instead of silently losing fingerprint content', () => {
    let nested: Record<string, unknown> = {};
    for (let level = 0; level < 65; level++) nested = { nested };
    expect(() => hashIdempotencyInput(input(nested))).toThrow(AuditIdempotencyError);
    expect(() => hashIdempotencyInput(input({ [Symbol('secret')]: 1 }))).toThrow(AuditIdempotencyError);
  });
  it('copies repeated references as JSON data without mistaking them for cycles', () => {
    const shared = { value: 1 };
    expect(hashIdempotencyInput(input({ a: shared, b: shared })))
      .toBe(hashIdempotencyInput(input({ a: { value: 1 }, b: { value: 1 } })));
  });
  it('invalid clock values cannot evict a stored response', () => {
    const store = new IdempotencyStore({ maxSize: 1 });
    const payload = input();
    store.set('existing', payload, entry(payload));
    const clock = jest.spyOn(Date, 'now').mockReturnValue(NaN);
    expect(() => store.set('new', payload, entry(payload))).toThrow(AuditIdempotencyError);
    clock.mockRestore();
    expect(store.get('existing')!.response.id).toBe('entry-1');
    expect(store.get('new')).toBeUndefined();
  });
});
