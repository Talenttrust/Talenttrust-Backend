import { Request, Response, NextFunction } from 'express';
import { createTenantRateLimiter } from '../tenantRateLimiter';

describe('tenantRateLimiter', () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  let next: jest.Mock<NextFunction>;

  beforeEach(() => {
    req = {
      method: 'POST',
      originalUrl: '/api/v1/events',
    };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
      setHeader: jest.fn(),
      locals: {},
    };
    next = jest.fn();
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('allows burst within budget', () => {
    const limiter = createTenantRateLimiter({ maxRequests: 5, windowMs: 60000 });
    req.user = { id: 'tenant1', role: 'user' };

    for (let i = 0; i < 5; i++) {
      limiter(req as Request, res as Response, next);
      expect(next).toHaveBeenCalledTimes(i + 1);
    }
  });

  it('blocks when over budget', () => {
    const limiter = createTenantRateLimiter({ maxRequests: 2, windowMs: 60000 });
    req.user = { id: 'tenant1', role: 'user' };

    limiter(req as Request, res as Response, next);
    limiter(req as Request, res as Response, next);
    expect(next).toHaveBeenCalledTimes(2);

    limiter(req as Request, res as Response, next);
    expect(next).toHaveBeenCalledTimes(2); // no third call
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', expect.any(Number));
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({ code: 'rate_limited' })
    }));
  });

  it('isolates different tenants', () => {
    const limiter = createTenantRateLimiter({ maxRequests: 1, windowMs: 60000 });
    
    // Tenant 1 exhausts limit
    req.user = { id: 'tenant1', role: 'user' };
    limiter(req as Request, res as Response, next);
    limiter(req as Request, res as Response, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(429);

    // Tenant 2 should still be allowed
    req.user = { id: 'tenant2', role: 'user' };
    const next2 = jest.fn();
    limiter(req as Request, res as Response, next2);
    expect(next2).toHaveBeenCalledTimes(1);
  });

  it('handles missing tenant (anonymous grouping)', () => {
    const limiter = createTenantRateLimiter({ maxRequests: 1, windowMs: 60000 });
    
    // First anon request allowed
    limiter(req as Request, res as Response, next);
    expect(next).toHaveBeenCalledTimes(1);

    // Second anon request blocked
    limiter(req as Request, res as Response, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(429);
  });

  it('allows admin bypass', () => {
    const limiter = createTenantRateLimiter({ maxRequests: 1, windowMs: 60000 });
    
    req.user = { id: 'admin1', role: 'admin' };
    
    for (let i = 0; i < 5; i++) {
      limiter(req as Request, res as Response, next);
    }
    
    // All requests went through despite maxRequests: 1
    expect(next).toHaveBeenCalledTimes(5);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('resets correctly at clock boundary', () => {
    const limiter = createTenantRateLimiter({ maxRequests: 1, windowMs: 60000 });
    req.user = { id: 'tenant1', role: 'user' };

    limiter(req as Request, res as Response, next);
    expect(next).toHaveBeenCalledTimes(1);
    
    limiter(req as Request, res as Response, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(429);
    
    // Advance time by 61 seconds (past the 60s window)
    jest.advanceTimersByTime(61000);
    
    limiter(req as Request, res as Response, next);
    expect(next).toHaveBeenCalledTimes(2);
  });
});
