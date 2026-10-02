/**
 * @file authenticate.contract.test.ts
 * @description Compatibility-contract tests for the legacy bearer middleware
 * (issue #1415).
 *
 * These tests treat `authenticateMiddleware` as a frozen public surface: they
 * pin the exact status codes and response bodies, the shape of `req.user`, the
 * accepted scheme, and the number of terminal outcomes for every class of input
 * a real HTTP request can produce. A change that alters any of these is a
 * breaking change to every existing caller and must be an explicit,
 * reviewable decision — not an accident.
 */

import { Response, NextFunction } from 'express';
import {
  authenticateMiddleware,
  createToken,
  AuthenticatedRequest,
  AUTH_SCHEME,
} from './authenticate';
import { VALID_ROLES } from './roles';

function mockReq(
  headers: Record<string, string | string[] | undefined> = {},
): AuthenticatedRequest {
  return { headers } as unknown as AuthenticatedRequest;
}

type MockResponse = Response & { status: jest.Mock; json: jest.Mock };

function mockRes(): MockResponse {
  const res: Partial<MockResponse> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as MockResponse;
}

function mockNext(): NextFunction {
  return jest.fn();
}

function jsonBody(res: MockResponse): Record<string, unknown> {
  return res.json.mock.calls[0][0] as Record<string, unknown>;
}

describe('authenticateMiddleware — compatibility contract', () => {
  it('exports the accepted scheme as a stable constant', () => {
    expect(AUTH_SCHEME).toBe('Bearer ');
  });

  it('returns 401 with the documented body when the header is absent', () => {
    const res = mockRes();
    const next = mockNext();

    authenticateMiddleware(mockReq(), res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Missing or invalid Authorization header',
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when the scheme does not match', () => {
    const res = mockRes();
    const next = mockNext();

    authenticateMiddleware(mockReq({ authorization: `Basic ${createToken('u1', 'admin')}` }), res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Missing or invalid Authorization header',
    });
  });

  it('rejects the scheme case-sensitively', () => {
    const token = createToken('u1', 'admin');
    const res = mockRes();
    const next = mockNext();

    authenticateMiddleware(mockReq({ authorization: `bearer ${token}` }), res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Missing or invalid Authorization header',
    });
  });

  it('rejects a prefix without the required trailing space', () => {
    const token = createToken('u1', 'admin');
    const res = mockRes();
    const next = mockNext();

    authenticateMiddleware(mockReq({ authorization: `Bearer${token}` }), res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('treats a repeated (array) Authorization header as malformed, never a throw', () => {
    const token = createToken('u1', 'admin');
    const req = mockReq({ authorization: [`Bearer ${token}`, `Bearer ${token}`] });
    const res = mockRes();
    const next = mockNext();

    expect(() => authenticateMiddleware(req, res, next)).not.toThrow();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Missing or invalid Authorization header',
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 `Invalid token` for an empty token after the scheme', () => {
    const res = mockRes();
    const next = mockNext();

    authenticateMiddleware(mockReq({ authorization: AUTH_SCHEME }), res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid token' });
  });

  it('returns 401 `Invalid token` for malformed or unknown-role tokens', () => {
    const badRole = Buffer.from(JSON.stringify({ userId: 'u1', role: 'hacker' })).toString('base64');
    for (const authorization of [`${AUTH_SCHEME}garbage`, `${AUTH_SCHEME}${badRole}`]) {
      const res = mockRes();
      const next = mockNext();
      authenticateMiddleware(mockReq({ authorization }), res, next);
      expect(res.json).toHaveBeenCalledWith({ error: 'Invalid token' });
      expect(next).not.toHaveBeenCalled();
    }
  });

  it('attaches req.user and calls next exactly once for a valid token', () => {
    const token = createToken('u42', 'client');
    const req = mockReq({ authorization: `${AUTH_SCHEME}${token}` });
    const res = mockRes();
    const next = mockNext();

    authenticateMiddleware(req, res, next);

    expect(req.user).toEqual({ userId: 'u42', role: 'client' });
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  it('replaces any pre-existing identity instead of merging it', () => {
    const token = createToken('u7', 'admin');
    const req = mockReq({ authorization: `${AUTH_SCHEME}${token}` });
    req.user = { userId: 'stale', role: 'guest' };
    const res = mockRes();
    const next = mockNext();

    authenticateMiddleware(req, res, next);

    expect(req.user).toEqual({ userId: 'u7', role: 'admin' });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('round-trips every valid role through createToken', () => {
    for (const role of VALID_ROLES) {
      const req = mockReq({ authorization: `${AUTH_SCHEME}${createToken(`user-${role}`, role)}` });
      const res = mockRes();
      const next = mockNext();

      authenticateMiddleware(req, res, next);

      expect(req.user).toEqual({ userId: `user-${role}`, role });
      expect(next).toHaveBeenCalledTimes(1);
    }
  });

  it('only ever exposes a single `error` field in rejection bodies', () => {
    const cases = [
      mockReq(),
      mockReq({ authorization: 'Basic x' }),
      mockReq({ authorization: `${AUTH_SCHEME}garbage` }),
    ];
    for (const req of cases) {
      const res = mockRes();
      authenticateMiddleware(req, res, mockNext());
      expect(Object.keys(jsonBody(res))).toEqual(['error']);
    }
  });
});
