/**
 * @file apiKeyMiddleware.recovery.test.ts
 * @description Failure-recovery tests for the API key consuming path (issue #1393).
 *
 * The contract under test is that **every** validation outcome produces exactly
 * one terminal result — `next()` once, or a response once — and that a failed
 * attempt can never leave a usable identity behind:
 *
 * - a synchronous throw *and* an async rejection from `validateApiKey` both map
 *   to the same single 500 (never an exception escaping the middleware);
 * - a repeated (array), empty or whitespace-only `X-API-Key` header is classified
 *   as missing credentials (401), never a 500;
 * - a rejected or failed attempt clears `req.apiKey` so an earlier identity
 *   cannot satisfy a later `requireApiKeyScope`;
 * - once a response has been committed, the middleware never writes a second one
 *   (`ERR_HTTP_HEADERS_SENT`);
 * - `requireApiKeyScope` reports a malformed identity as 401 instead of throwing.
 */

import { Response, NextFunction } from 'express';
import {
  authenticateApiKey,
  requireApiKeyScope,
  ApiKeyAuthenticatedRequest,
} from './apiKeyMiddleware';
import { validateApiKey, ApiKeyInfo } from './apiKeys';

jest.mock('./apiKeys', () => ({
  validateApiKey: jest.fn(),
}));

const mockedValidateApiKey = validateApiKey as jest.MockedFunction<typeof validateApiKey>;

/** Builds a request whose headers may hold repeated (array) values. */
function mockReq(
  headers: Record<string, string | string[] | undefined> = {},
): ApiKeyAuthenticatedRequest {
  return { headers } as unknown as ApiKeyAuthenticatedRequest;
}

type MockResponse = Response & {
  status: jest.Mock;
  json: jest.Mock;
  headersSent: boolean;
};

function mockRes(headersSent = false): MockResponse {
  const res: Partial<MockResponse> = { headersSent };
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as MockResponse;
}

function mockNext(): NextFunction {
  return jest.fn();
}

/** Flushes pending microtasks so async middleware callbacks run. */
async function flushAsync(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function wellFormedKey(overrides: Partial<ApiKeyInfo> = {}): ApiKeyInfo {
  return {
    id: 'key-1',
    name: 'recovery-key',
    scope: ['contracts:read'],
    createdBy: 'admin-1',
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    isActive: true,
    ...overrides,
  };
}

describe('authenticateApiKey — deterministic failure recovery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('maps a synchronous throw from validateApiKey to exactly one 500 without escaping', async () => {
    mockedValidateApiKey.mockImplementation(() => {
      throw new Error('synchronous dependency failure');
    });
    const req = mockReq({ 'x-api-key': 'any-key' });
    const res = mockRes();
    const next = mockNext();
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => authenticateApiKey(req, res, next)).not.toThrow();
    await flushAsync();

    expect(res.status).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalledWith({ error: 'Internal server error' });
    expect(next).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  it('maps an async rejection to exactly one 500', async () => {
    mockedValidateApiKey.mockRejectedValue(new Error('database connection lost'));
    const req = mockReq({ 'x-api-key': 'any-key' });
    const res = mockRes();
    const next = mockNext();
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    authenticateApiKey(req, res, next);
    await flushAsync();

    expect(res.status).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  it('classifies a repeated (array) X-API-Key header as missing credentials, never a 500', async () => {
    const req = mockReq({ 'x-api-key': ['first-key', 'second-key'] });
    const res = mockRes();
    const next = mockNext();

    authenticateApiKey(req, res, next);
    await flushAsync();

    expect(mockedValidateApiKey).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Missing X-API-Key header' });
    expect(next).not.toHaveBeenCalled();
  });

  it('classifies a whitespace-only header as missing credentials', async () => {
    const req = mockReq({ 'x-api-key': '   ' });
    const res = mockRes();
    const next = mockNext();

    authenticateApiKey(req, res, next);
    await flushAsync();

    expect(mockedValidateApiKey).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Missing X-API-Key header' });
  });

  it('clears a stale identity when the presented credential is rejected', async () => {
    mockedValidateApiKey.mockResolvedValue(null);
    const req = mockReq({ 'x-api-key': 'revoked-key' });
    req.apiKey = wellFormedKey({ id: 'stale-identity' });
    const res = mockRes();
    const next = mockNext();

    authenticateApiKey(req, res, next);
    await flushAsync();

    expect(req.apiKey).toBeUndefined();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('clears a stale identity when validation fails internally', async () => {
    mockedValidateApiKey.mockRejectedValue(new Error('boom'));
    const req = mockReq({ 'x-api-key': 'any-key' });
    req.apiKey = wellFormedKey({ id: 'stale-identity' });
    const res = mockRes();
    const next = mockNext();
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    authenticateApiKey(req, res, next);
    await flushAsync();

    expect(req.apiKey).toBeUndefined();
    consoleSpy.mockRestore();
  });

  it('does not write a second response once headers have been sent', async () => {
    mockedValidateApiKey.mockRejectedValue(new Error('late failure'));
    const req = mockReq({ 'x-api-key': 'any-key' });
    const res = mockRes(true); // response already committed by an earlier layer
    const next = mockNext();
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => authenticateApiKey(req, res, next)).not.toThrow();
    await flushAsync();

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  it('keeps the success path to a single next() with the identity attached', async () => {
    const keyInfo = wellFormedKey();
    mockedValidateApiKey.mockResolvedValue(keyInfo);
    const req = mockReq({ 'x-api-key': 'valid-key' });
    const res = mockRes();
    const next = mockNext();

    authenticateApiKey(req, res, next);
    await flushAsync();

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.apiKey).toEqual(keyInfo);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });
});

describe('requireApiKeyScope — malformed identity recovery', () => {
  it('returns 401 rather than throwing when scope is not an array', () => {
    const mw = requireApiKeyScope('contracts', 'read');
    const req = mockReq();
    req.apiKey = wellFormedKey({ scope: 'contracts:read' as unknown as string[] });
    const res = mockRes();
    const next = mockNext();

    expect(() => mw(req, res, next)).not.toThrow();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Not authenticated with API key' });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 for an inactive key', () => {
    const mw = requireApiKeyScope('contracts', 'read');
    const req = mockReq();
    req.apiKey = wellFormedKey({ isActive: false });
    const res = mockRes();
    const next = mockNext();

    mw(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});
