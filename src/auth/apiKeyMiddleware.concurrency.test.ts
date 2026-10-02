/**
 * @file apiKeyMiddleware.concurrency.test.ts
 * @description End-to-end concurrency tests for the API-key authentication path
 * (issue #1394).
 *
 * Unlike `apiKeyMiddleware.test.ts`, which mocks `validateApiKey` to test the
 * middleware in isolation, this file deliberately drives the **real**
 * `validateApiKey` (and the real `AuthCache`) through the middleware, with only
 * the database boundary mocked. That is the only way to observe the behaviour
 * that actually matters under a burst of traffic:
 *
 * - one store lookup / one PBKDF2 verification / one bookkeeping write per key,
 *   no matter how many requests arrive together;
 * - a revocation that lands while a validation is in flight cannot be
 *   overwritten by the pre-revocation identity, so the revoked key is rejected
 *   from the very next request;
 * - duplicate rejected credentials are looked up once and produce identical
 *   401s;
 * - a failing store is not cached, so recovery does not require a restart.
 */

import { NextFunction, Request, Response } from 'express';
import { authenticateApiKey } from './apiKeyMiddleware';
import { AuthCache } from './authCache';
import {
  ApiKeyInfo,
  computeKeySelector,
  deactivateApiKey,
  hashApiKey,
  setAuthCache,
} from './apiKeys';
import { database } from '../database';

jest.mock('../database', () => ({
  database: {
    getApiKeyBySelector: jest.fn(),
    getApiKeyById: jest.fn(),
    updateApiKey: jest.fn(),
    deactivateApiKey: jest.fn(),
    loadDatabase: jest.fn(),
  },
}));

interface DbMock {
  getApiKeyBySelector: jest.Mock;
  getApiKeyById: jest.Mock;
  updateApiKey: jest.Mock;
  deactivateApiKey: jest.Mock;
  loadDatabase: jest.Mock;
}

const db = database as unknown as DbMock;

const RAW_KEY = 'concurrency-test-key';
const SELECTOR = computeKeySelector(RAW_KEY);
const { salt, hash } = hashApiKey(RAW_KEY);

/** A stored, active API-key row that verifies against `RAW_KEY`. */
function activeRow() {
  return {
    id: 'key-1',
    name: 'service-key',
    key_hash: `${salt}:${hash}`,
    key_selector: SELECTOR,
    scope: ['contracts:read'],
    created_by: 'user-1',
    created_at: new Date('2024-01-01T00:00:00.000Z'),
    updated_at: new Date('2024-01-01T00:00:00.000Z'),
    is_active: true,
  };
}

type MockResponse = Response & { status: jest.Mock; json: jest.Mock };

function mockRes(): MockResponse {
  const res: Partial<MockResponse> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as MockResponse;
}

/** Lets queued microtasks settle so the middleware's promise chain completes. */
async function settle(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** Runs one request through the real middleware. */
async function authenticate(
  apiKey: string
): Promise<{
  req: Request & { apiKey?: ApiKeyInfo };
  res: MockResponse;
  next: NextFunction;
}> {
  const req = { headers: { 'x-api-key': apiKey } } as unknown as Request & {
    apiKey?: ApiKeyInfo;
  };
  const res = mockRes();
  const next = jest.fn() as unknown as NextFunction;

  authenticateApiKey(req, res, next);
  await settle();

  return { req, res, next };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let cache: AuthCache;

beforeEach(() => {
  jest.clearAllMocks();
  cache = new AuthCache({ ttlMs: 60_000, maxEntries: 100 });
  setAuthCache(cache);

  db.updateApiKey.mockResolvedValue(null);
  db.deactivateApiKey.mockResolvedValue(true);
});

afterEach(() => {
  setAuthCache(null);
});

describe('authenticateApiKey under concurrent load', () => {
  it('verifies and records usage exactly once for a burst of requests sharing one key', async () => {
    let lookups = 0;
    db.getApiKeyBySelector.mockImplementation(async () => {
      lookups++;
      // Hold the lookup open so every request is genuinely in flight together.
      await new Promise((resolve) => setImmediate(resolve));
      return activeRow();
    });

    const requests = Array.from({ length: 4 }, () => authenticate(RAW_KEY));
    const outcomes = await Promise.all(requests);

    // Single flight: the burst collapses into one lookup, one verification
    // (10_000 synchronous PBKDF2 iterations) and one bookkeeping write.
    expect(lookups).toBe(1);
    expect(db.updateApiKey).toHaveBeenCalledTimes(1);

    for (const { req, res, next } of outcomes) {
      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
      expect(req.apiKey?.scope).toEqual(['contracts:read']);
      // The shared cached identity is immutable, so one request cannot rewrite
      // the authorization view another request sees.
      expect(Object.isFrozen(req.apiKey)).toBe(true);
    }
  });

  it('looks up a rejected credential once and returns the same 401 to everyone', async () => {
    db.getApiKeyBySelector.mockResolvedValue(null);
    db.loadDatabase.mockResolvedValue({ api_keys: [] });

    const outcomes = await Promise.all(
      Array.from({ length: 4 }, () => authenticate('unknown-key'))
    );

    expect(db.getApiKeyBySelector).toHaveBeenCalledTimes(1);
    for (const { res, next } of outcomes) {
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Invalid API key' });
      expect(next).not.toHaveBeenCalled();
    }
  });

  it('does not cache a store failure, so the next request retries and recovers', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    db.getApiKeyBySelector.mockRejectedValue(new Error('store unavailable'));

    try {
      const outcomes = await Promise.all(
        Array.from({ length: 3 }, () => authenticate(RAW_KEY))
      );

      expect(db.getApiKeyBySelector).toHaveBeenCalledTimes(1);
      for (const { res } of outcomes) {
        expect(res.status).toHaveBeenCalledWith(500);
      }

      // The failure is not pinned: once the store is healthy the key works.
      db.getApiKeyBySelector.mockResolvedValue(activeRow());
      const recovered = await authenticate(RAW_KEY);

      expect(recovered.next).toHaveBeenCalledTimes(1);
      expect(recovered.res.status).not.toHaveBeenCalled();
    } finally {
      consoleSpy.mockRestore();
    }
  });
});

describe('revocation racing an in-flight validation', () => {
  it('cannot repopulate the cache with the pre-revocation identity', async () => {
    const gate = deferred<ReturnType<typeof activeRow> | null>();
    db.getApiKeyBySelector.mockImplementationOnce(() => gate.promise);
    db.getApiKeyById.mockResolvedValue(activeRow());

    // Request A starts validating; its store read is held open.
    const inFlight = authenticate(RAW_KEY);
    await settle(2);
    expect(db.getApiKeyBySelector).toHaveBeenCalledTimes(1);

    // The key is revoked while A is still in flight. There is nothing in the
    // cache to delete yet, so the only protection is the invalidation epoch.
    await expect(deactivateApiKey('key-1')).resolves.toBe(true);

    // The store read now completes with the *pre*-revocation row.
    gate.resolve(activeRow());
    const first = await inFlight;

    // A began before the revoke, so it completes; the guarantee is about what
    // happens after it, not about retroactively failing an in-flight request.
    expect(first.next).toHaveBeenCalledTimes(1);

    // The revoked identity must not have been cached.
    expect(cache.get(SELECTOR)).toBeNull();

    // Request B (after the revoke) must hit the store and be rejected.
    db.getApiKeyBySelector.mockResolvedValue(null);
    db.loadDatabase.mockResolvedValue({ api_keys: [] });

    const second = await authenticate(RAW_KEY);
    expect(db.getApiKeyBySelector).toHaveBeenCalledTimes(2);
    expect(second.res.status).toHaveBeenCalledWith(401);
    expect(second.next).not.toHaveBeenCalled();
  });

  it('serves a revoked key only from an already-populated cache entry that is invalidated', async () => {
    db.getApiKeyBySelector.mockResolvedValue(activeRow());
    db.getApiKeyById.mockResolvedValue(activeRow());

    const warm = await authenticate(RAW_KEY);
    expect(warm.next).toHaveBeenCalledTimes(1);

    await deactivateApiKey('key-1');

    // Invalidation dropped the cached identity, so the next request re-reads the
    // store instead of authenticating from cache.
    db.getApiKeyBySelector.mockResolvedValue(null);
    db.loadDatabase.mockResolvedValue({ api_keys: [] });

    const rejected = await authenticate(RAW_KEY);
    expect(rejected.res.status).toHaveBeenCalledWith(401);
    expect(rejected.next).not.toHaveBeenCalled();
  });
});
