/**
 * @module middleware/contractIdempotencyStore
 * @description Idempotency store for `POST /api/v1/contracts`.
 *
 * The store models the three conceptual states the endpoint needs:
 *
 *   - absent        → no record for this scope + key
 *   - in_progress   → a request has reserved the key and is still executing
 *   - completed     → the request finished; its response is replayable
 *
 * {@link reserve} performs the check-and-insert **atomically**. Because it is
 * a single synchronous operation on a `Map` with no `await` between the check
 * and the write, two overlapping Node requests can never both win a
 * reservation (Node runs JavaScript on a single thread). A distributed
 * implementation would replace this with an atomic `INSERT ... ON CONFLICT
 * DO NOTHING` (or an equivalent CAS), which is why the shape is an interface
 * rather than a concrete `Map`.
 */

/** A finished request whose response can be replayed. */
export interface CompletedIdempotencyRecord {
  fingerprint: string;
  statusCode: number;
  body: unknown;
  createdAt: number;
  expiresAt: number;
}

/** Internal state for a single scope + idempotency key. */
export interface IdempotencyEntry {
  state: 'in_progress' | 'completed';
  fingerprint: string;
  createdAt: number;
  expiresAt: number;
  /** Present only when {@link state} is `completed`. */
  record?: CompletedIdempotencyRecord;
}

/** Result of an atomic {@link ContractIdempotencyStore.reserve} call. */
export type ReserveResult =
  | { kind: 'reserved' } // this request owns the key; execute the side effect
  | { kind: 'replay'; record: CompletedIdempotencyRecord } // completed + same fingerprint
  | { kind: 'conflict' } // same key, different fingerprint (any state)
  | { kind: 'in_progress' }; // in_progress + same fingerprint

export interface ContractIdempotencyStore {
  /** Atomically reserve `scopeKey` for `fingerprint`, or report the existing state. */
  reserve(scopeKey: string, fingerprint: string, ttlMs: number): ReserveResult;
  /** Transition a reserved key to `completed`, capturing the response for replay. */
  complete(
    scopeKey: string,
    fingerprint: string,
    statusCode: number,
    body: unknown,
    ttlMs: number,
  ): void;
  /** Free an in-progress reservation (error path) so a retry can re-attempt. */
  release(scopeKey: string, fingerprint: string): void;
  /** Inspect a non-expired entry (lazy-expires on access). Primarily for tests. */
  get(scopeKey: string): IdempotencyEntry | undefined;
  delete(scopeKey: string): void;
  size(): number;
  clear(): void;
  /** Remove expired entries and return the count removed. */
  purgeExpired(now?: number): number;
}

export interface ContractIdempotencyStoreConfig {
  ttlMs?: number;
  clock?: () => number;
  maxSize?: number;
}

/** Default record lifetime for contract idempotency: exactly 24 hours. */
export const CONTRACT_IDEMPOTENCY_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

const DEFAULT_MAX_SIZE = 10_000;

/**
 * Deep-copies a JSON response body so later mutation of either the stored
 * record or the replayed object can never affect the other.
 */
function snapshot<T>(value: T): T {
  if (value === undefined || value === null) {
    return value;
  }
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    // Not JSON-serializable (should not happen for our JSON endpoints) —
    // fall back to the original reference rather than throwing mid-response.
    return value;
  }
}

function cloneRecord(
  record: CompletedIdempotencyRecord,
): CompletedIdempotencyRecord {
  return { ...record, body: snapshot(record.body) };
}

export class InMemoryContractIdempotencyStore
  implements ContractIdempotencyStore
{
  private readonly entries = new Map<string, IdempotencyEntry>();
  private readonly ttlMs: number;
  private readonly clock: () => number;
  private readonly maxSize: number;

  constructor(config: ContractIdempotencyStoreConfig = {}) {
    this.ttlMs = config.ttlMs ?? CONTRACT_IDEMPOTENCY_DEFAULT_TTL_MS;
    this.clock = config.clock ?? (() => Date.now());
    this.maxSize = config.maxSize ?? DEFAULT_MAX_SIZE;
  }

  reserve(
    scopeKey: string,
    fingerprint: string,
    ttlMs: number = this.ttlMs,
  ): ReserveResult {
    const now = this.clock();
    const existing = this.entries.get(scopeKey);

    if (existing && existing.expiresAt > now) {
      if (existing.state === 'completed' && existing.record) {
        // Fingerprints are non-secret SHA-256 digests; plain equality is
        // correct here (no timing side-channel to protect).
        return existing.fingerprint === fingerprint
          ? { kind: 'replay', record: cloneRecord(existing.record) }
          : { kind: 'conflict' };
      }

      // in_progress
      return existing.fingerprint === fingerprint
        ? { kind: 'in_progress' }
        : { kind: 'conflict' };
    }

    // Absent or expired → a fresh reservation.
    if (existing) {
      this.entries.delete(scopeKey);
    }
    this.evictOldestIfNeeded();
    this.entries.set(scopeKey, {
      state: 'in_progress',
      fingerprint,
      createdAt: now,
      expiresAt: now + ttlMs,
    });
    return { kind: 'reserved' };
  }

  complete(
    scopeKey: string,
    fingerprint: string,
    statusCode: number,
    body: unknown,
    ttlMs: number = this.ttlMs,
  ): void {
    const now = this.clock();
    const existing = this.entries.get(scopeKey);

    // Preserve the original reservation's timestamps so the total lifetime
    // stays exactly TTL from first reservation (not extended by processing).
    const base =
      existing && existing.state === 'in_progress'
        ? { createdAt: existing.createdAt, expiresAt: existing.expiresAt }
        : { createdAt: now, expiresAt: now + ttlMs };

    this.entries.set(scopeKey, {
      state: 'completed',
      fingerprint,
      createdAt: base.createdAt,
      expiresAt: base.expiresAt,
      record: {
        fingerprint,
        statusCode,
        body: snapshot(body),
        createdAt: base.createdAt,
        expiresAt: base.expiresAt,
      },
    });
  }

  release(scopeKey: string, fingerprint: string): void {
    const existing = this.entries.get(scopeKey);
    if (
      existing &&
      existing.state === 'in_progress' &&
      existing.fingerprint === fingerprint
    ) {
      this.entries.delete(scopeKey);
    }
  }

  get(scopeKey: string): IdempotencyEntry | undefined {
    const entry = this.entries.get(scopeKey);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAt <= this.clock()) {
      this.entries.delete(scopeKey);
      return undefined;
    }
    return entry;
  }

  delete(scopeKey: string): void {
    this.entries.delete(scopeKey);
  }

  size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }

  purgeExpired(now: number = this.clock()): number {
    let purged = 0;
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
        purged += 1;
      }
    }
    return purged;
  }

  private evictOldestIfNeeded(): void {
    if (this.entries.size < this.maxSize) {
      return;
    }
    const oldest = this.entries.keys().next().value;
    if (oldest !== undefined) {
      this.entries.delete(oldest);
    }
  }
}
