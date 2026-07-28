/**
 * Unit tests for src/middleware/idempotency.ts
 *
 * Coverage targets:
 *   - First request with Idempotency-Key processes and caches the response
 *   - Identical retry replays the cached response without re-invoking the handler
 *   - Reused key with a different payload returns HTTP 409 (no silent double-process)
 *   - Requests without the header pass through unchanged
 *   - Concurrent duplicate requests while processing
 *
 * @see docs/IDEMPOTENCY-QUICK-REFERENCE.md
 */

import { Request, Response } from 'express';
import { InMemoryIdempotencyStore } from '../db/idempotencyStore';
import {
  clearIdempotencyStore,
  createIdempotencyMiddleware,
  idempotencyMiddleware,
} from './idempotency';

/**
 * Builds mock Express req/res/next triples for idempotency middleware tests.
 *
 * @param options.headers - Request headers, including optional Idempotency-Key.
 * @param options.body - Parsed request body used for payload hashing.
 * @param options.requestId - Value placed on res.locals.requestId for error envelopes.
 */
function makeReqRes(options: {
  headers?: Record<string, string>;
  body?: unknown;
  requestId?: string;
} = {}): {
  req: Partial<Request>;
  res: Partial<Response> & {
    status: jest.Mock;
    json: jest.Mock;
    send: jest.Mock;
  };
  next: jest.Mock;
} {
  const res = {
    locals: options.requestId ? { requestId: options.requestId } : {},
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
    send: jest.fn().mockReturnThis(),
  };

  return {
    req: {
      headers: options.headers ?? {},
      body: options.body,
    } as Partial<Request>,
    res: res as Partial<Response> & {
      status: jest.Mock;
      json: jest.Mock;
      send: jest.Mock;
    },
    next: jest.fn(),
  };
}

/**
 * Creates an isolated middleware instance backed by an in-memory idempotency store.
 */
function createTestMiddleware() {
  const store = new InMemoryIdempotencyStore();
  const inFlight = new Map<string, string>();
  const middleware = createIdempotencyMiddleware({ store, inFlight });

  return { middleware, store, inFlight };
}

describe('idempotencyMiddleware', () => {
  beforeEach(() => {
    clearIdempotencyStore();
  });

  describe('requests without Idempotency-Key', () => {
    it('passes through unchanged without touching the store', () => {
      const { middleware, store } = createTestMiddleware();
      const { req, res, next } = makeReqRes({ body: { amount: 100 } });

      middleware(req as Request, res as Response, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
      expect(res.json).not.toHaveBeenCalled();
      expect(store.get('any-key')).toBeUndefined();
    });
  });

  describe('first request with Idempotency-Key', () => {
    it('calls next and caches the response when res.send completes', () => {
      const { middleware, store } = createTestMiddleware();
      const handler = jest.fn();
      const { req, res, next } = makeReqRes({
        headers: { 'idempotency-key': 'key-first' },
        body: { amount: 100 },
      });

      next.mockImplementation(() => handler());
      middleware(req as Request, res as Response, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledTimes(1);

      const responseBody = { status: 'success', data: { id: 42 } };
      res.send(JSON.stringify(responseBody));

      expect(store.get('key-first')).toMatchObject({
        key: 'key-first',
        result: responseBody,
      });
      expect(store.get('key-first')?.payloadHash).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe('identical retry', () => {
    it('returns the cached response without re-invoking the handler', () => {
      const { middleware } = createTestMiddleware();
      const handler = jest.fn();
      const body = { amount: 100, currency: 'USD' };
      const headers = { 'idempotency-key': 'key-replay' };

      const first = makeReqRes({ headers, body });
      first.next.mockImplementation(() => handler());
      middleware(first.req as Request, first.res as Response, first.next);
      first.res.send(JSON.stringify({ accepted: true }));

      handler.mockClear();

      const replay = makeReqRes({ headers, body: { currency: 'USD', amount: 100 } });
      replay.next.mockImplementation(() => handler());
      middleware(replay.req as Request, replay.res as Response, replay.next);

      expect(handler).not.toHaveBeenCalled();
      expect(replay.next).not.toHaveBeenCalled();
      expect(replay.res.status).toHaveBeenCalledWith(200);
      expect(replay.res.json).toHaveBeenCalledWith({
        accepted: true,
        idempotencyHeader: 'replay-detected',
      });
    });
  });

  describe('conflicting payload reuse', () => {
    it('returns HTTP 409 and never replays the original result', () => {
      const { middleware, store } = createTestMiddleware();
      const handler = jest.fn();
      const headers = { 'idempotency-key': 'key-conflict' };

      const first = makeReqRes({ headers, body: { amount: 100 } });
      first.next.mockImplementation(() => handler());
      middleware(first.req as Request, first.res as Response, first.next);
      first.res.send(JSON.stringify({ accepted: true, amount: 100 }));

      handler.mockClear();

      const conflict = makeReqRes({
        headers,
        body: { amount: 200 },
        requestId: 'req-conflict-1',
      });
      conflict.next.mockImplementation(() => handler());
      middleware(conflict.req as Request, conflict.res as Response, conflict.next);

      expect(handler).not.toHaveBeenCalled();
      expect(conflict.next).not.toHaveBeenCalled();
      expect(conflict.res.status).toHaveBeenCalledWith(409);
      expect(conflict.res.json).toHaveBeenCalledWith({
        error: {
          code: 'idempotency_payload_conflict',
          message: 'Idempotency key was already used with a different request payload.',
          requestId: 'req-conflict-1',
        },
      });
      expect(store.get('key-conflict')?.result).toEqual({ accepted: true, amount: 100 });
    });
  });

  describe('concurrent duplicates', () => {
    it('allows exactly one in-flight request and rejects concurrent identical retries with 409', () => {
      const { middleware } = createTestMiddleware();
      const handler = jest.fn();
      const headers = { 'idempotency-key': 'key-concurrent' };
      const body = { transferId: 'tx-1' };

      const first = makeReqRes({ headers, body });
      first.next.mockImplementation(() => handler());

      const second = makeReqRes({ headers, body, requestId: 'req-concurrent-2' });
      second.next.mockImplementation(() => handler());

      middleware(first.req as Request, first.res as Response, first.next);
      middleware(second.req as Request, second.res as Response, second.next);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(first.next).toHaveBeenCalledTimes(1);
      expect(second.next).not.toHaveBeenCalled();
      expect(second.res.status).toHaveBeenCalledWith(409);
      expect(second.res.json).toHaveBeenCalledWith({
        error: {
          code: 'conflict',
          message: 'Request is already being processed',
          requestId: 'req-concurrent-2',
        },
      });
    });

    it('rejects concurrent requests that reuse the key with a different payload', () => {
      const { middleware } = createTestMiddleware();
      const handler = jest.fn();
      const headers = { 'idempotency-key': 'key-concurrent-conflict' };

      const first = makeReqRes({ headers, body: { amount: 100 } });
      first.next.mockImplementation(() => handler());

      const second = makeReqRes({
        headers,
        body: { amount: 999 },
        requestId: 'req-concurrent-conflict',
      });
      second.next.mockImplementation(() => handler());

      middleware(first.req as Request, first.res as Response, first.next);
      middleware(second.req as Request, second.res as Response, second.next);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(second.res.status).toHaveBeenCalledWith(409);
      expect(second.res.json).toHaveBeenCalledWith({
        error: {
          code: 'idempotency_payload_conflict',
          message: 'Idempotency key was already used with a different request payload.',
          requestId: 'req-concurrent-conflict',
        },
      });
    });
  });

  describe('default exported middleware', () => {
    it('uses the shared default store via clearIdempotencyStore', () => {
      const handler = jest.fn();
      const headers = { 'idempotency-key': 'default-store-key' };
      const { req, res, next } = makeReqRes({ headers, body: { ok: true } });

      next.mockImplementation(() => handler());
      idempotencyMiddleware(req as Request, res as Response, next);
      res.send(JSON.stringify({ ok: true }));

      clearIdempotencyStore();

      handler.mockClear();
      const retry = makeReqRes({ headers, body: { ok: true } });
      retry.next.mockImplementation(() => handler());
      idempotencyMiddleware(retry.req as Request, retry.res as Response, retry.next);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(retry.next).toHaveBeenCalledTimes(1);
    });
  });
});
