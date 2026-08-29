/**
 * @file metricsIdempotency.test.ts
 * @description Unit tests for src/middleware/metricsIdempotency.ts
 *
 * Coverage targets:
 *  - MetricsIdempotencyStore: get/set/size/clear/purgeExpired/TTL/maxSize eviction
 *  - Middleware: no-header passthrough, first write, exact replay, conflict, empty key
 */

import { Request, Response } from 'express';
import {
  MetricsIdempotencyStore,
  createMetricsIdempotencyMiddleware,
  defaultMetricsIdempotencyStore,
  metricsIdempotencyMiddleware,
} from './metricsIdempotency';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReqRes(options: {
  headers?: Record<string, string>;
  body?: unknown;
  requestId?: string;
}) {
  const res = {
    locals: options.requestId ? { requestId: options.requestId } : {},
    statusCode: 200,
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
    setHeader: jest.fn(),
  };

  // Simulate Express: res.status(n) sets statusCode
  res.status.mockImplementation((code: number) => {
    res.statusCode = code;
    return res;
  });

  return {
    req: {
      headers: options.headers ?? {},
      body: options.body,
    } as unknown as Request,
    res: res as unknown as Response & typeof res,
    next: jest.fn(),
  };
}

function makeMiddleware(storeOptions?: ConstructorParameters<typeof MetricsIdempotencyStore>[0]) {
  const store = new MetricsIdempotencyStore(storeOptions);
  const middleware = createMetricsIdempotencyMiddleware({ store });
  return { store, middleware };
}

// ---------------------------------------------------------------------------
// MetricsIdempotencyStore
// ---------------------------------------------------------------------------

describe('MetricsIdempotencyStore', () => {
  it('returns undefined for unknown key', () => {
    const store = new MetricsIdempotencyStore();
    expect(store.get('missing')).toBeUndefined();
  });

  it('stores and retrieves an entry', () => {
    const store = new MetricsIdempotencyStore();
    store.set('k1', { payloadHash: 'abc', statusCode: 204 });
    expect(store.get('k1')).toEqual({ payloadHash: 'abc', statusCode: 204 });
  });

  it('size() reflects stored entries', () => {
    const store = new MetricsIdempotencyStore();
    expect(store.size()).toBe(0);
    store.set('k1', { payloadHash: 'a', statusCode: 204 });
    expect(store.size()).toBe(1);
  });

  it('clear() removes all entries', () => {
    const store = new MetricsIdempotencyStore();
    store.set('k1', { payloadHash: 'a', statusCode: 204 });
    store.clear();
    expect(store.size()).toBe(0);
    expect(store.get('k1')).toBeUndefined();
  });

  it('returns undefined for an expired entry', () => {
    let now = 1000;
    const store = new MetricsIdempotencyStore({ ttlMs: 100, clock: () => now });
    store.set('k1', { payloadHash: 'a', statusCode: 204 });
    now += 200; // past TTL
    expect(store.get('k1')).toBeUndefined();
  });

  it('returns entry that has not yet expired', () => {
    let now = 1000;
    const store = new MetricsIdempotencyStore({ ttlMs: 500, clock: () => now });
    store.set('k1', { payloadHash: 'a', statusCode: 204 });
    now += 100; // within TTL
    expect(store.get('k1')).toEqual({ payloadHash: 'a', statusCode: 204 });
  });

  it('purgeExpired() removes only expired entries and returns count', () => {
    let now = 1000;
    const store = new MetricsIdempotencyStore({ ttlMs: 100, clock: () => now });
    store.set('expired', { payloadHash: 'a', statusCode: 204 });
    now += 200;
    store.set('fresh', { payloadHash: 'b', statusCode: 204 });

    const purged = store.purgeExpired();
    expect(purged).toBe(1);
    expect(store.get('fresh')).toBeDefined();
    expect(store.size()).toBe(1);
  });

  it('purgeExpired() returns 0 when nothing is expired', () => {
    const store = new MetricsIdempotencyStore({ ttlMs: 60_000 });
    store.set('k1', { payloadHash: 'a', statusCode: 204 });
    expect(store.purgeExpired()).toBe(0);
  });

  it('evicts oldest entry when maxSize is reached', () => {
    const store = new MetricsIdempotencyStore({ maxSize: 2 });
    store.set('k1', { payloadHash: 'a', statusCode: 204 });
    store.set('k2', { payloadHash: 'b', statusCode: 204 });
    store.set('k3', { payloadHash: 'c', statusCode: 204 }); // should evict k1
    expect(store.size()).toBe(2);
    expect(store.get('k1')).toBeUndefined();
    expect(store.get('k3')).toBeDefined();
  });

  it('updating an existing key does not evict when at capacity', () => {
    const store = new MetricsIdempotencyStore({ maxSize: 2 });
    store.set('k1', { payloadHash: 'a', statusCode: 204 });
    store.set('k2', { payloadHash: 'b', statusCode: 204 });
    store.set('k1', { payloadHash: 'a2', statusCode: 204 }); // update, not new
    expect(store.size()).toBe(2);
    expect(store.get('k1')?.payloadHash).toBe('a2');
  });
});

// ---------------------------------------------------------------------------
// createMetricsIdempotencyMiddleware
// ---------------------------------------------------------------------------

describe('createMetricsIdempotencyMiddleware', () => {
  describe('no Idempotency-Key header', () => {
    it('calls next() without touching the store', () => {
      const { store, middleware } = makeMiddleware();
      const { req, res, next } = makeReqRes({ body: { outcome: 'success' } });

      middleware(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
      expect(store.size()).toBe(0);
    });

    it('calls next() when Idempotency-Key is an empty string', () => {
      const { middleware } = makeMiddleware();
      const { req, res, next } = makeReqRes({
        headers: { 'idempotency-key': '' },
        body: { outcome: 'success' },
      });

      middleware(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
    });
  });

  describe('first request with Idempotency-Key', () => {
    it('calls next() and caches the entry after res.send()', () => {
      const { store, middleware } = makeMiddleware();
      const { req, res, next } = makeReqRes({
        headers: { 'idempotency-key': 'first-key' },
        body: { outcome: 'success' },
      });

      middleware(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);
      expect(store.size()).toBe(0); // not cached yet

      // Simulate route handler completing with 204
      res.status(204);
      res.send();

      expect(store.size()).toBe(1);
      expect(store.get('first-key')).toMatchObject({ statusCode: 204 });
    });

    it('stores the correct payload hash', () => {
      const { store, middleware } = makeMiddleware();
      const body = { depth: 42 };
      const { req, res, next } = makeReqRes({
        headers: { 'idempotency-key': 'hash-check' },
        body,
      });

      middleware(req, res, next);
      res.status(204);
      res.send();

      const entry = store.get('hash-check');
      expect(entry?.payloadHash).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe('exact replay', () => {
    it('returns 204 with Idempotency-Replayed header without calling next()', () => {
      const { middleware } = makeMiddleware();
      const headers = { 'idempotency-key': 'replay-key' };
      const body = { outcome: 'success' };

      // First request
      const first = makeReqRes({ headers, body });
      middleware(first.req, first.res, first.next);
      first.res.status(204);
      first.res.send();

      // Replay
      const replay = makeReqRes({ headers, body });
      middleware(replay.req, replay.res, replay.next);

      expect(replay.next).not.toHaveBeenCalled();
      expect(replay.res.setHeader).toHaveBeenCalledWith('Idempotency-Replayed', 'true');
      expect(replay.res.status).toHaveBeenCalledWith(204);
      expect(replay.res.send).toHaveBeenCalled();
    });

    it('replay with canonically equivalent body (different field order) returns 204', () => {
      const { middleware } = makeMiddleware();
      const key = 'canonical-key';

      const first = makeReqRes({
        headers: { 'idempotency-key': key },
        body: { a: 1, b: 2 },
      });
      middleware(first.req, first.res, first.next);
      first.res.status(204);
      first.res.send();

      // Same values, different field order
      const replay = makeReqRes({
        headers: { 'idempotency-key': key },
        body: { b: 2, a: 1 },
      });
      middleware(replay.req, replay.res, replay.next);

      expect(replay.next).not.toHaveBeenCalled();
      expect(replay.res.setHeader).toHaveBeenCalledWith('Idempotency-Replayed', 'true');
    });
  });

  describe('key reuse with different body (conflict)', () => {
    it('returns 409 with idempotency_payload_conflict code', () => {
      const { middleware } = makeMiddleware();
      const key = 'conflict-key';

      const first = makeReqRes({
        headers: { 'idempotency-key': key },
        body: { outcome: 'success' },
      });
      middleware(first.req, first.res, first.next);
      first.res.status(204);
      first.res.send();

      const conflict = makeReqRes({
        headers: { 'idempotency-key': key },
        body: { outcome: 'failure' },
        requestId: 'req-conflict',
      });
      middleware(conflict.req, conflict.res, conflict.next);

      expect(conflict.next).not.toHaveBeenCalled();
      expect(conflict.res.status).toHaveBeenCalledWith(409);
      expect(conflict.res.json).toHaveBeenCalledWith({
        error: {
          code: 'idempotency_payload_conflict',
          message: 'Idempotency-Key was already used with a different request payload.',
          requestId: 'req-conflict',
        },
      });
    });

    it('uses "unknown" as requestId when res.locals.requestId is absent', () => {
      const { middleware } = makeMiddleware();
      const key = 'conflict-no-reqid';

      const first = makeReqRes({ headers: { 'idempotency-key': key }, body: { x: 1 } });
      middleware(first.req, first.res, first.next);
      first.res.status(204);
      first.res.send();

      const conflict = makeReqRes({ headers: { 'idempotency-key': key }, body: { x: 2 } });
      middleware(conflict.req, conflict.res, conflict.next);

      expect(conflict.res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({ requestId: 'unknown' }),
        }),
      );
    });
  });

  describe('TTL expiry', () => {
    it('expired key is treated as a new request', () => {
      let now = 1000;
      const { middleware } = makeMiddleware({ ttlMs: 100, clock: () => now });
      const key = 'ttl-key';
      const body = { outcome: 'success' };

      const first = makeReqRes({ headers: { 'idempotency-key': key }, body });
      middleware(first.req, first.res, first.next);
      first.res.status(204);
      first.res.send();

      now += 200; // expire

      const second = makeReqRes({ headers: { 'idempotency-key': key }, body });
      middleware(second.req, second.res, second.next);

      // Should be treated as first request — next() called, no replay header
      expect(second.next).toHaveBeenCalledTimes(1);
      expect(second.res.setHeader).not.toHaveBeenCalledWith('Idempotency-Replayed', 'true');
    });
  });

  describe('module-level exports', () => {
    it('defaultMetricsIdempotencyStore is a MetricsIdempotencyStore instance', () => {
      expect(defaultMetricsIdempotencyStore).toBeInstanceOf(MetricsIdempotencyStore);
    });

    it('metricsIdempotencyMiddleware is a function', () => {
      expect(typeof metricsIdempotencyMiddleware).toBe('function');
    });
  });
});
