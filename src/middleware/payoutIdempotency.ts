import type { NextFunction, Request, Response } from 'express';
import { createHash } from 'crypto';
import { computeIdempotencyFingerprint } from '../utils/idempotencyFingerprint';
import {
  ContractIdempotencyStore,
  InMemoryContractIdempotencyStore,
  CONTRACT_IDEMPOTENCY_DEFAULT_TTL_MS,
} from './contractIdempotencyStore';

export const IDEMPOTENCY_KEY_MAX_LENGTH = 255;
export const PAYOUT_IDEMPOTENCY_TTL_MS = CONTRACT_IDEMPOTENCY_DEFAULT_TTL_MS;

export interface PayoutIdempotencyMiddlewareOptions {
  store?: ContractIdempotencyStore;
  ttlMs?: number;
}

export const payoutIdempotencyStore: ContractIdempotencyStore =
  new InMemoryContractIdempotencyStore({ ttlMs: PAYOUT_IDEMPOTENCY_TTL_MS });

function requestIdFrom(res: Response): string {
  return typeof res.locals.requestId === "string"
    ? res.locals.requestId
    : "unknown";
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
  const raw = req.originalUrl || req.url || "";
  return raw.split("?")[0] || "/";
}

function buildPayoutScopeKey(
  method: string,
  path: string,
  tenantId: string,
  milestoneId: string,
  idempotencyKey: string,
): string {
  return createHash("sha256")
    .update(`${method}:${path}:${tenantId}:${milestoneId}:${idempotencyKey}`)
    .digest("hex");
}

function normalizeSendBody(body: unknown): unknown {
  if (typeof body !== "string") {
    return body;
  }
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

export function createPayoutIdempotencyMiddleware(
  options: PayoutIdempotencyMiddlewareOptions = {},
): (req: Request, res: Response, next: NextFunction) => void {
  const store = options.store ?? payoutIdempotencyStore;
  const ttlMs = options.ttlMs ?? PAYOUT_IDEMPOTENCY_TTL_MS;

  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.headers["idempotency-key"];

    if (header === undefined) {
      next();
      return;
    }

    if (
      typeof header !== "string" ||
      header.trim().length === 0 ||
      header.length > IDEMPOTENCY_KEY_MAX_LENGTH
    ) {
      sendError(
        res,
        400,
        "invalid_idempotency_key",
        `Idempotency-Key must be a non-empty string of at most ${IDEMPOTENCY_KEY_MAX_LENGTH} characters.`
      );
      return;
    }

    const tenantId = resolveTenantId(req);
    if (tenantId === undefined) {
      sendError(res, 401, "unauthorized", "Authentication required.");
      return;
    }

    const milestoneId = req.params.milestoneId;
    if (!milestoneId) {
      sendError(res, 400, "invalid_milestone_id", "milestoneId parameter is required.");
      return;
    }

    const idempotencyKey = header.trim();
    const method = req.method;
    const path = resolvePath(req);
    const scopeKey = buildPayoutScopeKey(method, path, tenantId, milestoneId, idempotencyKey);
    const fingerprint = computeIdempotencyFingerprint({
      method,
      path,
      tenantId,
      body: req.body,
    });

    const result = store.reserve(scopeKey, fingerprint, ttlMs);

    switch (result.kind) {
      case "replay": {
        res.setHeader("Idempotency-Replayed", "true");
        res.status(result.record.statusCode);
        res.json(result.record.body);
        return;
      }
      case "conflict":
        sendError(
          res,
          409,
          "idempotency_conflict",
          "Idempotency-Key was already used with a different request body.",
        );
        return;
      case "in_progress":
        sendError(
          res,
          409,
          "request_in_progress",
          "A request with this Idempotency-Key is already being processed.",
        );
        return;
      case "reserved":
        break;
    }

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
    }) as Response["json"];

    res.send = ((body: unknown) => {
      finish(normalizeSendBody(body));
      return originalSend(body);
    }) as Response["send"];

    next();
  };
}

export const payoutIdempotencyMiddleware = createPayoutIdempotencyMiddleware;

