import { EventEmitter } from 'events';
import type { Request, Response } from 'express';
import express from 'express';
import request from 'supertest';
import { AuditStore } from './store';
import { AuditService } from './service';
import { createProtectedEndpointAuditMiddleware } from './protectedEndpointMiddleware';
import { auditIdentifier, auditMethod, auditPath, auditPayload, PROTECTED_AUDIT_LIMITS as limits } from './protectedEndpointInput';
import { REDACTED } from './redact';
import { authenticateMiddleware, createToken } from '../auth/authenticate';

describe('protected audit input boundary', () => {
  it.each([null, undefined, 42, '', ' ', 'x\ny', 'x'.repeat(129)])('rejects invalid identifiers %p', value => {
    expect(auditIdentifier(value)).toBeUndefined();
  });
  it('accepts exact identifier and path limits', () => {
    expect(auditIdentifier('x'.repeat(128))).toHaveLength(128);
    expect(auditPath('/' + 'x'.repeat(4095))).toHaveLength(4096);
    expect(auditPath('/' + 'x'.repeat(4096))).toBe('[INVALID]');
  });
  it.each([null, 42, '', 'relative', '/bad\npath'])('rejects invalid paths %p', value => {
    expect(auditPath(value)).toBe('[INVALID]');
  });
  it('strips query and fragment without decoding encoded path separators', () => {
    expect(auditPath('/api/v1/contracts/a%2Fb?token=secret#fragment')).toBe('/api/v1/contracts/a%2Fb');
    expect(auditPath('/valid?x=' + 'x'.repeat(5000))).toBe('/valid');
  });
  it.each([null, 7, '', 'GET\n', 'x'.repeat(33)])('rejects invalid methods %p', value => {
    expect(auditMethod(value)).toBe('UNKNOWN');
  });
  it('normalizes valid HTTP token methods', () => {
    expect(auditMethod('get')).toBe('GET');
    expect(auditMethod('PROPFIND')).toBe('PROPFIND');
  });
  it('redacts without reading sensitive accessors and masks email', () => {
    const getter = jest.fn(() => { throw new Error('secret'); });
    const body = { email: 'alice@example.com', nested: { token: 'secret' } };
    Object.defineProperty(body, 'password', { enumerable: true, get: getter });
    expect(auditPayload(body)).toEqual({ rejected: false, value: {
      email: 'ali***@example.com', nested: { token: REDACTED }, password: REDACTED,
    } });
    expect(getter).not.toHaveBeenCalled();
  });
  it('detaches and recursively freezes data, including header arrays', () => {
    const body = { a: [{ b: 'original' }] };
    const copy = auditPayload(body).value as typeof body;
    body.a[0].b = 'changed';
    expect(copy.a[0].b).toBe('original');
    expect(Object.isFrozen(copy.a)).toBe(true);
    expect(Object.isFrozen(copy.a[0])).toBe(true);
    const headers = { accept: ['json'], Authorization: 'secret' };
    const snapshot = auditPayload(headers, true).value as typeof headers;
    headers.accept.push('changed');
    expect(snapshot.accept).toEqual(['json']);
    expect(snapshot.Authorization).toBe(REDACTED);
  });
  it.each([NaN, Infinity, 2n, () => 'secret', new Date(), { x: undefined },
    JSON.parse('{"__proto__":{"secret":"hidden"}}'), { constructor: 'bad' },
    { ['x'.repeat(65)]: 1 }, { x: 'x'.repeat(4097) },
    Array(201).fill(null), Object.fromEntries(Array.from({ length: 51 }, (_, i) => [String(i), 1])),
  ])('omits unsafe sections %p', value => {
    expect(auditPayload(value)).toEqual({ value: '[OMITTED]', rejected: true });
  });
  it('accepts exact collection, depth, string and byte limits', () => {
    expect(auditPayload(Array(200).fill(null)).rejected).toBe(false);
    expect(auditPayload(Object.fromEntries(Array.from({ length: 50 }, (_, i) => [String(i), 1]))).rejected).toBe(false);
    expect(auditPayload({ a: { a: { a: { a: {} } } } }).rejected).toBe(false);
    expect(auditPayload({ a: { a: { a: { a: { a: {} } } } } }).rejected).toBe(true);
    expect(auditPayload('x'.repeat(4096)).rejected).toBe(false);
    // JSON object overhead is 15 bytes; multibyte strings are measured in UTF-8.
    const exact = { a: 'x'.repeat(4096), b: 'x'.repeat(limits.bytes - 15 - 4096) };
    expect(Buffer.byteLength(JSON.stringify(exact))).toBe(limits.bytes);
    expect(auditPayload(exact).rejected).toBe(false);
    exact.b += 'x';
    expect(auditPayload(exact).rejected).toBe(true);
    expect(auditPayload({ a: '界'.repeat(3000) }).rejected).toBe(true);
  });
  it('bounds total traversal and rejects cycles without confusing shared subobjects', () => {
    const shared = { ok: true };
    expect(auditPayload({ a: shared, b: shared }).rejected).toBe(false);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(auditPayload(cyclic).rejected).toBe(true);
    expect(auditPayload(Array.from({ length: 200 }, () => Array(10).fill(null))).rejected).toBe(true);
  });
  it('does not execute getters or toJSON hooks', () => {
    const get = jest.fn(() => 'secret');
    const toJSON = jest.fn(() => ({ secret: 'leak' }));
    const body = Object.defineProperty({}, 'visible', { enumerable: true, get });
    expect(auditPayload(body).rejected).toBe(true);
    expect(auditPayload({ toJSON }).rejected).toBe(true);
    const array = Object.defineProperty([], '0', { enumerable: true, get });
    expect(auditPayload({ accept: array }, true).rejected).toBe(true);
    expect(get).not.toHaveBeenCalled();
    expect(toJSON).not.toHaveBeenCalled();
  });
  it.each([null, undefined, [], 'bad', { accept: null }, { accept: [null] }, { accept: 3 }, { accept: [true] }, { accept: { nested: 'bad' } }])('rejects malformed headers %p', value => {
    expect(auditPayload(value, true).rejected).toBe(true);
  });
});

describe('protected audit lifecycle validation', () => {
  function fixture() {
    const store = new AuditStore();
    const service = new AuditService(store);
    const req = { method: 'GET', path: '/rewritten', originalUrl: '/api/v1/contracts/a?token=secret',
      headers: {}, body: undefined, query: {}, ip: '127.0.0.1' } as unknown as Request;
    const res = Object.assign(new EventEmitter(), { locals: { requestId: 'trace-1' }, statusCode: 200 }) as unknown as Response;
    const next = jest.fn();
    return { store, service, req, res, next, mount: () => createProtectedEndpointAuditMiddleware(service)(req, res, next) };
  }
  it('writes once across duplicate mounts and finish events', () => {
    const f = fixture();
    f.mount(); f.mount();
    f.res.emit('finish'); f.res.emit('finish');
    expect(f.next).toHaveBeenCalledTimes(2);
    expect(f.store.count()).toBe(1);
    expect(f.store.getAll()[0].resourceId).toBe('a');
    expect(JSON.stringify(f.store.getAll())).not.toContain('secret');
  });
  it('captures ingress data but uses the final authenticated actor and status', () => {
    const f = fixture();
    f.req.body = { visible: 'original' };
    f.mount();
    f.req.body.visible = 'changed';
    f.req.url = '/rewritten'; f.req.method = 'POST';
    (f.req as Request & { user: { userId: string } }).user = { userId: 'authenticated' };
    f.res.statusCode = 403;
    f.res.emit('finish');
    expect(f.store.getAll()[0]).toMatchObject({ actor: 'authenticated', action: 'AUTH_FAILED', severity: 'WARNING',
      metadata: { method: 'GET', path: '/api/v1/contracts/a', body: { visible: 'original' }, statusCode: 403 } });
    expect(f.store.verifyIntegrity().valid).toBe(true);
  });
  it.each([99, 600, 200.5, NaN])('records invalid status %p safely', status => {
    const f = fixture(); f.res.statusCode = status; f.mount(); f.res.emit('finish');
    expect(f.store.getAll()[0]).toMatchObject({ severity: 'WARNING', metadata: { statusCode: null, auditValidation: ['statusCode'] } });
  });
  it('omits invalid context without coercing objects or persisting raw values', () => {
    const f = fixture();
    Object.assign(f.req, { user: { userId: 'bad\nactor' }, ip: 'bad-ip' });
    f.res.locals.requestId = 'bad\ntrace';
    f.mount(); f.res.emit('finish');
    expect(f.store.getAll()[0]).toMatchObject({ actor: 'anonymous', metadata: { requestId: null } });
    expect(f.store.getAll()[0].ipAddress).toBeUndefined();
    expect(f.store.getAll()[0].correlationId).toBeUndefined();
  });
  it('keeps an audit summary when the request body is cyclic', () => {
    const f = fixture(); f.req.body = {}; f.req.body.self = f.req.body;
    f.mount(); f.res.emit('finish');
    expect(f.next).toHaveBeenCalledTimes(1);
    expect(f.store.getAll()[0].metadata).toMatchObject({ body: '[OMITTED]', auditValidation: ['body'] });
  });
  it('does not retry a failed terminal write or expose its exception', () => {
    const f = fixture();
    const log = jest.spyOn(f.service, 'log').mockImplementation(() => { throw new Error('Bearer super-secret'); });
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      f.mount(); f.res.emit('finish'); f.res.emit('finish');
      expect(log).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(error.mock.calls)).not.toContain('super-secret');
      expect(error).toHaveBeenCalledWith(expect.any(String), { code: 'protected_audit_write_failed' });
    } finally { error.mockRestore(); }
  });
  it('sanitizes actual persistence failures and recovers on the next request', () => {
    const f = fixture();
    const append = jest.spyOn(f.store, 'append').mockImplementationOnce(() => { throw new Error('SQL token=super-secret'); });
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      f.mount(); f.res.emit('finish');
      expect(f.store.count()).toBe(0);
      const res = Object.assign(new EventEmitter(), { locals: {}, statusCode: 200 }) as unknown as Response;
      createProtectedEndpointAuditMiddleware(f.service)(f.req, res, f.next);
      res.emit('finish');
      expect(append).toHaveBeenCalledTimes(2);
      expect(f.store.count()).toBe(1);
      expect(f.store.verifyIntegrity().valid).toBe(true);
      expect(error.mock.calls).toHaveLength(2);
      expect(error.mock.calls[0]).toEqual([expect.any(String), { code: 'audit_persist_failed' }]);
      expect(error.mock.calls[1]).toEqual([expect.any(String), { code: 'protected_audit_write_failed' }]);
      expect(JSON.stringify(error.mock.calls)).not.toContain('super-secret');
    } finally { error.mockRestore(); }
  });
  it.each(['HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])('preserves action mapping for %s', method => {
    const f = fixture(); f.req.method = method; f.mount(); f.res.emit('finish');
    expect(f.store.getAll()[0].action).toBe(method === 'HEAD' ? 'ENDPOINT_ACCESS' : 'ENDPOINT_MUTATION');
  });
  it('validates resource boundaries and missing optional context', () => {
    const f = fixture();
    Object.assign(f.req, { originalUrl: undefined, path: '/api/v1/' + 'x'.repeat(129) + '/' + 'y'.repeat(129), ip: undefined });
    delete f.res.locals.requestId;
    f.mount(); f.res.emit('finish');
    expect(f.store.getAll()[0]).toMatchObject({ resource: 'endpoint', resourceId: '', severity: 'WARNING',
      metadata: { query: null, auditValidation: ['resource', 'resourceId'] } });
  });
  it('reports malformed ingress without blocking next', () => {
    const f = fixture(); Object.assign(f.req, { method: 42, originalUrl: null, path: 'relative', query: [] });
    f.mount(); f.res.emit('finish');
    expect(f.next).toHaveBeenCalledTimes(1);
    expect(f.store.getAll()[0]).toMatchObject({ severity: 'WARNING', metadata: { method: 'UNKNOWN', path: '[INVALID]',
      auditValidation: ['method', 'path', 'query'] } });
  });
  it('keeps separate service registrations independent', () => {
    const f = fixture(); const otherStore = new AuditStore();
    f.mount(); createProtectedEndpointAuditMiddleware(new AuditService(otherStore))(f.req, f.res, f.next);
    f.res.emit('finish');
    expect(f.store.count()).toBe(1); expect(otherStore.count()).toBe(1);
  });
  it('survives throwing ingress and actor getters without leaking their errors', () => {
    const f = fixture(); Object.defineProperty(f.req, 'body', { get: () => { throw new Error('private'); } });
    f.mount(); f.res.emit('finish');
    expect(f.next).toHaveBeenCalledTimes(1);
    expect(f.store.getAll()[0].metadata.auditValidation).toEqual(['body', 'query']);
    const other = fixture();
    Object.defineProperty(other.req, 'user', { get: () => { throw new Error('private'); } });
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      other.mount(); other.res.emit('finish');
      expect(other.next).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(error.mock.calls)).not.toContain('private');
    } finally { error.mockRestore(); }
  });
  it('audits repeated and concurrent HTTP requests independently, with router prefixes', async () => {
    const store = new AuditStore(); const service = new AuditService(store);
    const app = express(); const router = express.Router();
    router.use(createProtectedEndpointAuditMiddleware(service));
    router.use(createProtectedEndpointAuditMiddleware(service));
    router.get('/:id', (_req, res) => res.status(200).json({ ok: true }));
    app.use('/api/v1/contracts', router);
    await Promise.all(Array.from({ length: 12 }, () => request(app).get('/api/v1/contracts/same?token=secret').expect(200)));
    expect(store.count()).toBe(12);
    expect(store.getAll().every(entry => entry.resource === 'contracts' && entry.resourceId === 'same')).toBe(true);
    expect(store.verifyIntegrity().valid).toBe(true);
    expect(JSON.stringify(store.getAll())).not.toContain('secret');
  });
  it('preserves real authentication and handler behavior with rejected audit payloads', async () => {
    const store = new AuditStore(); const service = new AuditService(store);
    const app = express(); app.use(express.json());
    app.use(createProtectedEndpointAuditMiddleware(service));
    app.use(authenticateMiddleware);
    const handler = jest.fn((_req: Request, res: Response) => res.status(201).json({ saved: true }));
    app.post('/api/v1/contracts', handler);
    const payload = { visible: 'x'.repeat(4097), password: 'do-not-log' };
    await request(app).post('/api/v1/contracts').send(payload).expect(401);
    const token = createToken('u-real', 'freelancer');
    await request(app).post('/api/v1/contracts').set('Authorization', `Bearer ${token}`).send(payload).expect(201, { saved: true });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(store.getAll()[0]).toMatchObject({ action: 'AUTH_FAILED', actor: 'anonymous' });
    expect(store.getAll()[1]).toMatchObject({ action: 'ENDPOINT_MUTATION', actor: 'u-real', severity: 'WARNING',
      metadata: { body: '[OMITTED]', auditValidation: ['body'] } });
    expect(JSON.stringify(store.getAll())).not.toContain(token);
    expect(JSON.stringify(store.getAll())).not.toContain('do-not-log');
  });
});
