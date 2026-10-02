/**
 * @file apiKeyMiddleware.validation-boundaries.test.ts
 * @description Accepted / rejected / duplicate / boundary / regression tests
 * for the API key consuming path (issue #1391).
 *
 * Coverage map:
 * - `readApiKeyHeader` — the pure boundary: accepted input, rejected input,
 *   duplicated submissions, and boundary values around
 *   {@link MAX_API_KEY_LENGTH}.
 * - `authenticateApiKey` — that a refused credential never reaches
 *   `validateApiKey` (so no hashing work is driven by a malformed header),
 *   that a malformed credential is a 401 and never a 500, and that refusal
 *   leaves no authorization state behind (VB-4).
 * - `requireApiKeyScope` — the closed scope grammar (VB-5), fail-closed
 *   handling of unreadable stored scopes, and construction-time validation of
 *   the route's own requirement (VB-6).
 * - `authenticateEither` — that the JWT-first fallback cannot throw on a
 *   non-string `Authorization` header, and that both entry points agree on
 *   the verdict for the same credential.
 * - Observability — every refusal carries a stable reason and the protected
 *   path, and no log record or response body ever carries key material.
 */

import { Response, NextFunction } from 'express';
import {
  authenticateApiKey,
  authenticateEither,
  requireApiKeyScope,
  readApiKeyHeader,
  MAX_API_KEY_LENGTH,
  MAX_REFLECTED_SCOPES,
  ApiKeyAuthenticatedRequest,
  ApiKeyHeaderResult,
} from './apiKeyMiddleware';
import type { ApiKeyInfo } from './apiKeys';
import { validateApiKey } from './apiKeys';
import { authenticateMiddleware } from './authenticate';
import { setWriteRecordImpl } from '../logger';
import type { LogRecord } from '../logger';

jest.mock('./apiKeys', () => ({
  validateApiKey: jest.fn(),
}));

jest.mock('./authenticate', () => ({
  authenticateMiddleware: jest.fn(),
}));

const mockedValidateApiKey = validateApiKey as jest.MockedFunction<typeof validateApiKey>;
const mockedAuthenticateMiddleware = authenticateMiddleware as jest.MockedFunction<
  typeof authenticateMiddleware
>;

/** A canonical credential: 64 lowercase hex characters, as `generateApiKey()` issues. */
const VALID_KEY = '4f2b'.repeat(16);

/** A second canonical credential, for the duplicate-submission cases. */
const OTHER_KEY = 'a71e'.repeat(16);

/** Builds a minimal API key info object for scope tests. */
function mockApiKeyInfo(scope: unknown): ApiKeyInfo {
  return {
    id: 'key-test-1',
    name: 'integration-key',
    scope,
    createdBy: 'admin-1',
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    isActive: true,
  } as unknown as ApiKeyInfo;
}

/** Builds a mock Express request with a path and optional headers. */
function mockReq(headers: Record<string, unknown> = {}): ApiKeyAuthenticatedRequest {
  return { headers, path: '/internal' } as unknown as ApiKeyAuthenticatedRequest;
}

type MockResponse = Response & { status: jest.Mock; json: jest.Mock };

function mockRes(): MockResponse {
  const res: Partial<MockResponse> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as MockResponse;
}

function jsonBody(res: MockResponse): Record<string, unknown> {
  return res.json.mock.calls[0][0] as Record<string, unknown>;
}

function mockNext(): NextFunction {
  return jest.fn();
}

async function flushAsync(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
}

/** Captured log records for the current test. */
let logRecords: LogRecord[] = [];

/** All log records emitted for a given message. */
function recordsFor(message: string): LogRecord[] {
  return logRecords.filter(r => r.message === message);
}

beforeEach(() => {
  jest.clearAllMocks();
  logRecords = [];
  setWriteRecordImpl(record => {
    logRecords.push(record);
  });
});

afterAll(() => {
  setWriteRecordImpl(() => {});
});

describe('readApiKeyHeader — accepted input', () => {
  it('accepts the canonical 64-character lowercase hex credential', () => {
    const result = readApiKeyHeader(VALID_KEY);

    expect(result).toEqual({ status: 'ok', key: VALID_KEY });
  });

  it('accepts every boundary value of length equal to MAX_API_KEY_LENGTH', () => {
    // The lowest and highest characters the alphabet allows, at both edges.
    const lowest = `0${'0'.repeat(62)}f`;
    const highest = `f${'0'.repeat(62)}f`;

    expect(lowest).toHaveLength(MAX_API_KEY_LENGTH);
    expect(highest).toHaveLength(MAX_API_KEY_LENGTH);
    expect(readApiKeyHeader(lowest).status).toBe('ok');
    expect(readApiKeyHeader(highest).status).toBe('ok');
  });
});

describe('readApiKeyHeader — rejected input', () => {
  it('reports an absent header as absent, not invalid', () => {
    expect(readApiKeyHeader(undefined)).toEqual({ status: 'absent', reason: 'missing_header' });
  });

  it('reports an empty header as absent, so the "missing" response is preserved', () => {
    expect(readApiKeyHeader('')).toEqual({ status: 'absent', reason: 'key_empty' });
  });

  it('refuses a non-string header instead of casting it', () => {
    // VB-1: a repeated header can reach the middleware as an array. The
    // previous `as string` cast let it through to
    // `crypto.createHash().update(array)`, which throws.
    expect(readApiKeyHeader([VALID_KEY])).toEqual({
      status: 'invalid',
      reason: 'header_not_string',
    });
  });

  it('refuses a numeric or object header', () => {
    expect(readApiKeyHeader(12345)).toEqual({ status: 'invalid', reason: 'header_not_string' });
    expect(readApiKeyHeader({ toString: () => VALID_KEY })).toEqual({
      status: 'invalid',
      reason: 'header_not_string',
    });
  });

  it('separates a blank credential from a mangled one', () => {
    expect(readApiKeyHeader(' ')).toEqual({ status: 'invalid', reason: 'key_blank' });
    expect(readApiKeyHeader('   \t  ')).toEqual({ status: 'invalid', reason: 'key_blank' });
  });

  it('refuses a credential padded with whitespace rather than trimming it', () => {
    // A trimmed credential would be an accepted spelling distinct from the
    // canonical one, and a trailing CR/LF is a log-forging vector.
    expect(readApiKeyHeader(` ${VALID_KEY}`)).toEqual({
      status: 'invalid',
      reason: 'key_too_long',
    });
    expect(readApiKeyHeader(`${VALID_KEY} `)).toEqual({
      status: 'invalid',
      reason: 'key_too_long',
    });
    expect(readApiKeyHeader(`4f2b${'4f2b'.repeat(14)}4f2b\r\n`)).toEqual({
      status: 'invalid',
      reason: 'key_too_long',
    });
    // 60 hex characters plus a space: in length, but not canonical.
    expect(readApiKeyHeader(`${'4f2b'.repeat(15)} `)).toEqual({
      status: 'invalid',
      reason: 'key_not_canonical',
    });
  });

  it('refuses non-hex characters inside the alphabet length', () => {
    expect(readApiKeyHeader('g'.repeat(MAX_API_KEY_LENGTH))).toEqual({
      status: 'invalid',
      reason: 'key_not_canonical',
    });
    expect(readApiKeyHeader(`g${'0'.repeat(MAX_API_KEY_LENGTH - 1)}`)).toEqual({
      status: 'invalid',
      reason: 'key_not_canonical',
    });
  });

  it('refuses an uppercase variant, so a key has exactly one spelling', () => {
    // The issuer only produces lowercase and `computeKeySelector` is
    // case-sensitive, so an uppercase key cannot match a stored one.
    expect(readApiKeyHeader(VALID_KEY.toUpperCase())).toEqual({
      status: 'invalid',
      reason: 'key_not_canonical',
    });
  });

  it('refuses non-ASCII look-alikes', () => {
    expect(readApiKeyHeader(`${'0'.repeat(62)}éé`)).toEqual({
      status: 'invalid',
      reason: 'key_not_canonical',
    });
  });

  it('never throws for any non-string input', () => {
    const hostile: unknown[] = [
      undefined,
      null,
      0,
      NaN,
      true,
      [],
      [VALID_KEY, OTHER_KEY],
      {},
      Symbol('x'),
      () => VALID_KEY,
    ];

    for (const input of hostile) {
      expect(() => readApiKeyHeader(input)).not.toThrow();
    }
  });
});

describe('readApiKeyHeader — duplicate submissions', () => {
  it('refuses a comma-joined duplicate header rather than authenticating one of them', () => {
    // RFC 7230 §3.2.2: repeated X-API-Key headers arrive joined by a comma.
    const joined = `${VALID_KEY},${OTHER_KEY}`;

    expect(joined).toHaveLength(MAX_API_KEY_LENGTH * 2 + 1);
    expect(readApiKeyHeader(joined).status).not.toBe('ok');
  });

  it('refuses a duplicate delivered as an array of two valid keys', () => {
    const result = readApiKeyHeader([VALID_KEY, OTHER_KEY]);

    expect(result).not.toEqual({ status: 'ok', key: VALID_KEY });
    expect(result).toEqual({ status: 'invalid', reason: 'header_not_string' });
  });

  it('is deterministic: a repeated call yields an identical verdict', () => {
    const inputs: unknown[] = [
      undefined,
      '',
      '   ',
      VALID_KEY,
      VALID_KEY.toUpperCase(),
      `${VALID_KEY},${OTHER_KEY}`,
      [VALID_KEY],
      'x'.repeat(MAX_API_KEY_LENGTH + 1),
    ];

    for (const input of inputs) {
      const first: ApiKeyHeaderResult = readApiKeyHeader(input);
      const second: ApiKeyHeaderResult = readApiKeyHeader(input);
      expect(second).toEqual(first);
    }
  });
});

describe('readApiKeyHeader — boundary values', () => {
  it('accepts exactly MAX_API_KEY_LENGTH and refuses one character more', () => {
    expect(readApiKeyHeader('0'.repeat(MAX_API_KEY_LENGTH - 1))).toEqual({
      status: 'invalid',
      reason: 'key_not_canonical',
    });
    expect(readApiKeyHeader('0'.repeat(MAX_API_KEY_LENGTH))).toEqual({
      status: 'ok',
      key: '0'.repeat(MAX_API_KEY_LENGTH),
    });
    expect(readApiKeyHeader(`0${'0'.repeat(MAX_API_KEY_LENGTH)}`)).toEqual({
      status: 'invalid',
      reason: 'key_too_long',
    });
  });

  it('refuses an oversized header on length alone, before any pattern scan', () => {
    const huge = 'a'.repeat(1024 * 1024);

    // Whitespace-only, so this also pins the check order: length is decided
    // before the whitespace test, so a megabyte is never pattern-scanned.
    const hugeBlank = ' '.repeat(1024 * 1024);
    expect(readApiKeyHeader(huge)).toEqual({ status: 'invalid', reason: 'key_too_long' });
    expect(readApiKeyHeader(hugeBlank)).toEqual({ status: 'invalid', reason: 'key_too_long' });
  });
});

describe('authenticateApiKey — refused credentials never reach the hasher', () => {
  beforeEach(() => {
    mockedValidateApiKey.mockResolvedValue(null);
  });

  it.each([
    ['whitespace only', '    ', 'key_blank'],
    ['not hex', 'n'.repeat(MAX_API_KEY_LENGTH), 'key_not_canonical'],
    ['uppercase', VALID_KEY.toUpperCase(), 'key_not_canonical'],
    ['one character too long', `0${'0'.repeat(MAX_API_KEY_LENGTH)}`, 'key_too_long'],
    ['comma-joined duplicate', `${VALID_KEY},${OTHER_KEY}`, 'key_too_long'],
  ])('returns 401 and skips validateApiKey for a key that is %s', async (_label, header, reason) => {
    const req = mockReq({ 'x-api-key': header });
    const res = mockRes();
    const next = mockNext();

    authenticateApiKey(req, res, next);
    await flushAsync();

    // The boundary decides before any hashing, so a malformed header cannot
    // drive the PBKDF2 fallback in `validateApiKey`.
    expect(mockedValidateApiKey).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid API key' });
    expect(next).not.toHaveBeenCalled();

    const rejections = recordsFor('auth_api_key_rejected');
    expect(rejections).toHaveLength(1);
    expect(rejections[0].reason).toBe(reason);
    expect(rejections[0].path).toBe('/internal');
  });

  it('returns 401 rather than 500 when the header arrives as an array', async () => {
    // Regression: the previous `as string` cast passed an array to
    // `validateApiKey`, where `computeKeySelector` threw a TypeError and the
    // caller got a 500 — a malformed credential changing the status code.
    const req = mockReq({ 'x-api-key': [VALID_KEY] });
    const res = mockRes();
    const next = mockNext();

    authenticateApiKey(req, res, next);
    await flushAsync();

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.status).not.toHaveBeenCalledWith(500);
    expect(mockedValidateApiKey).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    expect(recordsFor('auth_api_key_rejected')[0].reason).toBe('header_not_string');
  });

  it('keeps the distinct "missing" body for an absent or empty header', () => {
    for (const headers of [{}, { 'x-api-key': '' }]) {
      const res = mockRes();
      authenticateApiKey(mockReq(headers), res, mockNext());

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Missing X-API-Key header' });
    }
    expect(mockedValidateApiKey).not.toHaveBeenCalled();
  });

  it('logs key_rejected at warn for a canonical credential that does not authenticate', async () => {
    mockedValidateApiKey.mockResolvedValue(null);
    const res = mockRes();

    authenticateApiKey(mockReq({ 'x-api-key': VALID_KEY }), res, mockNext());
    await flushAsync();

    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid API key' });
    const rejections = recordsFor('auth_api_key_rejected');
    expect(rejections).toHaveLength(1);
    expect(rejections[0].reason).toBe('key_rejected');
    expect(rejections[0].level).toBe('warn');
  });
});

describe('authenticateApiKey — a refusal leaves no authorization state (VB-4)', () => {
  beforeEach(() => {
    mockedValidateApiKey.mockResolvedValue(null);
  });

  it.each([
    ['absent header', {}],
    ['empty header', { 'x-api-key': '' }],
    ['malformed header', { 'x-api-key': 'not-a-key' }],
    ['array header', { 'x-api-key': [VALID_KEY] }],
    ['rejected credential', { 'x-api-key': VALID_KEY }],
  ])('clears a pre-existing req.apiKey on the %s path', async (_label, headers) => {
    const req = mockReq(headers);
    req.apiKey = mockApiKeyInfo(['*']);
    const res = mockRes();
    const next = mockNext();

    authenticateApiKey(req, res, next);
    await flushAsync();

    // A stale identity must not survive: `requireApiKeyScope` mounted after
    // this middleware would otherwise authorise on the refused credential.
    expect(req.apiKey).toBeUndefined();
    expect(next).not.toHaveBeenCalled();
  });

  it('clears a pre-existing req.apiKey on the 500 path', async () => {
    mockedValidateApiKey.mockRejectedValue(new Error('database connection lost'));
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const req = mockReq({ 'x-api-key': VALID_KEY });
    req.apiKey = mockApiKeyInfo(['*']);
    const res = mockRes();
    const next = mockNext();

    authenticateApiKey(req, res, next);
    await flushAsync();

    expect(res.status).toHaveBeenCalledWith(500);
    expect(req.apiKey).toBeUndefined();
    expect(next).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('replaces, rather than merges, a pre-existing identity on success', async () => {
    const keyInfo = mockApiKeyInfo(['contracts:read']);
    mockedValidateApiKey.mockResolvedValue(keyInfo);
    const req = mockReq({ 'x-api-key': VALID_KEY });
    req.apiKey = mockApiKeyInfo(['*']);
    const res = mockRes();
    const next = mockNext();

    authenticateApiKey(req, res, next);
    await flushAsync();

    expect(req.apiKey).toEqual(keyInfo);
    expect(req.apiKey?.scope).toEqual(['contracts:read']);
    expect(next).toHaveBeenCalled();
  });
});

describe('authenticateApiKey — failure path is diagnosable and leaks nothing', () => {
  it('keeps the documented console.error on the 500 path and exposes no detail', async () => {
    mockedValidateApiKey.mockRejectedValue(new Error('database connection lost'));
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = mockRes();

    authenticateApiKey(mockReq({ 'x-api-key': VALID_KEY }), res, mockNext());
    await flushAsync();

    // The message is part of the documented alert in
    // docs/runbook-auth.md §5.2 — do not change it.
    expect(consoleSpy).toHaveBeenCalledWith('API key validation error:', expect.any(Error));

    const body = jsonBody(res);
    expect(body).toEqual({ error: 'Internal server error' });
    expect(body).not.toHaveProperty('stack');
    expect(body).not.toHaveProperty('message');
    expect(JSON.stringify(body)).not.toMatch(/sql|database|key_hash|pbkdf2|ECONNREFUSED/i);
    expect(JSON.stringify(body)).not.toContain(VALID_KEY);
    consoleSpy.mockRestore();
  });

  it('never writes key material to the log on any refusal path', async () => {
    mockedValidateApiKey.mockResolvedValue(null);
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const headers = [
      { 'x-api-key': VALID_KEY },
      { 'x-api-key': 'not-a-key' },
      { 'x-api-key': [VALID_KEY] },
      {},
    ];
    for (const header of headers) {
      authenticateApiKey(mockReq(header), mockRes(), mockNext());
      await flushAsync();
    }

    const serialized = JSON.stringify(logRecords);
    expect(recordsFor('auth_api_key_rejected').length).toBeGreaterThan(0);
    expect(serialized).not.toContain(VALID_KEY);
    expect(serialized).not.toContain(OTHER_KEY);
    consoleSpy.mockRestore();
  });
});

describe('requireApiKeyScope — the closed scope grammar (VB-5)', () => {
  it.each([
    ['exact match', 'contracts:read', 'contracts', 'read'],
    ['wildcard action', 'contracts:*', 'contracts', 'read'],
    ['wildcard resource', '*:read', 'contracts', 'read'],
    ['full wildcard', '*', 'contracts', 'delete'],
  ])('grants a %s', (_label, scope, resource, action) => {
    const req = mockReq();
    req.apiKey = mockApiKeyInfo([scope]);
    const next = mockNext();

    requireApiKeyScope(resource, action)(req, mockRes(), next);

    expect(next).toHaveBeenCalled();
  });

  it.each([
    ['a different resource', 'payments:read', 'contracts', 'read'],
    ['a different action', 'contracts:write', 'contracts', 'read'],
    ['a three-segment scope', 'contracts:read:*', 'contracts', 'read'],
    ['a three-segment wildcard resource', '*:admin:read', 'contracts', 'read'],
    ['a two-segment empty string', '', 'contracts', 'read'],
    ['a bare colon', ':', 'contracts', 'read'],
    ['a leading-colon scope', ':read', 'contracts', 'read'],
  ])('refuses %s', (_label, scope, resource, action) => {
    const req = mockReq();
    req.apiKey = mockApiKeyInfo([scope]);
    const res = mockRes();
    const next = mockNext();

    requireApiKeyScope(resource, action)(req, res, next);

    // A stored scope this service did not issue grants nothing.
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('denies rather than throws when the stored scope is not a list of strings', () => {
    // A `scope` JSON column can hold a bare string or hold non-strings
    // without any write-time bug being visible. Previously `.some()` threw
    // synchronously inside the middleware and Express turned an
    // authorization decision into a 500.
    for (const scope of ['*', { resource: 'contracts' }, 42, null, [1, 2], ['contracts:read', 7]]) {
      const req = mockReq();
      req.apiKey = mockApiKeyInfo(scope);
      const res = mockRes();
      const next = mockNext();

      expect(() => requireApiKeyScope('contracts', 'read')(req, res, next)).not.toThrow();
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Forbidden: insufficient API key scope',
        required: 'contracts:read',
        provided: [],
      });
      expect(next).not.toHaveBeenCalled();
    }
  });

  it('returns 401 when req.apiKey is not set', () => {
    const res = mockRes();
    const next = mockNext();

    requireApiKeyScope('contracts', 'read')(mockReq(), res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Not authenticated with API key' });
    expect(next).not.toHaveBeenCalled();
  });

  it('logs a scope denial with a stable reason and the required scope', () => {
    const req = mockReq();
    req.apiKey = mockApiKeyInfo(['contracts:read']);
    const res = mockRes();

    requireApiKeyScope('contracts', 'delete')(req, res, mockNext());

    const denials = recordsFor('auth_api_key_scope_denied');
    expect(denials).toHaveLength(1);
    expect(denials[0].reason).toBe('scope_mismatch');
    expect(denials[0].required).toBe('contracts:delete');
    expect(denials[0].path).toBe('/internal');
    expect(denials[0].level).toBe('warn');
  });
});

describe('requireApiKeyScope — reflection is bounded', () => {
  const RESOURCES = [
    'contracts',
    'payments',
    'jobs',
    'reviews',
    'reports',
    'settings',
    'users',
    'proposals',
    'disputes',
    'events',
  ];

  it('reflects at most MAX_REFLECTED_SCOPES entries in the 403 body', () => {
    // Every entry is a well-formed scope that does not grant `contracts:read`.
    const scopes = Array.from(
      { length: MAX_REFLECTED_SCOPES + 5 },
      (_, i) => `${RESOURCES[i % RESOURCES.length]}:write`,
    );
    const req = mockReq();
    req.apiKey = mockApiKeyInfo(scopes);
    const res = mockRes();

    requireApiKeyScope('contracts', 'read')(req, res, mockNext());

    const body = jsonBody(res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(body.provided).toHaveLength(MAX_REFLECTED_SCOPES);
    expect(body.required).toBe('contracts:read');
  });

  it('reflects every entry when the list is within the bound', () => {
    const scopes = ['contracts:write', 'payments:read'];
    const req = mockReq();
    req.apiKey = mockApiKeyInfo(scopes);
    const res = mockRes();

    requireApiKeyScope('contracts', 'read')(req, res, mockNext());

    expect(jsonBody(res).provided).toEqual(scopes);
  });
});

describe('requireApiKeyScope — the route requirement is validated when built (VB-6)', () => {
  it.each([
    ['an empty resource', '', 'read'],
    ['an empty action', 'contracts', ''],
    ['a wildcard resource', '*', 'read'],
    ['a wildcard action', 'contracts', '*'],
    ['an uppercase segment', 'Contracts', 'read'],
    ['a segment containing a colon', 'contracts', 'read:x'],
    ['a segment containing a space', 'con tracts', 'read'],
    ['a segment containing a digit', 'contracts1', 'read'],
    ['a non-string segment', null, 'read'],
  ])('throws TypeError at mount time for %s', (_label, resource, action) => {
    expect(() =>
      requireApiKeyScope(resource as unknown as string, action as unknown as string),
    ).toThrow(TypeError);
  });

  it('accepts the segments the system actually issues', () => {
    expect(() => requireApiKeyScope('contracts', 'read')).not.toThrow();
    expect(() => requireApiKeyScope('jobs', 'admin')).not.toThrow();
    expect(() => requireApiKeyScope('deploy', 'switch')).not.toThrow();
  });
});

describe('authenticateEither — JWT-first fallback', () => {
  it('does not throw when Authorization arrives as an array', () => {
    // Regression: `authHeader.startsWith` threw a TypeError out of a
    // synchronous middleware whenever the header was not a string.
    const req = mockReq({ authorization: ['Bearer abc'] });
    const res = mockRes();
    const next = mockNext();

    expect(() => authenticateEither(req, res, next)).not.toThrow();
    expect(mockedAuthenticateMiddleware).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('prefers a well-formed Bearer header over an API key on the same request', async () => {
    mockedAuthenticateMiddleware.mockImplementation((_req, _res, next) => next());
    mockedValidateApiKey.mockResolvedValue(mockApiKeyInfo(['contracts:read']));
    const req = mockReq({
      authorization: 'Bearer abc123',
      'x-api-key': VALID_KEY,
    });
    const next = mockNext();

    authenticateEither(req, mockRes(), next);
    await flushAsync();

    expect(mockedAuthenticateMiddleware).toHaveBeenCalledTimes(1);
    expect(mockedValidateApiKey).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  it('does not select the JWT branch for a lowercase scheme', () => {
    // Consistency with `BEARER_PATTERN` in ./authenticate, which this
    // delegates to and which is case-sensitive.
    const res = mockRes();

    authenticateEither(mockReq({ authorization: 'bearer abc123' }), res, mockNext());

    expect(mockedAuthenticateMiddleware).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('returns 401 when neither credential is supplied', () => {
    const res = mockRes();
    const next = mockNext();

    authenticateEither(mockReq(), res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error:
        'Authentication required. Provide either Authorization: Bearer <token> or X-API-Key header',
    });
    expect(mockedAuthenticateMiddleware).not.toHaveBeenCalled();
    expect(mockedValidateApiKey).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('treats an empty API key header as no credential at all', () => {
    const res = mockRes();

    authenticateEither(mockReq({ 'x-api-key': '' }), res, mockNext());

    expect(mockedValidateApiKey).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({
      error:
        'Authentication required. Provide either Authorization: Bearer <token> or X-API-Key header',
    });
  });
});

describe('authenticateEither — agrees with authenticateApiKey on the verdict', () => {
  it.each([
    ['whitespace only', '   '],
    ['not hex', 'not-a-key'],
    ['uppercase', VALID_KEY.toUpperCase()],
    ['one character too long', `0${'0'.repeat(MAX_API_KEY_LENGTH)}`],
    ['comma-joined duplicate', `${VALID_KEY},${OTHER_KEY}`],
  ])('returns the same 401 for a key that is %s', async (_label, header) => {
    mockedValidateApiKey.mockResolvedValue(null);

    const viaEither = mockRes();
    const viaApiKey = mockRes();
    const headers = { 'x-api-key': header };

    authenticateEither(mockReq(headers), viaEither, mockNext());
    authenticateApiKey(mockReq(headers), viaApiKey, mockNext());
    await flushAsync();

    expect(viaEither.status).toHaveBeenCalledWith(401);
    expect(viaEither.json).toHaveBeenCalledWith({ error: 'Invalid API key' });
    // One implementation, one verdict — not merely the same status code.
    expect(viaEither.json.mock.calls[0][0]).toEqual(viaApiKey.json.mock.calls[0][0]);
  });

  it('authenticates a canonical key through the fallback', async () => {
    const keyInfo = mockApiKeyInfo(['reputation:read']);
    mockedValidateApiKey.mockResolvedValue(keyInfo);
    const req = mockReq({ 'x-api-key': VALID_KEY });
    const next = mockNext();

    authenticateEither(req, mockRes(), next);
    await flushAsync();

    expect(mockedValidateApiKey).toHaveBeenCalledWith(VALID_KEY);
    expect(req.apiKey).toEqual(keyInfo);
    expect(next).toHaveBeenCalled();
  });
});
