import { createHash } from 'crypto';
import type { AuditEntry, CreateAuditEntryInput } from './types';
import { validateCreateAuditEntryInput } from './inputValidation';

export interface IdempotencyRecord {
  bodyHash: string;
  response: AuditEntry;
  createdAt: number;
}

export interface IdempotencyStoreOptions {
  maxSize?: number;
  ttlMs?: number;
}

const DEFAULT_MAX_SIZE = 1000;
const DEFAULT_TTL_MS = 86_400_000;
const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

export class IdempotencyConflictError extends Error {
  constructor() {
    super('Idempotency key is already associated with different audit input');
    this.name = 'IdempotencyConflictError';
  }
}

function validateKey(key: string): void {
  if (
    typeof key !== 'string' ||
    key.length === 0 ||
    key.length > MAX_IDEMPOTENCY_KEY_LENGTH ||
    /^\s+$/.test(key) ||
    /[\u0000-\u001F\u007F-\u009F]/.test(key)
  ) {
    throw new TypeError(`Idempotency key must be 1-${MAX_IDEMPOTENCY_KEY_LENGTH} non-control characters`);
  }
}

function validateInput(input: CreateAuditEntryInput): CreateAuditEntryInput {
  const result = validateCreateAuditEntryInput(input);
  if (!result.ok) {
    throw new TypeError('Invalid audit idempotency input');
  }
  return result.data;
}

function snapshotResponse(response: AuditEntry): AuditEntry {
  if (response === null || typeof response !== 'object' || Array.isArray(response)) {
    throw new TypeError('Invalid audit idempotency response');
  }

  for (const field of ['id', 'timestamp', 'hash', 'previousHash'] as const) {
    if (typeof response[field] !== 'string' || response[field].length === 0) {
      throw new TypeError('Invalid audit idempotency response');
    }
  }

  const input = validateInput({
    action: response.action,
    severity: response.severity,
    actor: response.actor,
    resource: response.resource,
    resourceId: response.resourceId,
    metadata: response.metadata,
    ...(response.ipAddress !== undefined && { ipAddress: response.ipAddress }),
    ...(response.correlationId !== undefined && { correlationId: response.correlationId }),
  });

  return {
    id: response.id,
    timestamp: response.timestamp,
    action: input.action,
    severity: input.severity,
    actor: input.actor,
    resource: input.resource,
    resourceId: input.resourceId,
    metadata: JSON.parse(canonicalize(input.metadata)) as Record<string, unknown>,
    ipAddress: input.ipAddress,
    correlationId: input.correlationId,
    previousHash: response.previousHash,
    hash: response.hash,
  };
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new TypeError('Audit idempotency input is not serializable');
    }
    return serialized;
  }

  if (Array.isArray(value)) {
    if (
      Object.getPrototypeOf(value) !== Array.prototype ||
      Object.getOwnPropertySymbols(value).length > 0 ||
      Array.from({ length: value.length }, (_, index) => index).some(
        (index) => !Object.prototype.hasOwnProperty.call(value, index),
      )
    ) {
      throw new TypeError('Audit idempotency input is not serializable');
    }
    return `[${value.map(canonicalize).join(',')}]`;
  }

  // Class instances can serialize differently while exposing no enumerable keys.
  const object = value as Record<string, unknown>;
  const prototype = Object.getPrototypeOf(object);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    Object.getOwnPropertySymbols(object).length > 0
  ) {
    throw new TypeError('Audit idempotency input is not serializable');
  }
  const keys = Object.keys(object).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(object[key])}`).join(',')}}`;
}

function hashBody(input: CreateAuditEntryInput): string {
  const validated = validateInput(input);
  const payload = canonicalize({
    action: validated.action,
    severity: validated.severity,
    actor: validated.actor,
    resource: validated.resource,
    resourceId: validated.resourceId,
    metadata: validated.metadata,
  });
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

export class IdempotencyStore {
  private readonly store = new Map<string, IdempotencyRecord>();
  private readonly maxSize: number;
  private readonly ttlMs: number;

  constructor(options: IdempotencyStoreOptions = {}) {
    this.maxSize = options.maxSize ?? DEFAULT_MAX_SIZE;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;

    if (!Number.isSafeInteger(this.maxSize) || this.maxSize <= 0) {
      throw new RangeError('maxSize must be a positive safe integer');
    }
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs <= 0) {
      throw new RangeError('ttlMs must be a positive safe integer');
    }
  }

  get(key: string): IdempotencyRecord | undefined {
    validateKey(key);
    const record = this.store.get(key);
    if (!record) {
      return undefined;
    }

    if (Date.now() - record.createdAt >= this.ttlMs) {
      this.store.delete(key);
      return undefined;
    }

    return {
      bodyHash: record.bodyHash,
      response: snapshotResponse(record.response),
      createdAt: record.createdAt,
    };
  }

  set(key: string, input: CreateAuditEntryInput, response: AuditEntry): void {
    validateKey(key);
    const bodyHash = hashBody(input);
    this.evictExpired();

    // A live key is write-once: matching retries preserve the first response.
    const existing = this.store.get(key);
    if (existing) {
      if (existing.bodyHash !== bodyHash) {
        throw new IdempotencyConflictError();
      }
      return;
    }

    const responseSnapshot = snapshotResponse(response);

    if (this.store.size >= this.maxSize) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey) {
        this.store.delete(oldestKey);
      }
    }

    this.store.set(key, {
      bodyHash,
      response: responseSnapshot,
      createdAt: Date.now(),
    });
  }

  delete(key: string): void {
    validateKey(key);
    this.store.delete(key);
  }

  size(): number {
    this.evictExpired();
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [key, record] of this.store) {
      if (now - record.createdAt >= this.ttlMs) {
        this.store.delete(key);
      }
    }
  }
}

export function hashIdempotencyInput(input: CreateAuditEntryInput): string {
  return hashBody(input);
}

export const idempotencyStore = new IdempotencyStore();
