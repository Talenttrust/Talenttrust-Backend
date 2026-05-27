import { Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

// Must be set before authMiddleware is imported so authorization.ts reads
// the correct secret via its lazy getJwtSecret() getter
const TEST_SECRET = 'test-secret';
process.env.JWT_SECRET = TEST_SECRET;

import { authMiddleware, AuthenticatedRequest } from './auth';

describe('authMiddleware', () => {
  let res: Partial<Response> & { status: jest.Mock; json: jest.Mock };
  const next: NextFunction = jest.fn();

  beforeEach(() => {
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    (next as jest.Mock).mockClear();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns 401 when no Authorization header is present', async () => {
    const req = { headers: {} } as AuthenticatedRequest;
    await authMiddleware(req, res as Response, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Missing or malformed Authorization header.' });
  });

  it('returns 401 for an invalid or tampered token', async () => {
    const req = {
      headers: { authorization: 'Bearer this.is.invalid_token' },
    } as unknown as AuthenticatedRequest;

    await authMiddleware(req, res as Response, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid token.' });
  });

  it('calls next and parses user context on valid JWT', async () => {
    const validToken = jwt.sign(
      { sub: 'usr-123', email: 'test@tt.com', role: 'admin' },
      TEST_SECRET,
      { expiresIn: '1h' }
    );
    const req = {
      headers: { authorization: `Bearer ${validToken}` },
    } as unknown as AuthenticatedRequest;

    await authMiddleware(req, res as Response, next);

    expect(req.user).toBeDefined();
    expect(req.user?.id).toBe('usr-123');
    expect(req.user?.role).toBe('admin');
    expect(req.user?.email).toBe('test@tt.com');
    expect(next).toHaveBeenCalled();
  });
});
