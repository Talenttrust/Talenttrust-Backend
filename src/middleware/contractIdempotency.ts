import type { Request, Response, NextFunction } from 'express';
import { createHash } from 'crypto';
import { defaultIdempotencyStore } from '../db/idempotencyStore';

/**
 * Contract creation idempotency middleware.
 *
 * Enforces HTTP idempotency for:
 *   POST /api/v1/contracts
 *
 * Behavior:
 * - Requires Idempotency-Key header
 * - Idempotency keys are scoped to the authenticated user (req.user.id)
 * - Same key + same body returns the original response
 * - Same key + different body returns 409 Conflict
 */

type StoredResponse = {
  statusCode: number;
  body: unknown;
};

type StoredIdempotency = {
  payloadHash: string;
  result: StoredResponse;
};

function stableJsonStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);

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
  // Prefer user.id from this repo's JWT middleware (req.user.id == decoded.sub)
  // Never fall back to a shared scope - return null if no authenticated user exists
  return anyReq?.user?.id ?? anyReq?.user?.userId ?? anyReq?.user?.sub ?? null;
}

function buildScopedKey(userScopeId: string, idempotencyKey: string): string {
  return sha256Hex(`${userScopeId}:${idempotencyKey.trim()}`);
}

function computePayloadHash(body: unknown): string {
  return sha256Hex(stableJsonStringify(body));
}

export function contractCreateIdempotencyMiddleware(): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  const store = defaultIdempotencyStore;

  return async (req: Request, res: Response, next: NextFunction) => {
    const idempotencyKeyHeader = req.headers['idempotency-key'];
    const requestId = typeof (res.locals as any)?.requestId === 'string' ? (res.locals as any).requestId : 'unknown';

    if (typeof idempotencyKeyHeader !== 'string' || idempotencyKeyHeader.trim().length === 0) {
      res.status(400).json({
        error: {
          code: 'bad_request',
          message: 'Idempotency-Key header is required',
          requestId,
        },
      });
      return;
    }

    const userScopeId = getUserScopeId(req);
    
    // Fail closed: reject unauthenticated requests to prevent shared-scope collisions
    if (userScopeId === null) {
      res.status(401).json({
        error: {
          code: 'unauthorized',
          message: 'Authentication required for idempotent contract creation',
          requestId,
        },
      });
      return;
    }
    
    const scopedKey = buildScopedKey(userScopeId, idempotencyKeyHeader);
    const currentPayloadHash = computePayloadHash(req.body);

    const existing = store.get<StoredIdempotency>(scopedKey);
    if (existing) {
      if (existing.payloadHash !== currentPayloadHash) {
        res.status(409).json({
          error: {
            code: 'conflict',
            message: 'Idempotency-Key was reused with a different request body',
            requestId,
          },
        });
        return;
      }

      const cached = existing.result;
      // Return the original response verbatim so a replay is byte-for-byte
      // identical to the first response. The replay is signalled via a header
      // rather than by mutating the cached body.
      res.setHeader('Idempotency-Replayed', 'true');
      res.status(cached.result.statusCode);
      res.json(cached.result.body);
      return;
    }

    // Capture response and store it with payload hash.
    const originalJson = res.json.bind(res);

    res.json = ((body: any) => {
      // Store once the response is ready.
      const stored: StoredIdempotency = {
        payloadHash: currentPayloadHash,
        result: {
          statusCode: res.statusCode,
          body,
        },
      };

      store.set({
        key: scopedKey,
        payloadHash: currentPayloadHash,
        result: stored,
        createdAt: new Date(),
      });

      return originalJson(body);
    }) as any;

    next();
  };
}

