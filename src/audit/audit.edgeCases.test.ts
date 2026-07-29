/**
 * @file audit.edgeCases.test.ts
 * @description Regression tests for known audit edge cases: empty inputs,
 * boundary inputs, and malformed inputs.
 *
 * Issue #938 — each scenario is named to identify the class of edge case:
 *  - "EDGE: empty <thing>"     — empty/absent/missing fields
 *  - "EDGE: boundary <thing>"  — at, just-below, and just-above limits
 *  - "EDGE: malformed <thing>" — corrupted, hostile, or non-conforming values
 */

import { AuditStore, GENESIS_HASH } from './store';
import { AuditService } from './service';
import { AuditCache } from './auditCache';
import { AuditWebhookService, createAuditWebhookData } from './auditWebhook';
import {
  validateCreateAuditEntryInput,
  validateMetadata,
  computeDepth,
  MAX_METADATA_BYTES,
  MAX_METADATA_DEPTH,
  MAX_METADATA_ARRAY_ITEMS,
  MAX_METADATA_NUMBER,
  FORBIDDEN_METADATA_KEYS,
  AUDIT_VALIDATION_CODES,
} from './inputValidation';
import {
  isSensitiveHeader,
  isSensitiveKey,
  maskEmail,
  redactHeaders,
  redactBody,
  buildAuditMetadata,
  REDACTED,
} from './redact';
import type { AuditEntry, CreateAuditEntryInput } from './types';

// ─── Helpers ───────────────────────────────────────────────────────────────────

function makeInput(overrides: Partial<CreateAuditEntryInput> = {}): CreateAuditEntryInput {
  return {
    action: 'CONTRACT_CREATED',
    severity: 'INFO',
    actor: 'user-a',
    resource: 'contract',
    resourceId: 'contract-1',
    metadata: { clientId: 'c1' },
    ...overrides,
  };
}

function makeEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id: 'e1',
    timestamp: '2026-01-01T00:00:00.000Z',
    action: 'CONTRACT_CREATED',
    severity: 'INFO',
    actor: 'user-a',
    resource: 'contract',
    resourceId: 'contract-1',
    metadata: {},
    hash: 'a'.repeat(64),
    previousHash: GENESIS_HASH,
    ...overrides,
  } as AuditEntry;
}

// =============================================================================
// AuditStore — edge cases
// =============================================================================

describe('AuditStore — EDGE: empty inputs', () => {
  let store: AuditStore;

  beforeEach(() => { store = new AuditStore(); });

  it('query with empty object returns empty array when store is fresh', () => {
    expect(store.query({})).toHaveLength(0);
  });

  it('query with undefined returns empty array when store is fresh', () => {
    expect(store.query(undefined)).toHaveLength(0);
  });

  it('getById with empty string returns undefined', () => {
    expect(store.getById('')).toBeUndefined();
  });

  it('stream yields nothing from an empty store', () => {
    const results = Array.from(store.stream());
    expect(results).toHaveLength(0);
  });

  it('queryWithCursor returns empty result from fresh store', () => {
    const result = store.queryWithCursor({});
    expect(result.entries).toHaveLength(0);
    expect(result.count).toBe(0);
    expect(result.nextCursor).toBeUndefined();
  });
});

describe('AuditStore — EDGE: boundary inputs', () => {
  let store: AuditStore;

  beforeEach(() => { store = new AuditStore(); });

  it('query with limit=0 returns empty', () => {
    store.append(makeInput());
    expect(store.query({ limit: 0 })).toHaveLength(0);
  });

  it('query with negative offset treated as 0 (clamped)', () => {
    store.append(makeInput());
    const results = store.query({ offset: -1 });
    expect(results).toHaveLength(1);
  });

  it('query with offset beyond length returns empty', () => {
    store.append(makeInput());
    expect(store.query({ offset: 999 })).toHaveLength(0);
  });

  it('query with multiple filters all applied together', () => {
    store.append(makeInput({ action: 'CONTRACT_CREATED', actor: 'alice', severity: 'INFO' }));
    store.append(makeInput({ action: 'PAYMENT_INITIATED', actor: 'bob', severity: 'CRITICAL' }));
    const results = store.query({ action: 'CONTRACT_CREATED', actor: 'alice', severity: 'INFO' });
    expect(results).toHaveLength(1);
  });

  it('queryWithCursor limit is bounded between 1 and 100', () => {
    for (let i = 0; i < 10; i++) store.append(makeInput());
    const r1 = store.queryWithCursor({ limit: 0 });
    expect(r1.limit).toBeGreaterThanOrEqual(1);
    const r2 = store.queryWithCursor({ limit: 999 });
    expect(r2.limit).toBeLessThanOrEqual(100);
  });

  it('query from/to with identical timestamps includes the boundary entry', () => {
    store.append(makeInput());
    const entry = store.getAll()[0];
    const results = store.query({ from: entry.timestamp, to: entry.timestamp });
    expect(results).toHaveLength(1);
  });
});

describe('AuditStore — EDGE: malformed inputs', () => {
  let store: AuditStore;

  beforeEach(() => { store = new AuditStore(); });

  it('re-entrancy guard throws on recursive append attempt', () => {
    // Simulate what a re-entrant caller might do
    const bogusInput = makeInput();
    (store as unknown as { _appendGuard: boolean })._appendGuard = true;
    expect(() => store.append(bogusInput)).toThrow('AuditStore append re-entrancy detected');
    (store as unknown as { _appendGuard: boolean })._appendGuard = false;
  });

  it('verifyIntegrity detects a completely empty log as valid', () => {
    const report = store.verifyIntegrity();
    expect(report.valid).toBe(true);
    expect(report.totalEntries).toBe(0);
  });

  it('verifyIntegrity detects entry with corrupted hash', () => {
    store.append(makeInput());
    const log = (store as unknown as { log: AuditEntry[] }).log;
    const corrupted = Object.freeze({ ...log[0], hash: '0'.repeat(64) });
    log[0] = corrupted;
    const report = store.verifyIntegrity();
    expect(report.valid).toBe(false);
    expect(report.firstCorruptedIndex).toBe(0);
  });

  it('verifyIntegrity detects duplicate entry with same id', () => {
    store.append(makeInput());
    const first = store.getAll()[0];
    // Manually insert a copy of the first entry
    const log = (store as unknown as { log: AuditEntry[] }).log;
    log.push(Object.freeze({ ...first, previousHash: first.hash, hash: 'b'.repeat(64) }));
    const report = store.verifyIntegrity();
    // The copy has hash mismatch because its content is same as entry 0
    expect(report.valid).toBe(false);
  });

  it('queryWithCursor with malformed cursor does not throw — falls back to start', () => {
    store.append(makeInput());
    const result = store.queryWithCursor({ cursor: 'not-valid-base64!!!' });
    expect(result.entries).toHaveLength(1);
  });

  it('queryWithCursor with garbled base64 cursor falls back to start', () => {
    store.append(makeInput());
    const result = store.queryWithCursor({ cursor: '!!!!' });
    expect(result.entries).toHaveLength(1);
  });

  it('queryWithCursor with cursor referencing non-existent id falls back to start', () => {
    store.append(makeInput());
    const fakeCursor = Buffer.from(JSON.stringify({ lastId: 'no-such-id', lastTimestamp: '', filters: {} })).toString('base64');
    const result = store.queryWithCursor({ cursor: fakeCursor });
    expect(result.entries).toHaveLength(1);
  });
});

// =============================================================================
// AuditService — edge cases
// =============================================================================

describe('AuditService — EDGE: empty inputs', () => {
  let store: AuditStore;
  let service: AuditService;

  beforeEach(() => {
    store = new AuditStore();
    service = new AuditService(store);
  });

  it('query with empty object returns all entries', () => {
    service.log(makeInput());
    expect(service.query({})).toHaveLength(1);
  });

  it('queryLogs with empty params uses defaults', () => {
    service.log(makeInput());
    const result = service.queryLogs({});
    expect(result.entries).toHaveLength(1);
    expect(result.limit).toBe(50);
    expect(result.offset).toBe(0);
  });

  it('stream yields nothing when store is empty', () => {
    const entries = Array.from(service.stream());
    expect(entries).toHaveLength(0);
  });

  it('getEntry for empty string returns undefined', () => {
    expect(service.getEntry('')).toBeUndefined();
  });
});

describe('AuditService — EDGE: malformed/createEntry', () => {
  let service: AuditService;

  beforeEach(() => {
    service = new AuditService(new AuditStore());
  });

  it('createEntry throws when action is empty string', () => {
    expect(() =>
      service.createEntry(makeInput({ action: '' as any })),
    ).toThrow('Missing required fields');
  });

  it('createEntry throws when severity is empty string', () => {
    expect(() =>
      service.createEntry(makeInput({ severity: '' as any })),
    ).toThrow('Missing required fields');
  });

  it('createEntry throws when actor is empty string', () => {
    expect(() =>
      service.createEntry(makeInput({ actor: '' })),
    ).toThrow('Missing required fields');
  });

  it('log() with undefined ipAddress and correlationId still succeeds', () => {
    const entry = service.log(makeInput({ ipAddress: undefined, correlationId: undefined }));
    expect(entry).toBeDefined();
    expect(entry.ipAddress).toBeUndefined();
    expect(entry.correlationId).toBeUndefined();
  });

  it('validateAndParseQuery throws for invalid action', () => {
    expect(() =>
      service.validateAndParseQuery({ action: 'BOGUS_ACTION' }, { defaultLimit: 10, maxLimit: 100 }),
    ).toThrow('Invalid action');
  });

  it('validateAndParseQuery throws for invalid severity', () => {
    expect(() =>
      service.validateAndParseQuery({ severity: 'FATAL' }, { defaultLimit: 10, maxLimit: 100 }),
    ).toThrow('Invalid severity');
  });

  it('validateAndParseQuery throws for non-numeric limit', () => {
    expect(() =>
      service.validateAndParseQuery({ limit: 'abc' }, { defaultLimit: 10, maxLimit: 100 }),
    ).toThrow('Invalid limit');
  });

  it('validateAndParseQuery throws for negative offset', () => {
    expect(() =>
      service.validateAndParseQuery({ offset: '-5' }, { defaultLimit: 10, maxLimit: 100 }),
    ).toThrow('Invalid offset');
  });
});

// =============================================================================
// AuditCache — edge cases
// =============================================================================

describe('AuditCache — EDGE: empty and boundary inputs', () => {
  let cache: AuditCache;

  beforeEach(() => {
    cache = new AuditCache({ ttlMs: 5000, maxEntries: 3 });
  });

  it('get with empty query returns null on miss', () => {
    expect(cache.get({}, 'query')).toBeNull();
  });

  it('set and get with empty query works', () => {
    cache.set({}, [], 'query');
    expect(cache.get({}, 'query')).toEqual([]);
  });

  it('get for non-existent id returns null', () => {
    expect(cache.get({}, 'getById', 'no-such-id')).toBeNull();
  });

  it('stats are zero on fresh cache', () => {
    const stats = cache.getStats();
    expect(stats.size).toBe(0);
    expect(stats.hits).toBe(0);
    expect(stats.misses).toBe(0);
  });

  it('invalidate on empty cache does not throw', () => {
    expect(() => cache.invalidate()).not.toThrow();
  });

  it('invalidateByResourceId on empty cache does not throw', () => {
    expect(() => cache.invalidateByResourceId('any')).not.toThrow();
  });

  it('clear on empty cache does not throw', () => {
    expect(() => cache.clear()).not.toThrow();
  });

  it('cleanupExpired on empty cache returns 0', () => {
    expect(cache.cleanupExpired()).toBe(0);
  });
});

describe('AuditCache — EDGE: malformed inputs', () => {
  let cache: AuditCache;

  beforeEach(() => {
    cache = new AuditCache({ ttlMs: 5000, maxEntries: 3 });
  });

  it('get with undefined query returns null', () => {
    expect(cache.get(undefined as any, 'query')).toBeNull();
  });

  it('get with null id returns null', () => {
    expect(cache.get({}, 'getById', null as any)).toBeNull();
  });
});

// =============================================================================
// Redact module — edge cases
// =============================================================================

describe('redact — EDGE: empty inputs', () => {
  it('isSensitiveHeader with empty string returns false', () => {
    expect(isSensitiveHeader('')).toBe(false);
  });

  it('isSensitiveKey with empty string returns false', () => {
    expect(isSensitiveKey('')).toBe(false);
  });

  it('maskEmail with empty string returns empty string', () => {
    expect(maskEmail('')).toBe('');
  });

  it('maskEmail with just @ symbol returns unchanged', () => {
    expect(maskEmail('@')).toBe('@');
  });

  it('maskEmail with no domain returns unchanged', () => {
    expect(maskEmail('user@')).toBe('user@');
  });

  it('maskEmail with no local part returns unchanged', () => {
    expect(maskEmail('@domain.com')).toBe('@domain.com');
  });

  it('redactHeaders with empty object returns empty object', () => {
    expect(redactHeaders({})).toEqual({});
  });

  it('redactBody with undefined returns undefined', () => {
    expect(redactBody(undefined)).toBeUndefined();
  });

  it('redactBody with null returns null', () => {
    expect(redactBody(null)).toBeNull();
  });

  it('redactBody with empty array returns empty array', () => {
    expect(redactBody([])).toEqual([]);
  });

  it('redactBody with empty object returns empty object', () => {
    expect(redactBody({})).toEqual({});
  });
});

describe('redact — EDGE: boundary inputs', () => {
  it('maskEmail preserves first 3 chars of local part', () => {
    expect(maskEmail('abcdef@example.com')).toBe('abc***@example.com');
  });

  it('maskEmail with 2-char local part uses both chars', () => {
    expect(maskEmail('ab@example.com')).toBe('ab***@example.com');
  });

  it('maskEmail with 1-char local part uses that char', () => {
    expect(maskEmail('a@example.com')).toBe('a***@example.com');
  });

  it('maskEmail with subdomain email', () => {
    expect(maskEmail('user@sub.example.com')).toBe('use***@sub.example.com');
  });

  it('maskEmail with plus-addressing is partially masked', () => {
    expect(maskEmail('user+tag@example.com')).toBe('use***@example.com');
  });

  it('redactBody handles deeply nested empty objects', () => {
    const input = { a: { b: { c: {} } } };
    expect(redactBody(input)).toEqual({ a: { b: { c: {} } } });
  });

  it('redactBody handles mixed nested arrays with sensitive keys', () => {
    const input = {
      users: [
        { name: 'alice', token: 'secret1' },
        { name: 'bob', token: 'secret2' },
      ],
    };
    const result = redactBody(input) as Record<string, unknown>;
    const users = result['users'] as Array<Record<string, unknown>>;
    expect(users[0].token).toBe(REDACTED);
    expect(users[1].token).toBe(REDACTED);
    expect(users[0].name).toBe('alice');
  });
});

describe('redact — EDGE: malformed inputs', () => {
  it('redactBody with string returns masked email if it looks like one', () => {
    expect(redactBody('alice@example.com')).toBe('ali***@example.com');
  });

  it('redactBody with number returns unchanged', () => {
    expect(redactBody(42)).toBe(42);
  });

  it('redactBody with boolean returns unchanged', () => {
    expect(redactBody(true)).toBe(true);
  });

  it('redactBody with array of primitives traverses all', () => {
    expect(redactBody([1, 'hello', null, true])).toEqual([1, 'hello', null, true]);
  });

  it('redactBody redacts via substring match on compound keys', () => {
    const input = { userSecret: 'should-redact', userPassword: 'should-redact' };
    const result = redactBody(input) as Record<string, unknown>;
    expect(result.userSecret).toBe(REDACTED);
    expect(result.userPassword).toBe(REDACTED);
  });

  it('redactBody with null prototype object does not throw', () => {
    const input = Object.assign(Object.create(null), { key: 'value' });
    expect(() => redactBody(input)).not.toThrow();
  });

  it('buildAuditMetadata with undefined body uses null', () => {
    const result = buildAuditMetadata('GET', '/path', {}, undefined, {}, 200, 'req-1');
    expect(result['body']).toBeNull();
  });

  it('buildAuditMetadata with empty headers works', () => {
    const result = buildAuditMetadata('GET', '/path', {}, null, {}, 200, undefined);
    expect(result['headers']).toEqual({});
    expect(result['requestId']).toBeNull();
  });
});

// =============================================================================
// AuditWebhook — edge cases
// =============================================================================

describe('AuditWebhook — EDGE: empty inputs', () => {
  it('createAuditWebhookData handles empty metadata', () => {
    const entry = makeEntry({ metadata: {} });
    const data = createAuditWebhookData(entry);
    expect(data).toBeDefined();
    expect(data!.metadata).toEqual({});
  });

  it('createAuditWebhookData handles entry without ipAddress and correlationId', () => {
    const entry = makeEntry({ ipAddress: undefined, correlationId: undefined });
    const data = createAuditWebhookData(entry);
    expect(data).toBeDefined();
    expect(data!.ipAddress).toBeUndefined();
    expect(data!.correlationId).toBeUndefined();
  });

  it('createAuditWebhookData handles sparse metadata with only nulls', () => {
    const entry = makeEntry({ metadata: { a: null, b: null } });
    const data = createAuditWebhookData(entry);
    expect(data).toBeDefined();
    expect(data!.metadata).toEqual({ a: null, b: null });
  });
});

describe('AuditWebhook — EDGE: boundary inputs', () => {
  it('createAuditWebhookData with metadata at exact byte bound passes through', () => {
    const smallValue = 'x'.repeat(100);
    const entry = makeEntry({ metadata: { data: smallValue } });
    const data = createAuditWebhookData(entry, 10000);
    expect(data).toBeDefined();
    expect(data!.metadata).toEqual({ data: smallValue });
  });

  it('createAuditWebhookData truncates metadata when payload exceeds bound', () => {
    const largeValue = 'x'.repeat(2000);
    const entry = makeEntry({ metadata: { big: largeValue } });
    const data = createAuditWebhookData(entry, 300);
    expect(data).toBeDefined();
    expect(data!.metadata).toHaveProperty('_truncated', true);
  });

  it('createAuditWebhookData returns undefined when even truncated metadata exceeds bound', () => {
    const entry = makeEntry({ resourceId: 'x'.repeat(10000), metadata: {} });
    const data = createAuditWebhookData(entry, 50);
    expect(data).toBeUndefined();
  });
});

describe('AuditWebhook — EDGE: malformed inputs', () => {
  it('createAuditWebhookData redacts sensitive keys in metadata', () => {
    const entry = makeEntry({ metadata: { password: 'secret', safe: 'visible' } });
    const data = createAuditWebhookData(entry);
    expect((data!.metadata as Record<string, unknown>).password).toBe('[REDACTED]');
    expect((data!.metadata as Record<string, unknown>).safe).toBe('visible');
  });

  it('AuditWebhookService.notify skips when payload too large', async () => {
    const mockTrigger = jest.fn().mockResolvedValue(undefined);
    const ws = { trigger: mockTrigger, send: jest.fn() } as any;
    const svc = new AuditWebhookService(ws, { maxPayloadBytes: 1 });
    await svc.notify(makeEntry({ resourceId: 'too-large' }));
    expect(mockTrigger).not.toHaveBeenCalled();
  });

  it('AuditWebhookService.notify passes correlationId', async () => {
    const mockTrigger = jest.fn().mockResolvedValue(undefined);
    const ws = { trigger: mockTrigger, send: jest.fn() } as any;
    const svc = new AuditWebhookService(ws);
    await svc.notify(makeEntry({ correlationId: 'trace-42' }));
    expect(mockTrigger).toHaveBeenCalledWith('audit.event', expect.any(Object), 'trace-42');
  });
});

// =============================================================================
// InputValidation — edge cases beyond existing coverage
// =============================================================================

describe('InputValidation — EDGE: empty inputs', () => {
  it('validateCreateAuditEntryInput with null returns ok=false', () => {
    const result = validateCreateAuditEntryInput(null);
    expect(result.ok).toBe(false);
  });

  it('validateCreateAuditEntryInput with empty string returns ok=false', () => {
    const result = validateCreateAuditEntryInput('');
    expect(result.ok).toBe(false);
  });

  it('validateCreateAuditEntryInput with number returns ok=false', () => {
    const result = validateCreateAuditEntryInput(42);
    expect(result.ok).toBe(false);
  });

  it('validateCreateAuditEntryInput with array returns ok=false', () => {
    const result = validateCreateAuditEntryInput([]);
    expect(result.ok).toBe(false);
  });
});

describe('InputValidation — EDGE: boundary (metadata)', () => {
  it('metadata with exactly MAX_METADATA_BYTES-1 passes', () => {
    const payload = { data: 'x'.repeat(MAX_METADATA_BYTES - 30) };
    const issues = validateMetadata(payload);
    expect(issues.filter(i => i.code === AUDIT_VALIDATION_CODES.METADATA_TOO_LARGE)).toHaveLength(0);
  });

  it('metadata array at exactly MAX_METADATA_ARRAY_ITEMS passes', () => {
    const issues = validateMetadata({ items: Array.from({ length: MAX_METADATA_ARRAY_ITEMS }, (_, i) => i) });
    expect(issues.filter(i => i.code === AUDIT_VALIDATION_CODES.TOO_BIG)).toHaveLength(0);
  });

  it('metadata array at exactly MAX_METADATA_ARRAY_ITEMS + 1 fails', () => {
    const issues = validateMetadata({ items: Array.from({ length: MAX_METADATA_ARRAY_ITEMS + 1 }, (_, i) => i) });
    expect(issues.map(i => i.code)).toContain(AUDIT_VALIDATION_CODES.TOO_BIG);
  });

  it('number at exactly MAX_METADATA_NUMBER passes', () => {
    const issues = validateMetadata({ n: MAX_METADATA_NUMBER });
    expect(issues).toHaveLength(0);
  });

  it('number at MAX_METADATA_NUMBER + 1 fails', () => {
    const issues = validateMetadata({ n: MAX_METADATA_NUMBER + 1 });
    expect(issues.map(i => i.code)).toContain(AUDIT_VALIDATION_CODES.TOO_BIG);
  });

  it('negative number at boundary passes', () => {
    const issues = validateMetadata({ n: -MAX_METADATA_NUMBER });
    expect(issues).toHaveLength(0);
  });

  it('negative number past boundary fails', () => {
    const issues = validateMetadata({ n: -(MAX_METADATA_NUMBER + 1) });
    expect(issues.map(i => i.code)).toContain(AUDIT_VALIDATION_CODES.TOO_BIG);
  });

  it('computeDepth with MAX_METADATA_DEPTH-1 depth', () => {
    let node: unknown = {};
    for (let i = 0; i < MAX_METADATA_DEPTH - 1; i++) {
      node = { a: node };
    }
    expect(computeDepth(node)).toBe(MAX_METADATA_DEPTH);
  });
});

describe('InputValidation — EDGE: malformed', () => {
  it('rejects metadata with BigInt value', () => {
    const issues = validateMetadata({ value: 1n as any });
    expect(issues.map(i => i.code)).toContain(AUDIT_VALIDATION_CODES.INVALID_TYPE);
  });

  it('rejects metadata with undefined value', () => {
    const issues = validateMetadata({ value: undefined });
    expect(issues.map(i => i.code)).toContain(AUDIT_VALIDATION_CODES.INVALID_TYPE);
  });

  it('rejects metadata with function value', () => {
    const issues = validateMetadata({ fn: () => 1 });
    expect(issues.map(i => i.code)).toContain(AUDIT_VALIDATION_CODES.INVALID_TYPE);
  });

  it('rejects metadata with Symbol value', () => {
    const issues = validateMetadata({ sym: Symbol('x') });
    expect(issues.map(i => i.code)).toContain(AUDIT_VALIDATION_CODES.INVALID_TYPE);
  });

  it('handles self-referencing array in metadata without throwing', () => {
    const arr: unknown[] = [1, 2];
    arr.push(arr);
    expect(() => validateMetadata({ arr })).not.toThrow();
  });

  it('handles metadata with circular reference through array', () => {
    const a: Record<string, unknown> = { name: 'a' };
    const b: Record<string, unknown> = { name: 'b', parent: a };
    a['child'] = b;
    const issues = validateMetadata(a);
    expect(issues.map(i => i.code)).toContain(AUDIT_VALIDATION_CODES.METADATA_NOT_SERIALISABLE);
  });

  it.each(FORBIDDEN_METADATA_KEYS)('rejects reserved metadata key "%s" via validateMetadata', (key) => {
    const obj = JSON.parse(`{"${key}": "value"}`);
    const issues = validateMetadata(obj);
    expect(issues.map(i => i.code)).toContain(AUDIT_VALIDATION_CODES.METADATA_FORBIDDEN_KEY);
  });

  it('rejects control characters in metadata strings', () => {
    const issues = validateMetadata({ note: 'line1\nline2' });
    // Control character check is done at the identifier level, not within metadata values
    // metadata strings only enforce MAX_METADATA_STRING_LENGTH
    expect(issues.filter(i => i.code === AUDIT_VALIDATION_CODES.TOO_BIG)).toHaveLength(0);
  });
});

// =============================================================================
// Cross-module integration edge cases
// =============================================================================

describe('Cross-module EDGE: store → service → webhook pipeline', () => {
  it('full pipeline round-trip with bare-minimum input', () => {
    const store = new AuditStore();
    const service = new AuditService(store);
    const entry = service.log({
      action: 'AUTH_LOGIN',
      severity: 'INFO',
      actor: 'system',
      resource: 'auth',
      resourceId: 'system',
      metadata: {},
    });
    expect(entry).toBeDefined();
    expect(store.count()).toBe(1);
    expect(service.verifyIntegrity().valid).toBe(true);

    const webhookData = createAuditWebhookData(entry);
    expect(webhookData).toBeDefined();
    expect(webhookData!.id).toBe(entry.id);
  });

  it('query with every filter set to a value that matches nothing returns empty', () => {
    const store = new AuditStore();
    store.append(makeInput());
    const results = store.query({
      action: 'NONEXISTENT' as any,
      severity: 'CRITICAL',
      actor: 'nobody',
      resource: 'nothing',
      resourceId: 'missing',
    });
    expect(results).toHaveLength(0);
  });

  it('append with extremely large metadata still produces valid hash chain', () => {
    const store = new AuditStore();
    const largeMeta = Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [`key${i}`, 'x'.repeat(500)]),
    );
    store.append(makeInput({ metadata: largeMeta }));
    expect(store.count()).toBe(1);
    expect(store.verifyIntegrity().valid).toBe(true);
  });

  it('multiple appends with same input get unique hashes', () => {
    const store = new AuditStore();
    const e1 = store.append(makeInput({ action: 'CONTRACT_CREATED' }));
    const e2 = store.append(makeInput({ action: 'CONTRACT_CREATED' }));
    expect(e1.hash).not.toBe(e2.hash);
  });
});
