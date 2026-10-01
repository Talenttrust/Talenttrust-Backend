import express, { type Request, type Response, type ErrorRequestHandler } from 'express';
import request from 'supertest';
import { auditMiddleware } from './middleware';
import { auditService } from './service';
import { auditStore } from './store';
import type { CreateAuditEntryInput } from './types';
import { mapErrorToPayload } from '../errors/appError';
import { MAX_METADATA_BYTES, MAX_METADATA_STRING_LENGTH } from './inputValidation';

type Input = Omit<CreateAuditEntryInput, 'ipAddress' | 'correlationId'>;
const input = (overrides: Partial<Input> = {}): Input => ({
  action: 'CONTRACT_CREATED', severity: 'INFO', actor: 'user-1',
  resource: 'contract', resourceId: 'contract-1', metadata: {}, ...overrides,
});

function attach(headers: Record<string, unknown> = {}, ip: string | undefined = '127.0.0.1') {
  const req = { headers, ip, socket: { remoteAddress: '::1' } } as unknown as Request;
  const res = { locals: {} } as Response;
  const next = jest.fn();
  auditMiddleware(req, res, next);
  expect(next).toHaveBeenCalledTimes(1);
  return { req, res, helper: res.locals.audit };
}

describe('request audit invariants', () => {
  const savedEnv = process.env;
  beforeEach(() => {
    process.env = { NODE_ENV: 'test', COMPLIANCE_AUDIT_SECRET: 'a'.repeat(32) };
    auditStore._reset();
  });
  afterEach(() => {
    process.env = savedEnv;
    jest.restoreAllMocks();
    auditStore._reset();
  });

  it('isolates nested input and freezes persisted metadata without freezing caller data', () => {
    const metadata = { nested: { value: 'original' }, items: [{ amount: 10 }] };
    const entry = attach().helper.log(input({ metadata }));
    metadata.nested.value = 'changed';
    metadata.items[0].amount = 99;
    expect(entry.metadata).toEqual({ nested: { value: 'original' }, items: [{ amount: 10 }] });
    expect(Object.isFrozen(metadata.nested)).toBe(false);
    expect(Object.isFrozen(entry.metadata.nested)).toBe(true);
    expect(Object.isFrozen(entry.metadata.items)).toBe(true);
    expect(() => { (entry.metadata.nested as any).value = 'tampered'; }).toThrow();
    expect(auditStore.verifyIntegrity().valid).toBe(true);
  });

  it('redacts nested secrets and email addresses without modifying the caller', () => {
    const metadata = { password: 'private-value', nested: { api_key: 'key-value', email: 'alice@example.com' } };
    const entry = attach().helper.log(input({ metadata }));
    expect(entry.metadata).toEqual({ password: '[REDACTED]', nested: { api_key: '[REDACTED]', email: 'ali***@example.com' } });
    expect(metadata.password).toBe('private-value');
    expect(auditStore.verifyIntegrity().valid).toBe(true);
  });

  it.each([undefined, '', 'a'.repeat(129), 'bad\r\nvalue', ['one', 'two'], 123, 'bad id'])('omits unsafe correlation IDs: %p', (id) => {
    const entry = attach({ 'x-correlation-id': id }).helper.log(input());
    expect(entry.correlationId).toBeUndefined();
  });

  it.each(['corr-1', 'a'.repeat(128)])('retains safe correlation IDs: %p', (id) => {
    expect(attach({ 'x-correlation-id': id }).helper.log(input()).correlationId).toBe(id);
  });

  it('snapshots trusted context and ignores caller-supplied IP/correlation overrides', () => {
    const { req, helper } = attach({ 'x-correlation-id': 'original-id' });
    req.headers['x-correlation-id'] = 'changed-id';
    const entry = helper.log({ ...input(), ipAddress: 'spoofed', correlationId: 'spoofed' } as Input);
    expect(entry.ipAddress).toBe('127.0.0.1');
    expect(entry.correlationId).toBe('original-id');
  });

  it('falls back to the socket IP', () => {
    const { req, res } = attach();
    Object.defineProperty(req, 'ip', { value: undefined });
    auditMiddleware(req, res, jest.fn());
    expect(res.locals.audit.log(input()).ipAddress).toBe('::1');
  });

  it.each([
    { action: 'UNKNOWN' }, { severity: 'INVALID' }, { actor: '  ' },
    { resource: '' }, { resourceId: 'a'.repeat(129) }, { actor: 'bad\nactor' },
    { metadata: null }, { metadata: { amount: Infinity } },
    { metadata: { amount: BigInt(1) } }, { metadata: { missing: undefined } },
    { metadata: { value: 'a'.repeat(MAX_METADATA_STRING_LENGTH + 1) } },
    { metadata: JSON.parse('{"__proto__":{"polluted":true}}') },
  ])('rejects invalid input before persistence: %p', (overrides) => {
    const spy = jest.spyOn(auditService, 'log');
    expect(() => attach().helper.log(input(overrides as Partial<Input>))).toThrow();
    expect(spy).not.toHaveBeenCalled();
    expect(auditStore.count()).toBe(0);
  });

  it('rejects cyclic and throwing metadata with a safe, stable validation error', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const throwing = { get value() { throw new Error('password=private-secret'); } };
    for (const metadata of [cyclic, throwing]) {
      try {
        attach().helper.log(input({ metadata }));
        throw new Error('expected rejection');
      } catch (error) {
        const mapped = mapErrorToPayload(error, 'request-1');
        expect(mapped.statusCode).toBe(400);
        expect(mapped.payload.error.code).toBe('validation_error');
        expect(JSON.stringify(mapped)).not.toContain('private-secret');
      }
    }
    expect(auditStore.count()).toBe(0);
  });

  it('accepts boundary metadata and rejects metadata beyond the total byte limit', () => {
    const helper = attach().helper;
    helper.log(input({ actor: 'a'.repeat(128), metadata: { value: 'a'.repeat(MAX_METADATA_STRING_LENGTH) } }));
    const oversized = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`k${i}`, 'a'.repeat(4096)]));
    expect(Buffer.byteLength(JSON.stringify(oversized))).toBeGreaterThan(MAX_METADATA_BYTES);
    expect(() => helper.log(input({ metadata: oversized }))).toThrow();
    expect(auditStore.count()).toBe(1);
    expect(auditStore.verifyIntegrity().valid).toBe(true);
  });

  it.each([true, false])('validates missing and wrong-type events even when enabled=%s', (enabled) => {
    process.env.AUDIT_ENABLED = String(enabled);
    const helper = attach().helper;
    for (const invalid of [null, undefined, [], { ...input(), actor: undefined }, { ...input(), actor: 42 }]) {
      expect(() => helper.log(invalid as unknown as Input)).toThrow('Invalid audit event');
    }
    expect(auditStore.count()).toBe(0);
  });

  it('enforces depth, key-count and array-length boundaries', () => {
    const helper = attach().helper;
    helper.log(input({ metadata: { a: { b: { c: { d: {} } } } } }));
    helper.log(input({ metadata: { values: Array.from({ length: 200 }, () => 1) } }));
    helper.log(input({ metadata: Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`key${i}`, 1])) }));
    expect(() => helper.log(input({ metadata: { a: { b: { c: { d: { e: {} } } } } } }))).toThrow();
    expect(() => helper.log(input({ metadata: { values: Array.from({ length: 201 }, () => 1) } }))).toThrow();
    expect(() => helper.log(input({ metadata: Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`key${i}`, 1])) }))).toThrow();
    expect(auditStore.count()).toBe(3);
    expect(auditStore.verifyIntegrity().valid).toBe(true);
  });

  it('revalidates custom JSON serialization before appending', () => {
    const metadata = {};
    Object.defineProperty(metadata, 'toJSON', {
      value: () => JSON.parse('{"__proto__":{"polluted":true}}'),
    });
    expect(() => attach().helper.log(input({ metadata }))).toThrow('Invalid audit event');
    expect(auditStore.count()).toBe(0);
    expect(({} as any).polluted).toBeUndefined();
  });

  it('rejects a metadata snapshot that exceeds the byte limit after redaction', () => {
    const metadata = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [
      `group${i}`, Object.fromEntries(Array.from({ length: 50 }, (_, j) => [`token${j}`, 0])),
    ]));
    expect(Buffer.byteLength(JSON.stringify(metadata))).toBeLessThan(MAX_METADATA_BYTES);
    expect(() => attach().helper.log(input({ metadata }))).toThrow('Invalid audit event');
    expect(auditStore.count()).toBe(0);
  });

  it.each(['CONTRACT_DELETED', 'MILESTONES_CREATED', 'MILESTONES_UPDATED', 'MILESTONES_DELETED'] as const)('preserves the existing typed action %s', (action) => {
    expect(attach().helper.log(input({ action })).action).toBe(action);
  });

  it('preserves immediate append semantics for repeated events rather than deduplicating legitimate actions', () => {
    const helper = attach().helper;
    const first = helper.log(input());
    const second = helper.log(input());
    expect(second.id).not.toBe(first.id);
    expect(second.previousHash).toBe(first.hash);
    expect(auditStore.count()).toBe(2);
  });

  it('isolates interleaved requests and keeps the hash chain valid', async () => {
    const helpers = Array.from({ length: 12 }, (_, i) => attach({ 'x-correlation-id': `request-${i}` }).helper);
    const entries = await Promise.all(helpers.map(async (helper, i) => {
      await Promise.resolve();
      return helper.log(input({ resourceId: `contract-${i}`, metadata: { index: i } }));
    }));
    entries.forEach((entry, i) => expect(entry.correlationId).toBe(`request-${i}`));
    expect(auditStore.verifyIntegrity()).toMatchObject({ valid: true, totalEntries: 12 });
  });

  it('snapshots re-entrant metadata before the store append critical section', () => {
    const helper = attach().helper;
    let nestedWriteCompleted = false;
    const metadata = {
      get nested(): string {
        if (!nestedWriteCompleted) {
          nestedWriteCompleted = true;
          helper.log(input({ resourceId: 'nested-write' }));
        }
        return 'outer-value';
      },
    };

    const outer = helper.log(input({ resourceId: 'outer-write', metadata }));
    const entries = auditStore.getAll();

    expect(entries.map((entry) => entry.resourceId)).toEqual(['nested-write', 'outer-write']);
    expect(outer.metadata).toEqual({ nested: 'outer-value' });
    expect(outer.previousHash).toBe(entries[0].hash);
    expect(auditStore.verifyIntegrity()).toMatchObject({ valid: true, totalEntries: 2 });
  });

  it('propagates persistence failure and permits an explicit retry without adding a phantom entry', () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const append = jest.spyOn(auditStore, 'append').mockImplementationOnce(() => { throw new Error('storage unavailable'); });
    const helper = attach().helper;
    expect(() => helper.log(input())).toThrow('storage unavailable');
    expect(auditStore.count()).toBe(0);
    const recovered = helper.log(input());
    expect(append).toHaveBeenCalledTimes(2);
    expect(recovered.previousHash).toBe('GENESIS');
    expect(auditStore.verifyIntegrity().valid).toBe(true);
  });

  it('keeps the disabled helper a non-persisting immutable stub', () => {
    process.env.AUDIT_ENABLED = 'false';
    const metadata = { nested: { value: 'original' } };
    const entry = attach().helper.log(input({ metadata }));
    metadata.nested.value = 'changed';
    expect(entry).toMatchObject({ id: '', hash: '', previousHash: '', metadata: { nested: { value: 'original' } } });
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(entry.metadata.nested)).toBe(true);
    expect(auditStore.count()).toBe(0);
  });

  it('takes the enabled/disabled flag once per request', () => {
    const enabled = attach().helper;
    process.env.AUDIT_ENABLED = 'false';
    const disabled = attach().helper;
    process.env.AUDIT_ENABLED = 'true';
    expect(enabled.log(input()).id).not.toBe('');
    expect(disabled.log(input()).id).toBe('');
    expect(auditStore.count()).toBe(1);
  });

  it('does not bypass route authorization or log a forbidden mutation', async () => {
    const app = express();
    app.use(auditMiddleware);
    app.post('/contracts', (_req, res, _next) => { res.status(403).json({ error: 'forbidden' }); }, (_req, res) => {
      res.locals.audit.log(input());
      res.sendStatus(201);
    });
    await request(app).post('/contracts').expect(403);
    expect(auditStore.count()).toBe(0);
  });

  it('does not turn a failed synchronous write into a successful response', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(auditStore, 'append').mockImplementationOnce(() => { throw new Error('password=private-storage-detail'); });
    const app = express();
    app.use(auditMiddleware);
    app.post('/contracts', (_req, res) => { res.locals.audit.log(input()); res.sendStatus(201); });
    const handler: ErrorRequestHandler = (err, _req, res, _next) => {
      const mapped = mapErrorToPayload(err, 'request-1');
      res.status(mapped.statusCode).json(mapped.payload);
    };
    app.use(handler);
    const response = await request(app).post('/contracts').expect(500);
    expect(response.body.error.code).toBe('internal_error');
    expect(JSON.stringify(response.body)).not.toContain('private-storage-detail');
    expect(auditStore.count()).toBe(0);
  });
});
