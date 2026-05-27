/**
 * Unit tests for `requirePermission` middleware.
 *
 * Covers:
 *   - 401 when req.user is missing.
 *   - 403 when the role lacks the required permission.
 *   - next() called when permission is granted.
 */

import { requirePermission } from '../middleware';
import { AuthenticatedRequest } from '../authenticate';
import { Response, NextFunction } from 'express';

function mockReq(user?: { userId: string; role: string }): AuthenticatedRequest {
  const req = { user } as AuthenticatedRequest;
  return req;
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

describe('requirePermission middleware', () => {
  it('should return 401 when req.user is not set', () => {
    const mw = requirePermission('contracts', 'read');
    const req = mockReq(undefined);
    const res = mockRes();
    const next = mockNext();

    mw(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Not authenticated' });
    expect(next).not.toHaveBeenCalled();
  });

  it('should return 403 when role lacks permission', () => {
    const mw = requirePermission('contracts', 'delete');
    const req = mockReq({ userId: 'u1', role: 'freelancer' });
    const res = mockRes();
    const next = mockNext();

    mw(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Forbidden: insufficient permissions' });
    expect(next).not.toHaveBeenCalled();
  });

  it('should call next when role has permission', () => {
    const mw = requirePermission('contracts', 'read');
    const req = mockReq({ userId: 'u1', role: 'admin' });
    const res = mockRes();
    const next = mockNext();

    mw(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('should return 403 for guest accessing contracts', () => {
    const mw = requirePermission('contracts', 'read');
    const req = mockReq({ userId: 'g1', role: 'guest' });
    const res = mockRes();
    const next = mockNext();

    mw(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('should allow admin to delete users', () => {
    const mw = requirePermission('users', 'delete');
    const req = mockReq({ userId: 'a1', role: 'admin' });
    const res = mockRes();
    const next = mockNext();

    mw(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  it('should deny freelancer from deleting users', () => {
    const mw = requirePermission('users', 'delete');
    const req = mockReq({ userId: 'f1', role: 'freelancer' });
    const res = mockRes();
    const next = mockNext();

    mw(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
  });
});
