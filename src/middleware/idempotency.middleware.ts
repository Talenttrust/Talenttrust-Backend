import { Request, Response, NextFunction } from 'express';
import { createHash } from 'crypto';

type Stored = {
  createdAt: number;
  expiresAt: number;
  requestSig: string;
  status: number;
  body: any;
};

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_MAX = 1000;

export function createIdempotencyMiddleware(opts?: { ttlMs?: number; maxEntries?: number }) {
  const ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
  const max = opts?.maxEntries ?? DEFAULT_MAX;

  // Map preserves insertion order; we'll remove oldest when exceeding max.
  const store = new Map<string, Stored>();

  function makeRequestSig(req: Request) {
    const payload = { method: req.method, path: req.originalUrl || req.url, body: req.body };
    return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  }

  function pruneIfNeeded() {
    while (store.size > max) {
      const firstKey = store.keys().next().value as string;
      if (!firstKey) break;
      store.delete(firstKey);
    }
  }

  return function idempotencyMiddleware(req: Request, res: Response, next: NextFunction) {
    const key = req.header('Idempotency-Key') || req.header('Idempotency-Key'.toLowerCase());
    // Only apply to requests with an idempotency key
    if (!key) return next();

    const now = Date.now();

    // Cleanup expired entries lazily
    for (const [k, v] of Array.from(store.entries())) {
      if (v.expiresAt <= now) store.delete(k);
    }

    const existing = store.get(key);
    const sig = makeRequestSig(req);
    if (existing) {
      if (existing.requestSig === sig) {
        res.status(existing.status).json(existing.body);
        return;
      } else {
        return res.status(409).json({ error: { code: 'idempotency_key_conflict', message: 'Idempotency-Key replay with different payload' } });
      }
    }

    // Capture response
    const _json = res.json.bind(res);
    const _send = res.send.bind(res);

    // Override json and send to capture body
    (res as any).json = function (body: any) {
      const status = res.statusCode || 200;
      store.set(key, {
        createdAt: now,
        expiresAt: now + ttlMs,
        requestSig: sig,
        status,
        body,
      });
      pruneIfNeeded();
      return _json(body);
    };

    (res as any).send = function (body: any) {
      const status = res.statusCode || 200;
      // try to JSON-parse send body if possible
      let parsed = body;
      try {
        if (typeof body === 'string') parsed = JSON.parse(body);
      } catch {}
      store.set(key, {
        createdAt: now,
        expiresAt: now + ttlMs,
        requestSig: sig,
        status,
        body: parsed,
      });
      pruneIfNeeded();
      return _send(body);
    };

    return next();
  };
}

export default createIdempotencyMiddleware();
