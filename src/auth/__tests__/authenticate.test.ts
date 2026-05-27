/**
 * Unit tests for authentication helpers: `decodeToken`, `createToken`,
 * and `authenticateMiddleware`.
 *
 * Covers:
 *   - Valid token creation and decoding round-trip.
 *   - Malformed / missing tokens.
 *   - Tokens with invalid roles.
 *   - Middleware behavior (sets req.user or returns 401).
 */

import { decodeToken, createToken, authenticateMiddleware, AuthenticatedRequest } from '../authenticate';
import { Response, NextFunction } from 'express';

// ---- helpers to mock Express objects ----

function mockReq(headers: Record<string, string> = {}): AuthenticatedRequest {
  return { headers } as AuthenticatedRequest;
}

function mockRes(): Response {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response;
}

function mockNext(): NextFunction {
  return jest.fn();
}

// ---- decodeToken ----

describe('decodeToken', () => {
  it('should decode a valid token', () => {
    const token = createToken('u1', 'freelancer');
    const payload = decodeToken(token);
    expect(payload).toEqual({ userId: 'u1', role: 'freelancer' });
  });

  it('should return null for non-base64 input', () => {
    expect(decodeToken('not-valid!!!')).toBeNull();
  });

  it('should return null for base64 that is not JSON', () => {
    const token = Buffer.from('just a string').toString('base64');
    expect(decodeToken(token)).toBeNull();
  });

  it('should return null when userId is missing', () => {
    const token = Buffer.from(JSON.stringify({ role: 'admin' })).toString('base64');
    expect(decodeToken(token)).toBeNull();
  });

  it('should return null when role is missing', () => {
    const token = Buffer.from(JSON.stringify({ userId: 'u1' })).toString('base64');
    expect(decodeToken(token)).toBeNull();
  });

  it('should return null when role is invalid', () => {
    const token = Buffer.from(JSON.stringify({ userId: 'u1', role: 'superuser' })).toString('base64');
    expect(decodeToken(token)).toBeNull();
  });

  it('should return null when userId is empty string', () => {
    const token = Buffer.from(JSON.stringify({ userId: '', role: 'admin' })).toString('base64');
    expect(decodeToken(token)).toBeNull();
  });

  it('should return null for empty string token', () => {
    expect(decodeToken('')).toBeNull();
  });
});

// ---- createToken ----

describe('createToken', () => {
  it('should produce a base64 string', () => {
    const token = createToken('u1', 'admin');
    // Should not throw when decoded
    const raw = Buffer.from(token, 'base64').toString('utf-8');
    expect(JSON.parse(raw)).toEqual({ userId: 'u1', role: 'admin' });
  });

  it('round-trip: createToken → decodeToken', () => {
    for (const role of ['admin', 'freelancer', 'client', 'guest'] as const) {
      const token = createToken(`user-${role}`, role);
      expect(decodeToken(token)).toEqual({ userId: `user-${role}`, role });
    }
  });
});

// ---- authenticateMiddleware ----

describe('authenticateMiddleware', () => {
  it('should return 401 when Authorization header is missing', () => {
    const req = mockReq();
    const res = mockRes();
    const next = mockNext();

    authenticateMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Missing or invalid Authorization header' });
    expect(next).not.toHaveBeenCalled();
  });

  it('should return 401 when Authorization header does not start with Bearer', () => {
    const req = mockReq({ authorization: 'Basic abc123' });
    const res = mockRes();
    const next = mockNext();

    authenticateMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('should return 401 when token is invalid', () => {
    const req = mockReq({ authorization: 'Bearer garbage-data' });
    const res = mockRes();
    const next = mockNext();

    authenticateMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid token' });
    expect(next).not.toHaveBeenCalled();
  });

  it('should set req.user and call next for valid token', () => {
    const token = createToken('u42', 'client');
    const req = mockReq({ authorization: `Bearer ${token}` });
    const res = mockRes();
    const next = mockNext();

    authenticateMiddleware(req, res, next);

    expect(req.user).toEqual({ userId: 'u42', role: 'client' });
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('should return 401 when bearer token contains an invalid role', () => {
    const badToken = Buffer.from(JSON.stringify({ userId: 'u1', role: 'hacker' })).toString('base64');
    const req = mockReq({ authorization: `Bearer ${badToken}` });
    const res = mockRes();
    const next = mockNext();

    authenticateMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});
