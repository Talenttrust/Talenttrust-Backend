/**
 * Unit tests for authentication helpers: `decodeToken`, `createToken`,
 * and `authenticateMiddleware`.
 *
 * Covers:
 *   - Valid token creation and decoding round-trip.
 *   - Malformed / missing tokens.
 *   - Tokens with invalid roles.
 *   - Middleware behavior (sets req.user or returns 401).
 *   - State invariant protections (idempotency, immutability, type safety).
 *   - Boundary cases and regression scenarios.
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

  it('should return null for whitespace-only token', () => {
    expect(decodeToken('   ')).toBeNull();
  });

  it('should return null for array input instead of object', () => {
    const token = Buffer.from(JSON.stringify(['userId', 'role'])).toString('base64');
    expect(decodeToken(token)).toBeNull();
  });

  it('should return null for null input', () => {
    const token = Buffer.from(JSON.stringify(null)).toString('base64');
    expect(decodeToken(token)).toBeNull();
  });

  it('should trim whitespace from userId', () => {
    const token = Buffer.from(JSON.stringify({ userId: '  u1  ', role: 'admin' })).toString('base64');
    const payload = decodeToken(token);
    expect(payload).toEqual({ userId: 'u1', role: 'admin' });
  });

  it('should return null for whitespace-only userId', () => {
    const token = Buffer.from(JSON.stringify({ userId: '   ', role: 'admin' })).toString('base64');
    expect(decodeToken(token)).toBeNull();
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

  it('should trim whitespace from userId in createToken', () => {
    const token = createToken('  u1  ', 'admin');
    const raw = Buffer.from(token, 'base64').toString('utf-8');
    expect(JSON.parse(raw)).toEqual({ userId: 'u1', role: 'admin' });
  });

  it('should throw error for empty userId in createToken', () => {
    expect(() => createToken('', 'admin')).toThrow('userId must be a non-empty string');
  });

  it('should throw error for whitespace-only userId in createToken', () => {
    expect(() => createToken('   ', 'admin')).toThrow('userId must be a non-empty string');
  });

  it('should throw error for invalid role in createToken', () => {
    expect(() => createToken('u1', 'superuser' as any)).toThrow('invalid role "superuser"');
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

  // ---- State invariant: Single authentication (idempotency) ----

  it('should not overwrite req.user if already set (idempotency)', () => {
    const token1 = createToken('user-1', 'admin');
    const token2 = createToken('user-2', 'freelancer');
    const req = mockReq({ authorization: `Bearer ${token2}` }) as AuthenticatedRequest;
    req.user = { userId: 'user-1', role: 'admin' }; // Pre-set identity
    const res = mockRes();
    const next = mockNext();

    authenticateMiddleware(req, res, next);

    // Invariant: Original identity preserved
    expect(req.user).toEqual({ userId: 'user-1', role: 'admin' });
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  // ---- State invariant: Boundary cases ----

  it('should return 401 when token is empty after Bearer prefix', () => {
    const req = mockReq({ authorization: 'Bearer ' });
    const res = mockRes();
    const next = mockNext();

    authenticateMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid token' });
    expect(next).not.toHaveBeenCalled();
  });

  it('should return 401 when Authorization header is not a string', () => {
    const req = mockReq() as any;
    req.headers.authorization = 123; // Non-string value
    const res = mockRes();
    const next = mockNext();

    authenticateMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Missing or invalid Authorization header' });
    expect(next).not.toHaveBeenCalled();
  });

  it('should handle case-sensitive Bearer prefix correctly', () => {
    const token = createToken('u1', 'admin');
    const req = mockReq({ authorization: `bearer ${token}` }); // lowercase 'bearer'
    const res = mockRes();
    const next = mockNext();

    authenticateMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('should handle Bearer with extra spaces correctly', () => {
    const token = createToken('u1', 'admin');
    const req = mockReq({ authorization: `Bearer  ${token}` }); // double space
    const res = mockRes();
    const next = mockNext();

    authenticateMiddleware(req, res, next);

    // Invariant: Strict format required
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  // ---- State invariant: Regression scenarios ----

  it('should handle malformed base64 without crashing', () => {
    const req = mockReq({ authorization: 'Bearer !!!invalid-base64!!!' });
    const res = mockRes();
    const next = mockNext();

    authenticateMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('should handle extremely long tokens without crashing', () => {
    const longUserId = 'x'.repeat(10000);
    const token = Buffer.from(JSON.stringify({ userId: longUserId, role: 'admin' })).toString('base64');
    const req = mockReq({ authorization: `Bearer ${token}` });
    const res = mockRes();
    const next = mockNext();

    authenticateMiddleware(req, res, next);

    // Invariant: Should handle gracefully
    expect(req.user?.userId).toBe(longUserId);
    expect(next).toHaveBeenCalled();
  });

  // ---- State invariant: Tamper-proof (frozen req.user) ----

  it('should freeze req.user after setting to prevent downstream mutation', () => {
    const token = createToken('u1', 'admin');
    const req = mockReq({ authorization: `Bearer ${token}` });
    const res = mockRes();
    const next = mockNext();

    authenticateMiddleware(req, res, next);

    expect(req.user).toBeDefined();
    // Invariant: req.user should be frozen
    expect(Object.isFrozen(req.user)).toBe(true);
    
    // Attempting to modify should fail silently (in strict mode) or be ignored
    expect(() => {
      if (req.user) {
        (req.user as any).userId = 'hacked';
      }
    }).not.toThrow();
    
    // Value should remain unchanged
    expect(req.user?.userId).toBe('u1');
  });

  // ---- State invariant: Runtime validation of existing req.user ----

  it('should reject request if existing req.user is tampered with invalid structure', () => {
    const req = mockReq() as AuthenticatedRequest;
    req.user = { userId: 123, role: 'admin' } as any; // Tampered: userId is not a string
    const res = mockRes();
    const next = mockNext();

    authenticateMiddleware(req, res, next);

    // Invariant: Tampered req.user should be rejected
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Internal authentication error' });
    expect(next).not.toHaveBeenCalled();
  });

  it('should reject request if existing req.user has invalid role', () => {
    const req = mockReq() as AuthenticatedRequest;
    req.user = { userId: 'u1', role: 'hacker' as any }; // Tampered: invalid role
    const res = mockRes();
    const next = mockNext();

    authenticateMiddleware(req, res, next);

    // Invariant: Tampered req.user should be rejected
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Internal authentication error' });
    expect(next).not.toHaveBeenCalled();
  });

  it('should reject request if existing req.user has empty userId', () => {
    const req = mockReq() as AuthenticatedRequest;
    req.user = { userId: '', role: 'admin' }; // Tampered: empty userId
    const res = mockRes();
    const next = mockNext();

    authenticateMiddleware(req, res, next);

    // Invariant: Tampered req.user should be rejected
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Internal authentication error' });
    expect(next).not.toHaveBeenCalled();
  });

  it('should accept request if existing req.user is valid and well-formed', () => {
    const req = mockReq() as AuthenticatedRequest;
    req.user = { userId: 'u1', role: 'admin' }; // Valid
    const res = mockRes();
    const next = mockNext();

    authenticateMiddleware(req, res, next);

    // Invariant: Valid existing req.user should be accepted
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  // ---- State invariant: Response integrity ----

  it('should not send response if headers already sent', () => {
    const token = createToken('u1', 'admin');
    const req = mockReq({ authorization: `Bearer ${token}` });
    const res = mockRes() as any;
    res.headersSent = true; // Simulate response already sent
    const next = mockNext();

    authenticateMiddleware(req, res, next);

    // Invariant: Should not attempt to send response
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('should not send response if headers already sent on missing header', () => {
    const req = mockReq();
    const res = mockRes() as any;
    res.headersSent = true; // Simulate response already sent
    const next = mockNext();

    authenticateMiddleware(req, res, next);

    // Invariant: Should not attempt to send response
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  // ---- State invariant: Concurrent execution safety ----

  it('should handle concurrent authentication attempts safely', () => {
    const token = createToken('u1', 'admin');
    const req = mockReq({ authorization: `Bearer ${token}` });
    const res = mockRes();
    const next = mockNext();

    // Simulate concurrent calls
    authenticateMiddleware(req, res, next);
    authenticateMiddleware(req, res, next);

    // Invariant: Should only authenticate once
    expect(next).toHaveBeenCalledTimes(2); // Both call next (idempotent)
    expect(req.user?.userId).toBe('u1');
    expect(Object.isFrozen(req.user)).toBe(true);
  });
});
