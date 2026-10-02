/**
 * @module middleware/metricsIdempotency
 * @description Idempotency-Key middleware for metrics write endpoints.
 *
 * Metrics writes return 204 (no body). The generic idempotency middleware
 * assumes a JSON body on replay, so this variant stores the status code and
 * replays it verbatim — signalling the replay via the `Idempotency-Replayed`
 * response header rather than mutating the body.
 *
 * Behaviour:
 *  - No `Idempotency-Key` header → pass through (idempotency is optional).
 *  - First request → process normally, cache `{ statusCode, payloadHash }`.
 *  - Exact replay (same key + same body hash) → return original status, no body, header set.
 *  - Key reuse with different body → 409 `idempotency_payload_conflict`.
 *
 * The store is bounded by TTL (default 1 h) and a max-size cap (default 10 000
 * entries) to prevent unbounded memory growth under high write rates.
 */

import { Request, Response, NextFunction } from 'express';
import { createHash, timingSafeEqual } from 'crypto';

interface CachedEntry {
  payloadHash: string;
  statusCode: number;
}

interface MetricsIdempotencyStoreConfig {
  ttlMs?: number;
  maxSize?: number;
  clock?: () => number;
}

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_MAX_SIZE = 10_000;

/**
 * Minimal bounded TTL store for metrics idempotency records.
 * Exported for testing.
 */
export class MetricsIdempotencyStore {
  private readonly entries = new Map<string, { entry: CachedEntry; expiresAt: number }>();
  private readonly ttlMs: number;
  private readonly maxSize: number;
  private readonly clock: () => number;

  constructor(config: MetricsIdempotencyStoreConfig = {}) {
    this.ttlMs = config.ttlMs ?? DEFAULT_TTL_MS;
    this.maxSize = config.maxSize ?? DEFAULT_MAX_SIZE;
    this.clock = config.clock ?? (() => Date.now());
  }

  get(key: string): CachedEntry | undefined {
    const record = this.entries.get(key);
    if (!record) return undefined;
    if (record.expiresAt <= this.clock()) {
      this.entries.delete(key);
      return undefined;
    }
    return record.entry;
  }

  set(key: string, entry: CachedEntry): void {
    // Evict oldest entry when at capacity (simple FIFO eviction)
    if (!this.entries.has(key) && this.entries.size >= this.maxSize) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { entry, expiresAt: this.clock() + this.ttlMs });
  }

  size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }

  purgeExpired(): number {
    const now = this.clock();
    let purged = 0;
    for (const [key, record] of this.entries) {
      if (record.expiresAt <= now) {
        this.entries.delete(key);
        purged++;
      }
    }
    return purged;
  }
}

function hashBody(body: unknown): string {
  const normalized = body === undefined || body === null ? '{}' : canonicalize(body);
  return createHash('sha256').update(normalized).digest('hex');
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab); // constant-time dummy
    return false;
  }
  return timingSafeEqual(ab, bb);
}

export interface MetricsIdempotencyMiddlewareOptions {
  store?: MetricsIdempotencyStore;
}

/**
 * Factory that creates the metrics idempotency middleware with an injected store.
 * Pass a custom store in tests to isolate state.
 */
export function createMetricsIdempotencyMiddleware(
  options: MetricsIdempotencyMiddlewareOptions = {},
) {
  const store = options.store ?? defaultMetricsIdempotencyStore;

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length === 0) {
      next();
      return;
    }

    const payloadHash = hashBody(req.body);
    const existing = store.get(key);

    if (existing) {
      if (!safeEqual(existing.payloadHash, payloadHash)) {
        const requestId =
          typeof res.locals.requestId === 'string' ? res.locals.requestId : 'unknown';
        res.status(409).json({
          error: {
            code: 'idempotency_payload_conflict',
            message: 'Idempotency-Key was already used with a different request payload.',
            requestId,
          },
        });
        return;
      }

      // Exact replay — return original status with no body
      res.setHeader('Idempotency-Replayed', 'true');
      res.status(existing.statusCode).send();
      return;
    }

    // First request — intercept res.send to cache the outcome
    const originalSend = res.send.bind(res);
    res.send = function metricsIdempotencySend(body?: unknown): Response {
      store.set(key, { payloadHash, statusCode: res.statusCode });
      return originalSend(body);
    };

    next();
  };
}

export const defaultMetricsIdempotencyStore = new MetricsIdempotencyStore();

export const metricsIdempotencyMiddleware = createMetricsIdempotencyMiddleware();
