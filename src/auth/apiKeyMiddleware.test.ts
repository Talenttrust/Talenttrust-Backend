/**
 * @file apiKeyMiddleware.test.ts
 * @description Unit tests for API key authentication middleware.
 *
 * Covered scenarios:
 * - {@link authenticateApiKey}: missing X-API-Key header (401), invalid key (401),
 *   valid key attaches `req.apiKey` and calls `next()`.
 * - {@link requireApiKeyScope}: matching scope passes, scope mismatch returns 403,
 *   missing `req.apiKey` returns 401.
 * - {@link authenticateEither}: JWT Bearer path, X-API-Key fallback path, and
 *   rejection when both credentials are absent.
 * - 401/403 error bodies expose only public messages — no stack traces, database
 *   details, or raw key material.
 */

import { Request, Response, NextFunction } from 'express';
import {
  authenticateApiKey,
  requireApiKeyScope,
  authenticateEither,
  ApiKeyAuthenticatedRequest,
} from './apiKeyMiddleware';
import { validateApiKey, ApiKeyInfo } from './apiKeys';
import { authenticateMiddleware, createToken } from './authenticate';

jest.mock('./apiKeys', () => ({
  validateApiKey: jest.fn(),
}));

jest.mock('./authenticate', () => ({
  ...jest.requireActual('./authenticate'),
  authenticateMiddleware: jest.fn(),
}));

const mockedValidateApiKey = validateApiKey as jest.MockedFunction<typeof validateApiKey>;
const mockedAuthenticateMiddleware = authenticateMiddleware as jest.MockedFunction<
  typeof authenticateMiddleware
>;

/** Builds a minimal API key info object for scope tests. */
function mockApiKeyInfo(scope: string[]): ApiKeyInfo {
  return {
    id: 'key-test-1',
    name: 'integration-key',
    scope,
    createdBy: 'admin-1',
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    isActive: true,
  };
}

/** Builds a mock Express request with optional headers. */
function mockReq(headers: Record<string, string> = {}): ApiKeyAuthenticatedRequest {
  return { headers } as ApiKeyAuthenticatedRequest;
}

/** Mock Express response with typed jest spies for status/json. */
type MockResponse = Response & {
  status: jest.Mock;
  json: jest.Mock;
};

/** Builds a mock Express response with status/json spies. */
function mockRes(): MockResponse {
  const res: Partial<MockResponse> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as MockResponse;
}

/** Returns the body passed to the most recent `res.json` call. */
function jsonBody(res: MockResponse): Record<string, unknown> {
  return res.json.mock.calls[0][0] as Record<string, unknown>;
}

/** Builds a mock `next` function. */
function mockNext(): NextFunction {
  return jest.fn();
}

/** Flushes pending microtasks so async middleware callbacks run. */
async function flushAsync(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Asserts a JSON error body does not expose internal implementation details. */
function expectNoInternalLeak(body: Record<string, unknown>, secret?: string): void {
  const serialized = JSON.stringify(body);
  expect(body).not.toHaveProperty('stack');
  expect(body).not.toHaveProperty('message');
  expect(serialized).not.toMatch(/sql|database|key_hash|pbkdf2|ECONNREFUSED/i);
  if (secret) {
    expect(serialized).not.toContain(secret);
  }
}

describe('authenticateApiKey', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 401 when X-API-Key header is missing', async () => {
    const req = mockReq();
    const res = mockRes();
    const next = mockNext();

    authenticateApiKey(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Missing X-API-Key header' });
    expectNoInternalLeak(jsonBody(res));
    expect(next).not.toHaveBeenCalled();
    expect(mockedValidateApiKey).not.toHaveBeenCalled();
  });

  it('returns 401 when the API key is invalid', async () => {
    mockedValidateApiKey.mockResolvedValue(null);
    const secret = 'deadbeef'.repeat(8);
    const req = mockReq({ 'x-api-key': secret });
    const res = mockRes();
    const next = mockNext();

    authenticateApiKey(req, res, next);
    await flushAsync();

    expect(mockedValidateApiKey).toHaveBeenCalledWith(secret);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid API key' });
    expectNoInternalLeak(jsonBody(res), secret);
    expect(next).not.toHaveBeenCalled();
    expect(req.apiKey).toBeUndefined();
  });

  it('populates req.apiKey and calls next for a valid key', async () => {
    const keyInfo = mockApiKeyInfo(['contracts:read']);
    mockedValidateApiKey.mockResolvedValue(keyInfo);
    const req = mockReq({ 'x-api-key': 'valid-key-value' });
    const res = mockRes();
    const next = mockNext();

    authenticateApiKey(req, res, next);
    await flushAsync();

    expect(req.apiKey).toEqual(keyInfo);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('returns 500 without leaking validation errors when validateApiKey throws', async () => {
    mockedValidateApiKey.mockRejectedValue(new Error('database connection lost'));
    const req = mockReq({ 'x-api-key': 'any-key' });
    const res = mockRes();
    const next = mockNext();
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    authenticateApiKey(req, res, next);
    await flushAsync();

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Internal server error' });
    expectNoInternalLeak(jsonBody(res));
    expect(next).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
  });
});

describe('requireApiKeyScope', () => {
  it('calls next when the required scope is present', () => {
    const mw = requireApiKeyScope('contracts', 'read');
    const req = mockReq();
    req.apiKey = mockApiKeyInfo(['contracts:read']);
    const res = mockRes();
    const next = mockNext();

    mw(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('calls next when a wildcard scope matches', () => {
    const mw = requireApiKeyScope('contracts', 'write');
    const req = mockReq();
    req.apiKey = mockApiKeyInfo(['contracts:*']);
    const res = mockRes();
    const next = mockNext();

    mw(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  it('returns 403 when the API key lacks the required scope', () => {
    const mw = requireApiKeyScope('contracts', 'delete');
    const req = mockReq();
    req.apiKey = mockApiKeyInfo(['contracts:read']);
    const res = mockRes();
    const next = mockNext();

    mw(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Forbidden: insufficient API key scope',
      required: 'contracts:delete',
      provided: ['contracts:read'],
    });
    expectNoInternalLeak(jsonBody(res));
    expect(jsonBody(res)).not.toHaveProperty('stack');
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when req.apiKey is not set', () => {
    const mw = requireApiKeyScope('contracts', 'read');
    const req = mockReq();
    const res = mockRes();
    const next = mockNext();

    mw(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Not authenticated with API key' });
    expectNoInternalLeak(jsonBody(res));
    expect(next).not.toHaveBeenCalled();
  });
});

describe('authenticateEither', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('delegates to authenticateMiddleware when a Bearer token is present', () => {
    mockedAuthenticateMiddleware.mockImplementation((req, _res, next) => {
      (req as ApiKeyAuthenticatedRequest & { user?: { userId: string; role: string } }).user = {
        userId: 'jwt-user',
        role: 'admin',
      };
      next();
    });

    const token = createToken('jwt-user', 'admin');
    const req = mockReq({ authorization: `Bearer ${token}` });
    const res = mockRes();
    const next = mockNext();

    authenticateEither(req as Request, res, next);

    expect(mockedAuthenticateMiddleware).toHaveBeenCalledWith(req, res, next);
    expect(mockedValidateApiKey).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  it('falls back to authenticateApiKey when X-API-Key is provided without Bearer', async () => {
    const keyInfo = mockApiKeyInfo(['reputation:read']);
    mockedValidateApiKey.mockResolvedValue(keyInfo);

    const req = mockReq({ 'x-api-key': 'service-key-abc' });
    const res = mockRes();
    const next = mockNext();

    authenticateEither(req as Request, res, next);
    await flushAsync();

    expect(mockedAuthenticateMiddleware).not.toHaveBeenCalled();
    expect(mockedValidateApiKey).toHaveBeenCalledWith('service-key-abc');
    expect((req as ApiKeyAuthenticatedRequest).apiKey).toEqual(keyInfo);
    expect(next).toHaveBeenCalled();
  });

  it('returns 401 when neither Bearer token nor X-API-Key is provided', () => {
    const req = mockReq();
    const res = mockRes();
    const next = mockNext();

    authenticateEither(req as Request, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error:
        'Authentication required. Provide either Authorization: Bearer <token> or X-API-Key header',
    });
    expectNoInternalLeak(jsonBody(res));
    expect(mockedAuthenticateMiddleware).not.toHaveBeenCalled();
    expect(mockedValidateApiKey).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });
});
