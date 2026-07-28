import { Request, Response, NextFunction } from 'express';
import { createHash, timingSafeEqual } from 'crypto';
import {
  defaultIdempotencyStore,
  IdempotencyStore,
} from '../db/idempotencyStore';
import { JsonValue } from '../events/types';

const IDEMPOTENCY_PAYLOAD_CONFLICT = 'idempotency_payload_conflict';

interface IdempotencyMiddlewareOptions {
  store?: IdempotencyStore;
  inFlight?: Map<string, string>;
}

function requestIdFrom(res: Response): string {
  return typeof res.locals.requestId === 'string' ? res.locals.requestId : 'unknown';
}

function hashRequestPayload(body: unknown): string {
  return hashJsonValue(normalizeRequestBody(body));
}

function normalizeRequestBody(body: unknown): JsonValue {
  if (body === undefined || body === null) {
    return {};
  }

  return body as JsonValue;
}

function hashJsonValue(value: JsonValue): string {
  return createHash('sha256').update(canonicalize(value)).digest('hex');
}

function canonicalize(value: JsonValue): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(',')}]`;
  }

  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`).join(',')}}`;
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'hex');
  const rightBuffer = Buffer.from(right, 'hex');

  if (leftBuffer.length !== rightBuffer.length) {
    timingSafeEqual(leftBuffer, leftBuffer);
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}

function conflictResponse(res: Response, message: string, code = 'conflict') {
  return res.status(409).json({
    error: {
      code,
      message,
      requestId: requestIdFrom(res),
    },
  });
}

/**
 * Creates middleware that deduplicates state-changing HTTP requests via Idempotency-Key.
 *
 * Requests without the header pass through unchanged. When the header is present,
 * identical retries replay the cached response; conflicting payloads receive HTTP 409.
 */
export function createIdempotencyMiddleware(options: IdempotencyMiddlewareOptions = {}) {
  const store = options.store ?? defaultIdempotencyStore;
  const inFlight = options.inFlight ?? defaultInFlight;

  return (req: Request, res: Response, next: NextFunction) => {
    const idempotencyKey = req.headers['idempotency-key'] as string | undefined;

    if (!idempotencyKey) {
      return next();
    }

    const payloadHash = hashRequestPayload(req.body);
    const existing = store.get(idempotencyKey);

    if (existing) {
      if (!constantTimeEqual(existing.payloadHash, payloadHash)) {
        return conflictResponse(
          res,
          'Idempotency key was already used with a different request payload.',
          IDEMPOTENCY_PAYLOAD_CONFLICT,
        );
      }

      return res.status(200).json({
        ...(existing.result as Record<string, unknown>),
        idempotencyHeader: 'replay-detected',
      });
    }

    const inFlightHash = inFlight.get(idempotencyKey);
    if (inFlightHash !== undefined) {
      if (!constantTimeEqual(inFlightHash, payloadHash)) {
        return conflictResponse(
          res,
          'Idempotency key was already used with a different request payload.',
          IDEMPOTENCY_PAYLOAD_CONFLICT,
        );
      }

      return conflictResponse(res, 'Request is already being processed');
    }

    inFlight.set(idempotencyKey, payloadHash);

    const originalSend = res.send.bind(res);
    res.send = function sendWithIdempotencyCache(body: unknown): Response {
      const result = typeof body === 'string' ? JSON.parse(body) : body;

      store.set({
        key: idempotencyKey,
        payloadHash,
        result,
        createdAt: new Date(),
      });
      inFlight.delete(idempotencyKey);

      return originalSend(body);
    };

    next();
  };
}

const defaultInFlight = new Map<string, string>();

export const idempotencyMiddleware = createIdempotencyMiddleware();

/**
 * Clears cached idempotency records and in-flight markers (for tests or maintenance).
 */
export function clearIdempotencyStore(store: IdempotencyStore = defaultIdempotencyStore) {
  store.clear();
  defaultInFlight.clear();
}
