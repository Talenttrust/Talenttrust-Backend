import { createHash, timingSafeEqual } from 'crypto';
import { Counter, Gauge } from 'prom-client';
import { defaultIdempotencyStore, IdempotencyStore } from '../db/idempotencyStore';
import { redact, redactPayloadForLog } from './redact';
import { IdempotentEventResult, JsonValue } from './types';

export const activeIdempotencyKeys = new Gauge({
  name: 'event_idempotency_active_keys',
  help: 'Number of active idempotency keys currently tracked',
});

export const idempotencyEvictions = new Counter({
  name: 'event_idempotency_evictions_total',
  help: 'Total number of idempotency keys evicted due to TTL expiration',
});

export class IdempotencyConflictError extends Error {
  readonly statusCode = 409;
  readonly code = 'IDEMPOTENCY_PAYLOAD_CONFLICT';

  constructor(readonly idempotencyKey: string) {
    super('Idempotency key was already used with a different event payload.');
    this.name = 'IdempotencyConflictError';
  }
}

type Logger = Pick<Console, 'warn'>;

interface RunOptions {
  store?: IdempotencyStore;
  logger?: Logger;
}

/**
 * Computes a stable SHA-256 hash for a JSON event payload.
 *
 * @param payload - JSON-compatible event payload to fingerprint.
 * @returns Hex-encoded SHA-256 digest of the canonical payload.
 */
export function hashEventPayload(payload: JsonValue): string {
  return createHash('sha256').update(canonicalize(payload)).digest('hex');
}

/**
 * Executes event work once per idempotency key and rejects conflicting replays.
 *
 * @param key - Client or upstream supplied idempotency key.
 * @param payload - Event payload used to bind the key to a stable hash.
 * @param handler - Work to run on the first write path.
 * @param options - Optional store and logger overrides for tests or adapters.
 * @returns The handler result, replay flag, and payload hash.
 *
 * @throws IdempotencyConflictError when a reused key has a different payload
 * hash. The error is safe to translate to HTTP 409 Conflict.
 */
export async function runIdempotentEvent<TResult>(
  key: string,
  payload: JsonValue,
  handler: () => TResult | Promise<TResult>,
  options: RunOptions = {},
): Promise<IdempotentEventResult<TResult>> {
  const normalizedKey = key.trim();

  if (normalizedKey.length === 0) {
    throw new TypeError('Idempotency key is required.');
  }

  const store = options.store ?? defaultIdempotencyStore;
  const payloadHash = hashEventPayload(payload);
  const existing = store.getRaw ? store.getRaw<TResult>(normalizedKey) : store.get<TResult>(normalizedKey);

  if (existing) {
    if (existing.expiresAt && existing.expiresAt.getTime() <= Date.now()) {
      idempotencyEvictions.inc();
      if (store.delete) {
        store.delete(normalizedKey);
      }
      // Proceed as brand-new ingestion
    } else {
      if (constantTimeEqual(existing.payloadHash, payloadHash)) {
        return {
          result: existing.result,
          replayed: true,
          payloadHash,
        };
      }

      options.logger?.warn(
        'Rejected conflicting event idempotency replay',
        redact({
          idempotencyKey: normalizedKey,
          storedPayloadHash: existing.payloadHash,
          receivedPayloadHash: payloadHash,
          receivedPayload: redactPayloadForLog(payload),
        }),
      );

      throw new IdempotencyConflictError(normalizedKey);
    }
  }

  const result = await handler();

  const ttlMs = 24 * 60 * 60 * 1000; // 24 hours
  store.set({
    key: normalizedKey,
    payloadHash,
    result,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + ttlMs),
  });

  if (store.size) {
    activeIdempotencyKeys.set(store.size());
  }

  return {
    result,
    replayed: false,
    payloadHash,
  };
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

// Simple IdempotencyLayer facade used by DLQ replay endpoints and tests.
// Implemented as an in-memory set of processed event IDs. Tests may mock
// these methods as needed.
export const IdempotencyLayer = (() => {
  const processed = new Set<string>();

  return {
    async isEventProcessed(eventId: string): Promise<boolean> {
      return processed.has(eventId);
    },

    async markEventProcessed(eventId: string): Promise<void> {
      processed.add(eventId);
    },

    // Expose a clear method for tests
    async _clear(): Promise<void> {
      processed.clear();
    },
  };
})();
