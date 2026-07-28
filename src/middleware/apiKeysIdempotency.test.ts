/**
 * Unit tests for src/middleware/apiKeysIdempotency.ts
 *
 * Coverage targets:
 *   - Requests without Idempotency-Key pass through unchanged
 *   - First request with Idempotency-Key is processed and cached
 *   - Identical retry replays the original status/body and sets replay header
 *   - Reused key with a different payload returns HTTP 409
 *   - Keys are scoped to user + HTTP method + path
 *   - Empty request bodies are handled deterministically
 */

import { Request, Response } from 'express';
import { createHash } from 'crypto';
import { defaultIdempotencyStore } from '../db/idempotencyStore';
import { apiKeysIdempotencyMiddleware } from './apiKeysIdempotency';

function scopedKey(
  userId: string,
  idempotencyKey: string,
  method = 'POST',
  path = '/api/v1/api-keys',
): string {
  return createHash('sha256')
    .update(`${userId}:${method}:${path}:${idempotencyKey.trim()}`)
    .digest('hex');
}

function makeReqRes(options: {
  headers?: Record<string, string>;
  body?: unknown;
  user?: { userId: string };
  method?: string;
  originalUrl?: string;
} = {}): {
  req: Partial<Request>;
  res: Partial<Response> & {
    status: jest.Mock;
    json: jest.Mock;
    setHeader: jest.Mock;
    send: jest.Mock;
  };
  next: jest.Mock;
} {
  const res = {
    locals: {},
    statusCode: 200,
    status: jest.fn().mockImplementation((code: number) => {
      res.statusCode = code;
      return res;
    }),
    json: jest.fn().mockReturnThis(),
    setHeader: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
  };

  return {
    req: {
      headers: options.headers ?? {},
      body: options.body,
      user: options.user,
      method: options.method ?? 'POST',
      originalUrl: options.originalUrl ?? '/api/v1/api-keys',
    } as Partial<Request>,
    res: res as unknown as Partial<Response> & {
      status: jest.Mock;
      json: jest.Mock;
      setHeader: jest.Mock;
      send: jest.Mock;
    },
    next: jest.fn(),
  };
}

describe('apiKeysIdempotencyMiddleware', () => {
  beforeEach(() => {
    defaultIdempotencyStore.clear();
  });

  it('passes through when no Idempotency-Key header is present', () => {
    const middleware = apiKeysIdempotencyMiddleware();
    const { req, res, next } = makeReqRes({
      body: { name: 'Test', scope: ['contracts:read'] },
    });

    middleware(req as Request, res as Response, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.json).not.toHaveBeenCalled();
    expect(defaultIdempotencyStore.size()).toBe(0);
  });

  it('passes through when Idempotency-Key header is empty', () => {
    const middleware = apiKeysIdempotencyMiddleware();
    const { req, res, next } = makeReqRes({
      headers: { 'idempotency-key': '' },
      body: { name: 'Test', scope: ['contracts:read'] },
    });

    middleware(req as Request, res as Response, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.json).not.toHaveBeenCalled();
  });

  it('caches the response on the first request', () => {
    const middleware = apiKeysIdempotencyMiddleware();
    const handler = jest.fn();
    const { req, res, next } = makeReqRes({
      headers: { 'idempotency-key': 'key-first' },
      body: { name: 'Test', scope: ['contracts:read'] },
      user: { userId: 'user-1' },
    });

    next.mockImplementation(() => handler());
    middleware(req as Request, res as Response, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledTimes(1);

    const responseBody = { message: 'created', apiKey: 'abc', info: { id: '1' } };
    res.status(201);
    res.json(responseBody);

    expect(defaultIdempotencyStore.size()).toBe(1);
    const stored = defaultIdempotencyStore.get(scopedKey('user-1', 'key-first'));
    expect(stored).toBeDefined();
    expect(stored?.result).toEqual({ statusCode: 201, body: responseBody });
    expect(stored?.payloadHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('replays the original response on an identical retry', () => {
    const middleware = apiKeysIdempotencyMiddleware();
    const handler = jest.fn();
    const headers = { 'idempotency-key': 'key-replay' };
    const body = { name: 'Test', scope: ['contracts:read', 'contracts:create'] };

    const first = makeReqRes({
      headers,
      body,
      user: { userId: 'user-1' },
    });
    first.next.mockImplementation(() => handler());
    middleware(first.req as Request, first.res as Response, first.next);
    first.res.status(201);
    first.res.json({ message: 'created', apiKey: 'abc' });

    handler.mockClear();

    const replay = makeReqRes({
      headers,
      body,
      user: { userId: 'user-1' },
    });
    replay.next.mockImplementation(() => handler());
    middleware(replay.req as Request, replay.res as Response, replay.next);

    expect(handler).not.toHaveBeenCalled();
    expect(replay.next).not.toHaveBeenCalled();
    expect(replay.res.setHeader).toHaveBeenCalledWith('Idempotency-Replayed', 'true');
    expect(replay.res.status).toHaveBeenCalledWith(201);
    expect(replay.res.json).toHaveBeenCalledWith({ message: 'created', apiKey: 'abc' });
  });

  it('returns 409 when the same key is reused with a different payload', () => {
    const middleware = apiKeysIdempotencyMiddleware();
    const handler = jest.fn();
    const headers = { 'idempotency-key': 'key-conflict' };

    const first = makeReqRes({
      headers,
      body: { name: 'Test', scope: ['contracts:read'] },
      user: { userId: 'user-1' },
    });
    first.next.mockImplementation(() => handler());
    middleware(first.req as Request, first.res as Response, first.next);
    first.res.status(201);
    first.res.json({ message: 'created' });

    handler.mockClear();

    const conflict = makeReqRes({
      headers,
      body: { name: 'Other', scope: ['contracts:read'] },
      user: { userId: 'user-1' },
    });
    conflict.next.mockImplementation(() => handler());
    middleware(conflict.req as Request, conflict.res as Response, conflict.next);

    expect(handler).not.toHaveBeenCalled();
    expect(conflict.next).not.toHaveBeenCalled();
    expect(conflict.res.status).toHaveBeenCalledWith(409);
    expect(conflict.res.json).toHaveBeenCalledWith({
      error: {
        code: 'conflict',
        message: 'Idempotency-Key was reused with a different request body',
        requestId: 'unknown',
      },
    });
  });

  it('scopes idempotency keys by user', () => {
    const middleware = apiKeysIdempotencyMiddleware();
    const handler = jest.fn();
    const headers = { 'idempotency-key': 'shared-key' };

    const first = makeReqRes({
      headers,
      body: { name: 'User 1' },
      user: { userId: 'user-1' },
    });
    first.next.mockImplementation(() => handler());
    middleware(first.req as Request, first.res as Response, first.next);
    first.res.status(201);
    first.res.json({ id: '1' });

    const second = makeReqRes({
      headers,
      body: { name: 'User 1' },
      user: { userId: 'user-2' },
    });
    second.next.mockImplementation(() => handler());
    middleware(second.req as Request, second.res as Response, second.next);
    second.res.status(201);
    second.res.json({ id: '2' });

    expect(defaultIdempotencyStore.size()).toBe(2);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('scopes idempotency keys by HTTP method and path', () => {
    const middleware = apiKeysIdempotencyMiddleware();
    const handler = jest.fn();
    const headers = { 'idempotency-key': 'same-key' };

    const create = makeReqRes({
      headers,
      body: { name: 'Create' },
      user: { userId: 'user-1' },
      method: 'POST',
      originalUrl: '/api/v1/api-keys',
    });
    create.next.mockImplementation(() => handler());
    middleware(create.req as Request, create.res as Response, create.next);
    create.res.status(201);
    create.res.json({ id: 'create' });

    const rotate = makeReqRes({
      headers,
      body: {},
      user: { userId: 'user-1' },
      method: 'POST',
      originalUrl: '/api/v1/api-keys/key-1/rotate',
    });
    rotate.next.mockImplementation(() => handler());
    middleware(rotate.req as Request, rotate.res as Response, rotate.next);
    rotate.res.status(200);
    rotate.res.json({ id: 'rotate' });

    expect(defaultIdempotencyStore.size()).toBe(2);
  });

  it('handles empty request bodies deterministically', () => {
    const middleware = apiKeysIdempotencyMiddleware();
    const handler = jest.fn();
    const { req, res, next } = makeReqRes({
      headers: { 'idempotency-key': 'key-empty-body' },
      body: undefined,
      user: { userId: 'user-1' },
      method: 'DELETE',
      originalUrl: '/api/v1/api-keys/key-1',
    });

    next.mockImplementation(() => handler());
    middleware(req as Request, res as Response, next);
    res.json({ message: 'deactivated' });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(defaultIdempotencyStore.size()).toBe(1);
  });

  it('trims whitespace from the idempotency key', () => {
    const middleware = apiKeysIdempotencyMiddleware();
    const handler = jest.fn();

    const first = makeReqRes({
      headers: { 'idempotency-key': '  key-trim  ' },
      body: { name: 'Test' },
      user: { userId: 'user-1' },
    });
    first.next.mockImplementation(() => handler());
    middleware(first.req as Request, first.res as Response, first.next);
    first.res.json({ id: '1' });

    const replay = makeReqRes({
      headers: { 'idempotency-key': 'key-trim' },
      body: { name: 'Test' },
      user: { userId: 'user-1' },
    });
    replay.next.mockImplementation(() => handler());
    middleware(replay.req as Request, replay.res as Response, replay.next);

    expect(replay.res.setHeader).toHaveBeenCalledWith('Idempotency-Replayed', 'true');
    expect(replay.res.json).toHaveBeenCalledWith({ id: '1' });
  });

  it('returns 401 when no authenticated user is present', () => {
    const middleware = apiKeysIdempotencyMiddleware();
    const { req, res, next } = makeReqRes({
      headers: { 'idempotency-key': 'key-no-user' },
      body: { name: 'Test' },
    });

    middleware(req as Request, res as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error: {
        code: 'unauthorized',
        message: 'Authentication required',
        requestId: 'unknown',
      },
    });
  });

  it('treats expired cached entries as missing and processes the request', () => {
    const middleware = apiKeysIdempotencyMiddleware();
    const handler = jest.fn();
    const headers = { 'idempotency-key': 'key-expired' };
    const body = { name: 'Test' };

    const path = '/api/v1/api-keys';
    const method = 'POST';
    const userId = 'user-1';
    const expiredKey = createHash('sha256')
      .update(`${userId}:${method}:${path}:${headers['idempotency-key']}`)
      .digest('hex');

    defaultIdempotencyStore.set({
      key: expiredKey,
      payloadHash: 'anything',
      result: { statusCode: 201, body: { stale: true } },
      createdAt: new Date(Date.now() - 1000),
      expiresAt: new Date(Date.now() - 1),
    });

    const req = makeReqRes({
      headers,
      body,
      user: { userId },
      method,
      originalUrl: path,
    });
    req.next.mockImplementation(() => handler());
    middleware(req.req as Request, req.res as Response, req.next);
    req.res.status(201);
    req.res.json({ fresh: true });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(defaultIdempotencyStore.get(expiredKey)?.result.body).toEqual({ fresh: true });
    expect(defaultIdempotencyStore.get(expiredKey)?.result.statusCode).toBe(201);
  });
});
