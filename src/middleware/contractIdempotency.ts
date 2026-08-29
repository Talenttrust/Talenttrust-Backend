import type { NextFunction, Request, Response } from 'express';
import { createHash } from 'crypto';
import { computeIdempotencyFingerprint } from '../utils/idempotencyFingerprint';
import {
  ContractIdempotencyStore,
  InMemoryContractIdempotencyStore,
  CONTRACT_IDEMPOTENCY_DEFAULT_TTL_MS,
} from './contractIdempotencyStore';

/**
 * @module middleware/contractIdempotency
 * @description Optional Idempotency-Key support for `POST /api/v1/contracts`.
 *
 * Why idempotency exists
 * ----------------------
 * `POST /api/v1/contracts` triggers the "milestone release" side effect
 * (persisting a contract and preparing the Soroban escrow). A network retry
 * must not release that milestone twice, so clients may attach an
 * `Idempotency-Key` header and safely retry.
 *
 * Concurrency
 * -----------
 * A request reservation is made atomically via
 * {@link ContractIdempotencyStore.reserve} — a single synchronous
 * check-and-insert with no `await` in between. Exactly one concurrent request
 * may execute; overlapping requests with the same key + fingerprint receive
 * `409 request_in_progress`.
 *
 * Behaviour
 * ---------
 * - No header → pass through unchanged (idempotency is optional).
 * - First request → execute, then persist `{ fingerprint, statusCode, body }`.
 * - Same key + same fingerprint → replay the stored status and body verbatim.
 * - Same key + different fingerprint → `409 idempotency_conflict`.
 * - Concurrent same key + same fingerprint → `409 request_in_progress`.
 * - Records expire after 24 hours (TTL), after which the key is treated as new.
 */

/** Maximum accepted Idempotency-Key length (rejected keys are never truncated). */
export const IDEMPOTENCY_KEY_MAX_LENGTH = 255;

/** Contract idempotency record lifetime: exactly 24 hours. */
export const CONTRACT_IDEMPOTENCY_TTL_MS = CONTRACT_IDEMPOTENCY_DEFAULT_TTL_MS;

export interface ContractIdempotencyMiddlewareOptions {
  store?: ContractIdempotencyStore;
  /**
   * Record lifetime override. Production always uses 24h; exposed so tests can
   * exercise expiry deterministically without real wall-clock time.
   */
  ttlMs?: number;
}

/**
 * Shared in-memory store for contract idempotency records.
 *
 * Intentionally in-memory only (issue #1189). The {@link ContractIdempotencyStore}
 * interface keeps the design replaceable with a distributed implementation
 * (e.g. Redis `SET NX`) later without changing the middleware.
 */
export const contractIdempotencyStore: ContractIdempotencyStore =
  new InMemoryContractIdempotencyStore({ ttlMs: CONTRACT_IDEMPOTENCY_TTL_MS });

function requestIdFrom(res: Response): string {
  return typeof res.locals.requestId === 'string'
    ? res.locals.requestId
    : 'unknown';
}

function sendError(
  res: Response,
  status: number,
  code: string,
  message: string,
): Response {
  return res.status(status).json({
    error: {
      code,
      message,
      requestId: requestIdFrom(res),
    },
  });
}

function resolveTenantId(req: Request): string | undefined {
  const user = (
    req as Request & {
      user?: { id?: string; userId?: string; sub?: string };
    }
  ).user;
  return user?.id ?? user?.userId ?? user?.sub;
}

function resolvePath(req: Request): string {
  const raw = req.originalUrl || req.url || '';
  return raw.split('?')[0] || '/';
}

/**
 * Builds the store key from the tenant scope + method + path + idempotency key.
 * The idempotency key is never used as the sole store key: two tenants (users)
 * can independently use the same key.
 */
function buildScopeKey(
  method: string,
  path: string,
  tenantId: string,
  idempotencyKey: string,
): string {
  return createHash('sha256')
    .update(`${tenantId}:${method}:${path}:${idempotencyKey}`)
    .digest('hex');
}

/** Normalizes a `res.send` body (which may be a JSON string) for storage. */
function normalizeSendBody(body: unknown): unknown {
  if (typeof body !== 'string') {
    return body;
  }
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

export function createContractIdempotencyMiddleware(
  options: ContractIdempotencyMiddlewareOptions = {},
): (req: Request, res: Response, next: NextFunction) => void {
  const store = options.store ?? contractIdempotencyStore;
  const ttlMs = options.ttlMs ?? CONTRACT_IDEMPOTENCY_TTL_MS;

  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.headers['idempotency-key'];

    // No header → idempotency is optional: do not touch the store and do not
    // compute a fingerprint. The existing request flow is preserved exactly.
    if (header === undefined) {
      next();
      return;
    }

    if (
      typeof header !== 'string' ||
      header.trim().length === 0 ||
      header.length > IDEMPOTENCY_KEY_MAX_LENGTH
    ) {
      sendError(
        res,
        400,
        'invalid_idempotency_key',
        `Idempotency-Key must be a non-empty string of at most ${IDEMPOTENCY_KEY_MAX_LENGTH} characters.`,
      );
      return;
    }

    const tenantId = resolveTenantId(req);
    if (tenantId === undefined) {
      sendError(res, 401, 'unauthorized', 'Authentication required.');
      return;
    }

    const idempotencyKey = header.trim();
    const method = req.method;
    const path = resolvePath(req);
    const scopeKey = buildScopeKey(method, path, tenantId, idempotencyKey);
    const fingerprint = computeIdempotencyFingerprint({
      method,
      path,
      tenantId,
      body: req.body,
    });

    const result = store.reserve(scopeKey, fingerprint, ttlMs);

    switch (result.kind) {
      case 'replay': {
        res.setHeader('Idempotency-Replayed', 'true');
        res.status(result.record.statusCode);
        res.json(result.record.body);
        return;
      }
      case 'conflict':
        sendError(
          res,
          409,
          'idempotency_conflict',
          'Idempotency-Key was already used with a different request body.',
        );
        return;
      case 'in_progress':
        sendError(
          res,
          409,
          'request_in_progress',
          'A request with this Idempotency-Key is already being processed.',
        );
        return;
      case 'reserved':
        break;
    }

    // Capture the terminal response exactly once. Successful (2xx) responses
    // are persisted for replay; non-2xx responses release the reservation so a
    // retry can re-attempt rather than replaying a transient failure.
    let finished = false;
    const finish = (body: unknown): void => {
      if (finished) {
        return;
      }
      finished = true;
      if (res.statusCode >= 200 && res.statusCode < 300) {
        store.complete(scopeKey, fingerprint, res.statusCode, body, ttlMs);
      } else {
        store.release(scopeKey, fingerprint);
      }
    };

    const originalJson = res.json.bind(res);
    const originalSend = res.send.bind(res);

    res.json = ((body: unknown) => {
      finish(body);
      return originalJson(body);
    }) as Response['json'];

    res.send = ((body: unknown) => {
      finish(normalizeSendBody(body));
      return originalSend(body);
    }) as Response['send'];

    next();
  };
}

/** Backwards-compatible no-arg factory used by the contracts router. */
export const contractCreateIdempotencyMiddleware =
  createContractIdempotencyMiddleware;
