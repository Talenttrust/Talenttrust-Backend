import type { Request, Response, NextFunction } from 'express';
import { TokenBucketLimiter, InMemoryRateLimitStore, type RateLimitPolicy, DEFAULT_RATE_LIMIT_POLICY } from './rateLimit';

export interface RateLimitMiddlewareOptions {
  policy?: RateLimitPolicy;
  store?: InMemoryRateLimitStore;
  clock?: () => number;
  enabled?: boolean;
}

function getClientKey(req: Request): string {
  // Use req.ip if available (trust proxy should be configured)
  if (req.ip) return req.ip;
  // Fallback
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    return forwarded.split(',')[0].trim();
  } else if (Array.isArray(forwarded) && forwarded[0]) {
    return forwarded[0].split(',')[0].trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}

function isExempt(req: Request, policy: RateLimitPolicy): boolean {
  const path = req.path;
  const exempt = policy.exemptPaths || [];
  if (exempt.includes(path)) return true;
  // Also exempt /health/live, /health/ready if under /health
  if (path.startsWith('/health')) return true;
  if (path.startsWith('/docs')) return true;
  return false;
}

function isWrite(req: Request): boolean {
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return false;
  return true;
}

export function createRateLimitMiddleware(options: RateLimitMiddlewareOptions = {}) {
  const policy = options.policy || DEFAULT_RATE_LIMIT_POLICY;
  const enabled = options.enabled !== undefined ? options.enabled : process.env.RATE_LIMIT_ENABLED !== 'false';
  const store = options.store || new InMemoryRateLimitStore(50000);
  const clock = options.clock || (() => Date.now());

  const readPerMin = parseInt(process.env.RATE_LIMIT_READ_PER_MIN || String(policy.read?.perMinute || 120), 10);
  const writePerMin = parseInt(process.env.RATE_LIMIT_WRITE_PER_MIN || String(policy.write?.perMinute || 20), 10);

  const readBurst = policy.read?.burst || Math.ceil(readPerMin * 0.5);
  const writeBurst = policy.write?.burst || Math.ceil(writePerMin * 0.5);

  const readLimiter = new TokenBucketLimiter({
    maxTokens: readBurst,
    refillRate: readPerMin / 60, // per second
    store,
    clock,
  });

  const writeLimiter = new TokenBucketLimiter({
    maxTokens: writeBurst,
    refillRate: writePerMin / 60,
    store,
    clock,
  });

  return (req: Request, res: Response, next: NextFunction) => {
    if (!enabled) return next();
    if (isExempt(req, policy)) return next();

    const key = getClientKey(req);
    const write = isWrite(req);
    const limiter = write ? writeLimiter : readLimiter;
    const limit = write ? writePerMin : readPerMin;

    // Use a namespaced key
    const bucketKey = write ? `write:${key}` : `read:${key}`;
    const result = limiter.tryConsume(bucketKey, 1);

    res.setHeader('RateLimit-Limit', String(limit));
    res.setHeader('RateLimit-Remaining', String(result.remaining));
    res.setHeader('RateLimit-Reset', String(result.resetSeconds));
    res.setHeader('RateLimit-Policy', write ? `write=${writePerMin};burst=${writeBurst}` : `read=${readPerMin};burst=${readBurst}`);

    if (!result.allowed) {
      if (result.retryAfterSeconds) {
        res.setHeader('Retry-After', String(result.retryAfterSeconds));
      }
      return res.status(429).json({ error: 'rate_limited', message: 'Too many requests' });
    }

    next();
  };
}
