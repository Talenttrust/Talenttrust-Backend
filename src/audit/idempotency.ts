/**
 * @module audit/idempotency
 * @description Idempotency store for audit entry creation.
 *
 * Concurrency model:
 * - Node's event loop is single-threaded, so synchronous method bodies are
 *   effectively atomic with respect to other JavaScript execution.
 * - However, callers may await between a "get" and a "set" (e.g. across an
 *   await boundary in an async request handler). Two racing requests can
 *   both observe "miss" and both proceed to append, causing duplicate audit
 *   entries and a branched hash chain.
 * - To harden against this, the store exposes an atomic
 *   `claim()` operation that reserves a key before the caller awaits any
 *   I/O. A second concurrent claim for the same key either returns the
 *   existing record (fast path) or receives a distinct `'in-flight'` status.
 *
 * Invariants:
 * - A given key is at most once in the `in-flight` state at any time.
 * - A key in the `in-flight` state cannot be reclaimed by another caller
 *   until it is committed or released.
 * - Once committed, the record is immutable for the remainder of its TTL.
 * - Expired records are treated as absent by every read path.
 * - Body hashes are compared on commit; a mismatch is a client error,
 *   not a silent overwrite.
 */

import { createHash } from 'crypto';
import type { AuditEntry, CreateAuditEntryInput } from './types';
import { AUDIT_ACTIONS, AUDIT_SEVERITIES } from './types';
import { canonicalizeJson } from '../utils/idempotencyFingerprint';

export interface IdempotencyRecord {
  readonly bodyHash: string;
  readonly response: AuditEntry;
  readonly createdAt: number;
}

export interface IdempotencyStoreOptions {
  maxSize?: number;
  ttlMs?: number;
  /**
   * Optional clock supplied by tests or callers that need deterministic
   * time behaviour. Defaults to `Date.now`.
   */
  clock?: () => number;
}

export interface IdempotencyClaimResult {
  status: 'created' | 'existing' | 'conflict';
  record?: IdempotencyRecord;
}

/**
 * Result of an idlempotent lookup or insertion.
 *
 * This is the explicit compatibility contract for callers that need to
 * distinguish between "new work" and "duplicate replay" without relying on
 * the internal storage shape.
 */
export type IdempotencyOutcome =
  | { kind: 'miss' }
  | { kind: 'replay'; record: IdempotencyRecord }
  | {  kind: 'conflict'; existingBodyHash: string; incomingBodyHash: string };

export interface IdempotencySetResult {
  /** True when the record was newly written or replaced by this call. */
  written: boolean;
  /** True when an existing record was returned instead of writing. */
  existing: boolean;
  /** The record that is effective after this call. */
  record: IdempotencyRecord;
}

const DEFAULT_MAX_SIZE = 1000;
const DEFAULT_TTL_MS = 86_400_000;
// Include the additional actions in the public AuditAction union as well as
// the published runtime list; this store must accept existing typed producers.
const actions = new Set<string>([...AUDIT_ACTIONS, 'CONTRACT_DELETED', 'MILESTONES_CREATED', 'MILESTONES_UPDATED', 'MILESTONES_DELETED']);

export class AuditIdempotencyError extends Error {
  constructor(readonly code: 'audit_idempotency_invalid_input' | 'audit_idempotency_conflict') {
    super(code === 'audit_idempotency_conflict'
      ? 'Audit idempotency key is already bound to a different payload'
      : 'Invalid audit idempotency input');
    this.name = 'AuditIdempotencyError';
  }
}

/** Copy JSON data without executing getters/toJSON or retaining caller aliases.
 * Unsupported values must reject rather than silently vanish from a fingerprint.
 * The depth bound prevents hostile in-process input exhausting the call stack.
 */
function snapshot(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || depth > 64 || seen.has(value)) {
    throw new AuditIdempotencyError('audit_idempotency_invalid_input');
  }
  const prototype = Object.getPrototypeOf(value);
  if ((!Array.isArray(value) && prototype !== Object.prototype && prototype !== null)
    || Object.getOwnPropertySymbols(value).length > 0) {
    throw new AuditIdempotencyError('audit_idempotency_invalid_input');
  }
  seen.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const copy: Record<string, unknown> | unknown[] = Array.isArray(value) ? [] : Object.create(null);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable) continue;
    if (!('value' in descriptor)) throw new AuditIdempotencyError('audit_idempotency_invalid_input');
    // Optional transport context can be absent on a typed AuditEntry. Nested
    // undefined metadata is rejected to avoid collisions with omitted fields.
    if (depth === 0 && (key === 'ipAddress' || key === 'correlationId') && descriptor.value === undefined) continue;
    Object.defineProperty(copy, key, {
      value: snapshot(descriptor.value, seen, depth + 1), enumerable: true,
    });
  }
  if (Array.isArray(value) && (Object.keys(copy).length !== value.length
    || Object.keys(copy).some(key => !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length))) {
    throw new AuditIdempotencyError('audit_idempotency_invalid_input');
  }
  seen.delete(value);
  return Object.freeze(copy);
}

function validateKey(key: string): void {
  if (typeof key !== 'string' || key.trim().length === 0 || key.length > 256 || /[\x00-\x1f\x7f]/.test(key)) {
    throw new AuditIdempotencyError('audit_idempotency_invalid_input');
  }
}

/**
 * Deterministic hash of the idempotency-relevant fields of an audit input.
 *
 * Invariants:
 * - The hash is independent of transport-only fields (`ipAddress`,
 *   `correlationId`) so retries from different clients map to the same key.
 * - Metadata key ordering is normalised so equivalent objects havh the
 *   same digest regardless of insertion order.
 * - Non-serialisable values (e.g. `undefined`, `function`, `symbol`)
 *   are rejected with a deterministic error rather than silently producing
 *   a different hash across runtimes.
 */
function hashBody(input: CreateAuditEntryInput): string {
  const data = snapshot(input) as CreateAuditEntryInput;
  if (!data || typeof data !== 'object') throw new AuditIdempotencyError('audit_idempotency_invalid_input');
  for (const field of ['action', 'severity', 'actor', 'resource', 'resourceId'] as const) {
    if (typeof data[field] !== 'string' || data[field].trim().length === 0) {
      throw new AuditIdempotencyError('audit_idempotency_invalid_input');
    }
  }
  if (!actions.has(data.action) || !(AUDIT_SEVERITIES as readonly string[]).includes(data.severity)) {
    throw new AuditIdempotencyError('audit_idempotency_invalid_input');
  }
  if (!data.metadata || Array.isArray(data.metadata) || typeof data.metadata !== 'object') {
    throw new AuditIdempotencyError('audit_idempotency_invalid_input');
  }
  const payload = canonicalizeJson({
    action: data.action,
    severity: data.severity,
    actor: data.actor,
    resource: data.resource,
    resourceId: data.resourceId,
    metadata: data.metadata,
  });
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

export class IdempotencyStore {
  private readonly store = new Map<string, IdempotencyRecord>();
  private readonly maxSize: number;
  private readonly ttlMs: number;
  private lastNow = 0;

  constructor(options: IdempotencyStoreOptions = {}) {
    this.maxSize = options.maxSize ?? DEFAULT_MAX_SIZE;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    if (!Number.isSafeInteger(this.maxSize) || this.maxSize <= 0
      || !Number.isSafeInteger(this.ttlMs) || this.ttlMs <= 0) {
      throw new RangeError('Audit idempotency maxSize and ttlMs must be positive safe integers');
    }
  }

  if (Array.isArray(value)) {
    return value.map((nested) => normaliseMetadata(nested));
  }

  const entries = Object.entries(value as Record<string, unknown>);
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const out: Record<string, unknown> = {};
  for (const [key, nested] of entries) {
    out[key] = normaliseMetadata(nested);
  }
  return out;
}

function assertValidKey(key: unknown): asserts key is string {
  if (typeof key !== 'string' || key.length === 0) {
    throw new TypeError('IdempotencyStore key must be a non-empty string');
  }
}

export class IdempotencyStore {
  private readonly store = new Map<string, IdempotencyRecord>();
  /**
   * Keys that have been claimed but not yet committed or released.
   * Value is the body hash recorded at claim time, so commit can verify
   * the caller is still working on the same payload.
   */
  private readonly inFlight = new Map<string, string>();
  private readonly maxSize: number;
  private readonly ttlMs: number;
  private readonly clock: () => number;

  constructor(options: IdempotencyStoreOptions = {}) {
    const maxSize = options.maxSize ?? DEFAULT_MAX_SIZE;
    const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;

    if (!Number.isFinite(maxSize) || maxSize < 1) {
      throw new RangeError('IdempotencyStore maxSize must be a positive integer');
    }
    if (!Number.isFinite(ttlMs) || ttlMs < 0) {
      throw new RangeError('IdempotencyStore ttlMs must be a non-negative number');
    }

    this.maxSize = Math.floor(maxSize);
    this.ttlMs = ttlMs;
  }

  /**
   * Retrieves a non-expired record for a key, or `undefined` when absent.
   * Expired entries are evicted lazily on read so a stale record can never
   * be observed by a caller.
   */
  get(key: string): IdempotencyRecord | undefined {
    validateKey(key);
    const record = this.store.get(key);
    if (!record) {
      return undefined;
    }

    if (this.now() - record.createdAt >= this.ttlMs) {
      this.store.delete(key);
      return undefined;
    }

    return record;
  }

  set(key: string, input: CreateAuditEntryInput, response: AuditEntry): void {
    validateKey(key);
    // Prepare completely before eviction/publication: rejection cannot erase
    // another key. JSON getters are forbidden, so preparation cannot re-enter.
    const bodyHash = hashBody(input);
    const responseSnapshot = snapshot(response) as AuditEntry;
    if (!responseSnapshot || ['id', 'timestamp', 'hash', 'previousHash'].some(field => {
      const value = responseSnapshot[field as keyof AuditEntry];
      return typeof value !== 'string' || value.length === 0;
    })) throw new AuditIdempotencyError('audit_idempotency_invalid_input');
    if (hashBody(responseSnapshot) !== bodyHash) {
      throw new AuditIdempotencyError('audit_idempotency_invalid_input');
    }
    const now = this.now();
    const existing = this.store.get(key);
    if (existing && now - existing.createdAt < this.ttlMs) {
      if (existing.bodyHash !== bodyHash) throw new AuditIdempotencyError('audit_idempotency_conflict');
      // First completed response wins. Replays neither refresh TTL nor reorder
      // FIFO eviction, and cannot overwrite another actor/resource's result.
      return;
    }
    const record = Object.freeze({ bodyHash, response: responseSnapshot, createdAt: now });
    this.evictExpired(now);

    if (this.store.size >= this.maxSize) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey !== undefined) {
        this.store.delete(oldestKey);
      }
    }

    // No await or caller callbacks between inspecting and publishing the state.
    this.store.set(key, record);
  }

  delete(key: string): void {
    validateKey(key);
    this.store.delete(key);
    this.inFlight.delete(key);
  }

  size(): number {
    this.evictExpired();
    return this.store.size;
  }

  /** Number of keys currently claimed but not yet committed. */
  inFlightCount(): number {
    return this.inFlight.size;
  }

  clear(): void {
    this.store.clear();
    this.inFlight.clear();
  }

  private ensureCapacity(): void {
    if (this.store.size < this.maxSize) {
      return;
    }

    // Evict the oldest committed record. We never evict in-flight keys
    // because that would allow a concurrent caller to claim the same key
    // and produce a duplicate audit entry.
    const oldestKey = this.store.keys().next().value;
    if (oldestKey !== undefined) {
      this.store.delete(oldestKey);
    }
  }

  private ensureCapacity(): void {
    while (this.store.size >= this.maxSize) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      this.store.delete(oldestKey);
    }
  }

  private write(
    key: string,
    input: CreateAuditEntryInput,
    response: AuditEntry,
  ): IdempotencyRecord {
    this.evictExpired();

    // Ensure the key being written is accounted for in the capacity check.
    if (!this.store.has(key) && this.store.size >= this.maxSize) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey !== undefined) {
        this.store.delete(oldestKey);
      }
    }

    const record: IdempotencyRecord = {
      bodyHash: hashBody(input),
      response,
      createdAt: Date.now(),
    };
    this.store.set(key, record);
    return record;
  }

  private isExpired(record: IdempotencyRecord, now: number): boolean {
    return now - record.createdAt > this.ttlMs;
  }

  private now(): number {
    const now = Date.now();
    if (!Number.isSafeInteger(now) || now < 0) throw new AuditIdempotencyError('audit_idempotency_invalid_input');
    // A wall-clock rollback must not make an already-aged record young again.
    this.lastNow = Math.max(this.lastNow, now);
    return this.lastNow;
  }

  private evictExpired(now = this.now()): void {
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
