import type { Request, Response, NextFunction } from 'express';
import { createHash } from 'crypto';
import { defaultIdempotencyStore } from '../db/idempotencyStore';

type StoredResponse = {
  statusCode: number;
  body: unknown;
};

function stableJsonStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((v) => stableJsonStringify(v)).join(',')}]`;
  }

  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJsonStringify(obj[k])}`).join(',')}}`;
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function getUserScopeId(req: Request): string | null {
  const anyReq = req as any;
  return anyReq?.user?.userId ?? anyReq?.user?.id ?? anyReq?.user?.sub ?? null;
}

function buildScopedKey(
  userScopeId: string,
  idempotencyKey: string,
  method: string,
  path: string,
): string {
  return sha256Hex(`${userScopeId}:${method}:${path}:${idempotencyKey.trim()}`);
}

function computePayloadHash(body: unknown): string {
  const normalized = body === undefined ? {} : body;
  return sha256Hex(stableJsonStringify(normalized));
}

function requestIdFrom(res: Response): string {
  return typeof res.locals.requestId === 'string' ? res.locals.requestId : 'unknown';
}

function errorResponse(res: Response, status: number, code: string, message: string) {
  return res.status(status).json({
    error: {
      code,
      message,
      requestId: requestIdFrom(res),
    },
  });
}

/**
 * Idempotency middleware for API key write endpoints.
 *
 * Applies to state-changing API key routes (create, rotate, deactivate).
 * When an `Idempotency-Key` header is present, the middleware:
 *   - Caches the response (status code and body) keyed by user, method, path,
 *     and the idempotency key.
 *   - Replays an identical retry with the original status and body.
 *   - Rejects the same key used with a different payload with 409.
 *
 * Requests without the header pass through unchanged. Cached entries respect
 * the TTL of the underlying {@link defaultIdempotencyStore}, so old keys
 * expire automatically.
 */
export function apiKeysIdempotencyMiddleware(): (
  req: Request,
  res: Response,
  next: NextFunction,
) => void {
  const store = defaultIdempotencyStore;

  return (req: Request, res: Response, next: NextFunction) => {
    const idempotencyKeyHeader = req.headers['idempotency-key'];

    if (
      typeof idempotencyKeyHeader !== 'string' ||
      idempotencyKeyHeader.trim().length === 0
    ) {
      return next();
    }

    const userScopeId = getUserScopeId(req);
    if (userScopeId === null) {
      return errorResponse(res, 401, 'unauthorized', 'Authentication required');
    }

    const path = req.originalUrl.split('?')[0];
    const scopedKey = buildScopedKey(
      userScopeId,
      idempotencyKeyHeader,
      req.method,
      path,
    );
    const payloadHash = computePayloadHash(req.body);

    const existing = store.get<StoredResponse>(scopedKey);
    if (existing) {
      if (existing.payloadHash !== payloadHash) {
        return errorResponse(
          res,
          409,
          'conflict',
          'Idempotency-Key was reused with a different request body',
        );
      }

      const cached = existing.result;
      res.setHeader('Idempotency-Replayed', 'true');
      res.status(cached.statusCode);
      res.json(cached.body);
      return;
    }

    const originalJson = res.json.bind(res);

    res.json = ((body: unknown) => {
      const stored: StoredResponse = {
        statusCode: res.statusCode,
        body,
      };

      store.set({
        key: scopedKey,
        payloadHash,
        result: stored,
        createdAt: new Date(),
      });

      return originalJson(body);
    }) as Response['json'];

    next();
  };
}
