import { Request, Response, NextFunction } from 'express';

// Simple in-memory cache for idempotency keys. In a real application, 
// this should be moved to a persistent store like Redis or a database.
const idempotencyStore = new Map<string, {
  status: 'processing' | 'completed';
  timestamp: number;
  result?: any;
}>();

const CACHE_TTL = 3600 * 1000; // 1 hour TTL for idempotency keys

/**
 * Middleware to enforce idempotency keys for protected operations
 */
export const idempotencyMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const idempotencyKey = req.headers['idempotency-key'] as string;

  if (!idempotencyKey) {
    return res.status(400).json({ error: 'Idempotency-Key header is required' });
  }

  // Basic cleanup of old keys (can be optimized or moved to a separate job)
  const now = Date.now();
  for (const [key, value] of idempotencyStore.entries()) {
    if (now - value.timestamp > CACHE_TTL) {
      idempotencyStore.delete(key);
    }
  }

  const existingEntry = idempotencyStore.get(idempotencyKey);

  if (existingEntry) {
    if (existingEntry.status === 'processing') {
      return res.status(409).json({ error: 'Request is already being processed' });
    }
    
    // If it's already completed, return its cached result
    return res.status(existingEntry.status === 'completed' ? 200 : 409).json({
      ...existingEntry.result,
      idempotencyHeader: 'replay-detected'
    });
  }

  // Pre-register the key to prevent race conditions (basic version)
  idempotencyStore.set(idempotencyKey, {
    status: 'processing',
    timestamp: Date.now()
  });

  // Proxy the original send method to capture the result
  const originalSend = res.send;
  res.send = function (body: any): Response {
    idempotencyStore.set(idempotencyKey, {
      status: 'completed',
      timestamp: Date.now(),
      result: typeof body === 'string' ? JSON.parse(body) : body
    });
    return originalSend.apply(res, arguments as any);
  };

  next();
};

/**
 * Clean up the idempotency store manually (for testing or maintenance)
 */
export const clearIdempotencyStore = () => {
  idempotencyStore.clear();
};
