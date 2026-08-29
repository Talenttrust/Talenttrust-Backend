import { createHash } from 'crypto';
import type { NextFunction, Request, Response } from 'express';

import {
  InMemoryIdempotencyStore,
  type IdempotencyStore,
} from '../db/idempotencyStore';

interface StoredResponse {
  statusCode: number;
  body: unknown;
}

export interface ReputationIdempotencyOptions {
  store?: IdempotencyStore;
}

export const reputationIdempotencyStore = new InMemoryIdempotencyStore({
  ttlMs: 60 * 60 * 1000,
  maxSize: 10_000,
});

function stableJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;

  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map(key => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(',')}}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function requestId(res: Response): string {
  return typeof res.locals.requestId === 'string' ? res.locals.requestId : 'unknown';
}

function userId(req: Request): string | undefined {
  const user = (req as Request & {
    user?: { id?: string; userId?: string; sub?: string };
  }).user;
  return user?.id ?? user?.userId ?? user?.sub;
}

function sendError(
  res: Response,
  status: number,
  code: string,
  message: string,
): Response {
  return res.status(status).json({
    error: { code, message, requestId: requestId(res) },
  });
}

/**
 * Adds optional, user-scoped idempotency to reputation write endpoints.
 * Stored records are bounded and expire through the injected store.
 */
export function createReputationIdempotencyMiddleware(
  options: ReputationIdempotencyOptions = {},
) {
  const store = options.store ?? reputationIdempotencyStore;

  return (req: Request, res: Response, next: NextFunction): void | Response => {
    const header = req.headers['idempotency-key'];
    if (header === undefined) {
      next();
      return;
    }
    if (typeof header !== 'string' || header.trim().length === 0 || header.length > 255) {
      return sendError(
        res,
        400,
        'invalid_idempotency_key',
        'Idempotency-Key must be a non-empty string of at most 255 characters.',
      );
    }

    const callerId = userId(req);
    if (!callerId) {
      return sendError(res, 401, 'unauthorized', 'Authentication required.');
    }

    const path = req.originalUrl.split('?')[0];
    const scopedKey = sha256(`${callerId}:${req.method}:${path}:${header.trim()}`);
    const payloadHash = sha256(stableJson(req.body ?? {}));
    const existing = store.get<StoredResponse>(scopedKey);

    if (existing) {
      if (existing.payloadHash !== payloadHash) {
        return sendError(
          res,
          409,
          'idempotency_payload_conflict',
          'Idempotency-Key was already used with a different request payload.',
        );
      }

      res.setHeader('Idempotency-Replayed', 'true');
      res.status(existing.result.statusCode).json(existing.result.body);
      return;
    }

    const originalJson = res.json.bind(res);
    res.json = ((body: unknown) => {
      store.set({
        key: scopedKey,
        payloadHash,
        result: { statusCode: res.statusCode, body },
        createdAt: new Date(),
      });
      return originalJson(body);
    }) as Response['json'];

    next();
  };
}

export const reputationIdempotencyMiddleware =
  createReputationIdempotencyMiddleware();
