import { Request, Response, NextFunction } from 'express';
import { createRateLimiter } from './rateLimiter';
import { RateLimitStoreInterface, RateLimitStore } from '../lib/rateLimitStore';

export interface TenantRateLimiterConfig {
  /** Maximum requests allowed per window */
  maxRequests?: number;
  /** Duration (ms) of the sliding window */
  windowMs?: number;
  /** Shared store instance */
  store?: RateLimitStoreInterface;
}

function resolveTenantId(req: Request): string | undefined {
  const user = (req as any).user;
  return user?.id ?? user?.userId ?? user?.sub;
}

export function createTenantRateLimiter(config: TenantRateLimiterConfig = {}) {
  const { 
    maxRequests = 100, 
    windowMs = 60_000, 
    store = new RateLimitStore({ sweepIntervalMs: windowMs }) 
  } = config;

  const limiter = createRateLimiter({
    maxRequests,
    windowMs,
    store,
    keyFn: (req: Request) => {
      const tenantId = resolveTenantId(req) ?? 'anonymous';
      const path = req.originalUrl?.split('?')[0] || req.url?.split('?')[0] || '/';
      return `tenant:${tenantId}:endpoint:${req.method}:${path}`;
    },
  });

  return (req: Request, res: Response, next: NextFunction): void => {
    // Admin bypass
    const user = (req as any).user;
    if (user?.role === 'admin') {
      return next();
    }

    return limiter(req, res, next);
  };
}
