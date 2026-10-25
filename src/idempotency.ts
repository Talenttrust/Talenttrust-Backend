import { createHash } from 'crypto';
import { NextFunction, Request, Response } from 'express';
import { HttpError } from './store';

export interface StoredResponse {
  fingerprint: string;
  status: number;
  body: unknown;
  headers: Record<string, string>;
  createdAt: number;
}

/** Async on purpose so a persistent (e.g. Redis) adapter can implement it later. */
export interface IdempotencyStore {
  get(key: string): Promise<StoredResponse | undefined>;
  set(key: string, value: StoredResponse): Promise<void>;
  /** Returns false when the key is already locked (a request is in flight). */
  lock(key: string): Promise<boolean>;
  unlock(key: string): Promise<void>;
}

export class MemoryIdempotencyStore implements IdempotencyStore {
  // Map iteration order doubles as LRU order (oldest first).
  private entries = new Map<string, StoredResponse>();
  private locks = new Set<string>();

  constructor(
    private ttlMs = 24 * 60 * 60 * 1000,
    private maxEntries = 10_000,
    private now: () => number = () => Date.now(),
  ) {}

  get size() {
    return this.entries.size;
  }

  async get(key: string) {
    const v = this.entries.get(key);
    if (!v) return undefined;
    if (this.now() - v.createdAt > this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, v); // mark as most recently used
    return v;
  }

  async set(key: string, value: StoredResponse) {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.maxEntries) {
      this.entries.delete(this.entries.keys().next().value as string);
    }
  }

  async lock(key: string) {
    if (this.locks.has(key)) return false;
    this.locks.add(key);
    return true;
  }

  async unlock(key: string) {
    this.locks.delete(key);
  }
}

/** Recursively sort object keys so {a:1,b:2} and {b:2,a:1} hash identically. */
export function canonicalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonicalize);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(o)
        .sort()
        .map((k) => [k, canonicalize(o[k])]),
    );
  }
  return v;
}

export const fingerprint = (body: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(canonicalize(body ?? {})))
    .digest('hex');

const KEY_RE = /^[\x20-\x7e]{1,255}$/;
const REPLAY_HEADERS = ['location'];

const principalOf = (req: Request): string | null => {
  const id = (req as Request & { user?: { id?: unknown } }).user?.id;
  return id === undefined || id === null ? null : String(id);
};

const pickHeaders = (res: Response) => {
  const out: Record<string, string> = {};
  for (const h of REPLAY_HEADERS) {
    const v = res.getHeader(h);
    if (typeof v === 'string') out[h] = v;
  }
  return out;
};

export function idempotency(store: IdempotencyStore, opts: { required?: boolean } = {}) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'POST') return next();
    try {
      const key = req.header('Idempotency-Key');
      if (key === undefined) {
        if (opts.required) {
          throw new HttpError(400, 'idempotency_key_required', 'Idempotency-Key header is required on POST');
        }
        return next();
      }
      if (!KEY_RE.test(key)) {
        throw new HttpError(400, 'invalid_idempotency_key', 'Idempotency-Key must be 1-255 printable ASCII characters');
      }

      const scope = JSON.stringify([req.method, req.baseUrl + req.path, principalOf(req), key]);
      const fp = fingerprint(req.body);

      const replay = (hit: StoredResponse) => {
        if (hit.fingerprint !== fp) {
          throw new HttpError(422, 'idempotency_key_reused', 'Idempotency-Key was already used with a different request body');
        }
        for (const [h, v] of Object.entries(hit.headers)) res.setHeader(h, v);
        res.setHeader('Idempotent-Replayed', 'true');
        res.status(hit.status).json(hit.body);
      };

      const hit = await store.get(scope);
      if (hit) return replay(hit);

      if (!(await store.lock(scope))) {
        res.setHeader('Retry-After', '1');
        throw new HttpError(409, 'idempotency_request_in_progress', 'A request with this Idempotency-Key is still in progress');
      }

      // The first request may have finished between get() and lock().
      const again = await store.get(scope);
      if (again) {
        await store.unlock(scope);
        return replay(again);
      }

      let held = true;
      const release = async () => {
        if (!held) return;
        held = false;
        await store.unlock(scope).catch(() => undefined);
      };
      res.on('close', () => void release()); // client abort or error path

      const send = res.json.bind(res);
      res.json = ((payload: unknown) => {
        const status = res.statusCode;
        const stored: StoredResponse | undefined =
          status < 500
            ? {
                fingerprint: fp,
                status,
                // Snapshot: handlers return live store objects that later requests mutate.
                body: JSON.parse(JSON.stringify(payload ?? null)),
                headers: pickHeaders(res),
                createdAt: Date.now(),
              }
            : undefined; // 5xx: release the key so the client can retry
        void (async () => {
          try {
            if (stored) await store.set(scope, stored);
          } catch {
            /* fail open: the response is still sent */
          }
          await release(); // persist before unlocking, and both before the client sees the response
          send(payload);
        })();
        return res;
      }) as Response['json'];

      next();
    } catch (err) {
      next(err);
    }
  };
}
