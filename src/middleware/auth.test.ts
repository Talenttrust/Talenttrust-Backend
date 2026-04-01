import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { authenticateToken, AuthRequest } from './auth';

describe('authenticateToken', () => {
  let mockRequest: Partial<AuthRequest>;
  let mockResponse: Partial<Response>;
  let nextFunction: NextFunction = jest.fn();

  beforeEach(() => {
    mockRequest = {
      headers: {},
    };
    mockResponse = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
  });

  it('should return 401 if no Authorization header is present', () => {
    authenticateToken(mockRequest as AuthRequest, mockResponse as Response, nextFunction);
    expect(mockResponse.status).toHaveBeenCalledWith(401);
    expect(mockResponse.json).toHaveBeenCalledWith({ error: 'Authentication token required' });
  });

  it('should return 403 for an invalid token', () => {
    mockRequest.headers!['authorization'] = 'Bearer invalid-token';
    authenticateToken(mockRequest as AuthRequest, mockResponse as Response, nextFunction);
    expect(mockResponse.status).toHaveBeenCalledWith(403);
    expect(mockResponse.json).toHaveBeenCalledWith({ error: 'Invalid authentication token' });
  });

  it('should call next() for a valid token', () => {
    const user = { id: 'user-123' };
    const token = jwt.sign(user, process.env.JWT_SECRET || 'tt-dev-secret-keep-it-safe');
    mockRequest.headers!['authorization'] = `Bearer ${token}`;

    authenticateToken(mockRequest as AuthRequest, mockResponse as Response, nextFunction);
    expect(nextFunction).toHaveBeenCalled();
    expect((mockRequest as AuthRequest).user).toMatchObject(user);
  });
});
