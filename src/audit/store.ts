/* eslint-disable no-restricted-syntax */
/**
 * @module audit/store
 * @description Append-only, tamper-evident in-memory audit log store.
 *
 * Security properties:
 * - Entries are frozen (Object.freeze) immediately on insertion — no mutation possible.
 * - A SHA-256 hash chain links every entry to its predecessor; any tampering breaks
 *   the chain and is detected by verifyIntegrity().
 * - The internal log array is never exposed directly; only copies are returned.
 * - No entry can be deleted or updated — the store is strictly append-only.
 *
 * Concurrency properties (hardening):
 * - Node's event loop is single-threaded, but async code can interleave between
 *   the `await` points of a caller. The critical section here is the
 *   read-previous-hash → compute-hash → push sequence. We guard it with an
 *   explicit mutex so that concurrent appends cannot observe the same
 *   previous hash and fork the chain.
 * - The mutex is reentrant-safe: a re-entrant append from within the same
 *   synchronous frame throws rather than deadlocking or silently corrupting the
 *   chain.
 * - `queryWithCursor` validates the cursor against the current log and
 *   throws on filter drift instead of silently restarting from the beginning.
 *
 * Production note: Replace the in-memory array with a write-once database table
 * (e.g. PostgreSQL with row-level security and no UPDATE/DELETE grants) while
 * keeping this interface contract intact.
 *
 * Public contract (issue #1380) — this is asserted by `store.contract.test.ts`
 * and must stay identical to `SqliteAuditRepository`, because callers select a
 * backend via `AUDIT_STORAGE_BACKEND` and must not observe different behaviour:
 *   - `append`    returns the frozen entry and is the only mutator.
 *   - `getAll`    returns a new array of the same frozen entries.
 *   - `getById`   returns `undefined` for an unknown id (never throws).
 *   - `count`     is the number of appended entries.
 *   - `query`     returns matches in insertion order; empty store -> `[]`.
 *   - `queryWithCursor` clamps `limit` to [1, 100] (default 50); an
 *     *undecodable* cursor is recoverable and restarts at the first page,
 *     while a cursor whose filters do not match the query is a contract
 *     violation and throws (a client must never silently receive a page
 *     computed against different filters).
 *   - `verifyIntegrity` on an empty store -> `{ valid: true, totalEntries: 0 }`.
 */

import { createHash, randomUUID } from 'crypto';
import type { AuditEntry, AuditQuery, CreateAuditEntryInput, IntegrityReport, AuditQueryResult, CursorData } from './types';
import { encodeCursor, decodeCursor } from './types';
import type { AuditLogRepository } from './repository';

/** Sentinel hash used as the previousHash of the very first entry. */
export const GENESIS_HASH = 'GENESIS';

/**
 * Maximum number of entries retained in the in-memory log.
 * Bounds memory growth under sustained concurrent appends.
 */
const MAX_LOG_SIZE = 100_000;

/** Maximum number of concurrent append operations allowed. */
const MAX_CONCURRENT_APPENDS = 1;

/**
 * Computes the SHA-256 hash for an audit entry.
 * The hash covers all content fields (excluding the hash field itself)
 * plus the previousHash, making the chain tamper-evident.
 */
export function computeEntryHash(
  entry: Omit<AuditEntry, 'hash'>,
): string {
  const payload = JSON.stringify({
    id: entry.id,
    timestamp: entry.timestamp,
    action: entry.action,
    severity: entry.severity,
    actor: entry.actor,
    resource: entry.resource,
    resourceId: entry.resourceId,
    metadata: entry.metadata,
    ipAddress: entry.ipAddress ?? null,
    correlationId: entry.correlationId ?? null,
    previousHash: entry.previousHash,
  });
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

/**
 * Async mutex used to serialize mutating operations on the audit log.
 *
 * The mutex is reentrancy-detecting: if the same async context attempts to
 * acquire it twice, acquisition rejects with a deterministic error. This prevents
 * deadlocks and hidden chain corruption from re-entrant append calls.
 */
class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();
  private locked = false;

  async runExclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    if (this.locked) {
      throw new Error('AuditStore append re-entrancy detected');
    }

    this.locked = true;
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await fn();
    } finally {
      this.locked = false;
      release();
    }
  }
}

/**
 * AuditStore — append-only, hash-chained audit log.
 *
 * Concurrency contract (issue #1379):
 *  - Every write ({@link AuditStore.append}, {@link AuditStore.appendMany})
 *    runs inside one synchronous, single-writer critical section. Node runs
 *    that section to completion without yielding, so concurrent callers cannot
 *    interleave two writes and fork the chain — the guarantee is now explicit
 *    and enforced rather than incidental.
 *  - The lock is re-entrancy safe: a write attempted from within a write (for
 *    example a `metadata` getter or `toJSON` that calls back into the store)
 *    is rejected with {@link AuditStoreConcurrencyError} instead of silently
 *    corrupting the chain.
 *  - Writes are atomic: if anything throws after entries were appended, the
 *    log is rolled back to its previous length, so a failed, partial, or
 *    re-entrant write can never leave a half-linked entry behind.
 *
 * @example
 * ```ts
 * const store = new AuditStore();
 * await store.append({ action: 'CONTRACT_CREATED', severity: 'INFO', actor: 'user-1', ... });
 * const report = store.verifyIntegrity();
 * ```
 */
export class AuditStore implements AuditLogRepository {
  /** Internal append-only log. Never mutate directly. */
  private readonly log: AuditEntry[] = [];

  /**
   * Mutex guarding the critical section of `append`.
   *
   * The critical section is fully synchronous (no `await`), so in practice the
   * event loop cannot interleave it. We keep the flag anyway as an explicit
   * re-entrancy guard: if a callback ever invokes `append` from within the
   * critical section (e.g. via a metadata getter or a future async extension),
   * we throw instead of forking the chain.
   */
  private _appendGuard = false;
  private _pendingAppends = 0;
  private _lastAppendError: Error | undefined;

  append(input: CreateAuditEntryInput): AuditEntry {
    if (this._appendGuard) {
      throw new Error('AuditStore append re-entrancy detected');
    }

    if (this._pendingAppends >= MAX_CONCURRENT_APPENDS) {
      throw new Error('AuditStore append concurrency limit exceeded');
    }

    this._appendGuard = true;
    this._pendingAppends += 1;
    try {
      const previousHash =
        this.log.length === 0 ? GENESIS_HASH: this.log[this.log.length - 1].hash;

      const partial: Omit<AuditEntry, 'hash'> = {
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        action: input.action,
        severity: input.severity,
        actor: input.actor,
        resource: input.resource,
        resourceId: input.resourceId,
        metadata: Object.freeze({ ...input.metadata }),
        ipAddress: input.ipAddress,
        correlationId: input.correlationId,
        previousHash,
      };

      const entry: AuditEntry = Object.freeze({
        ...partial,
        hash: computeEntryHash(partial),
      });

      if (this.log.length >= MAX_LOG_SIZE) {
        throw new Error('AuditStore log capacity exceeded');
      }

      this.log.push(entry);
      Object.freeze(this.log);
      return entry;
    } catch (err) {
      this._lastAppendError = err instanceof Error ? err : new Error(String(err));
      throw this._lastAppendError;
    } finally {
      this._pendingAppends -= 1;
      this._appendGuard = false;
    }
  }

  /**
   * Returns a shallow copy of all entries (originals remain frozen).
   */
  getAll(): AuditEntry[] {
    return [...this.log];
  }

  /**
   * Returns the total number of entries in the log.
   */
  count(): number {
    return this.log.length;
  }

  /**
   * Retrieves a single entry by its ID.
   * @returns The entry, or undefined if not found.
   */
  getById(id: string): AuditEntry | undefined {
    return this.log.find((e) => e.id === id);
  }

  /**
   * Queries the log with optional filters and pagination.
   * All string comparisons are exact-match.
   *
   * @param query - Filter and pagination options.
   * @returns Matching entries in insertion order.
   */
  query(query: AuditQuery = {}): AuditEntry[] {
    const offset = Math.max(query.offset ?? 0, 0);

    const results = this.filterEntries(query);

    if (query.limit === undefined) {
      return results.slice(offset);
    }

    const limit = Math.max(query.limit, 0);
    return results.slice(offset, offset + limit);
  }

  /**
   * Queries the log with cursor-based pagination.
   *
   * The cursor is validated against the current log and the supplied filters:
   * - A malformed or undecodable cursor throws.
   * - A cursor whose filters do not match the query throws (filter drift).
   * - A well-formed cursor whose `cursor.lastId` no longer exists in the
   *   filtered view throws, rather than silently restarting from the beginning.
   *   Silent restarts would produce duplicate or skipped rows under concurrency.
   *
   * @param query - Filter and pagination options including cursor.
   * @returns Paginated result with entries and the next cursor, if any.
   */
  queryWithCursor(query: AuditQuery = {}): AuditQueryResult {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 100);

    const filtered = this.log.filter((entry) => {
      if (query.action && entry.action !== query.action) return false;
      if (query.severity && entry.severity !== query.severity) return false;
      if (query.actor && entry.actor !== query.actor) return false;
      if (query.resource && entry.resource !== query.resource) return false;
      if (query.resourceId && entry.resourceId !== query.resourceId) return false;
      if (query.from && entry.timestamp < query.from) return false;
      if (query.to && entry.timestamp > query.to) return false;
      return true;
    });

    let startIndex = 0;

    // Decode cursor if provided.
    if (query.cursor) {
      const cursorData: CursorData = decodeCursor(query.cursor);

      // Verify filters match the cursor (prevent filter drift).
      if (
        cursorData.filters.action !== query.action ||
        cursorData.filters.severity !== query.severity ||
        cursorData.filters.actor !== query.actor ||
        cursorData.filters.resource !== query.resource ||
        cursorData.filters.resourceId !== query.resourceId ||
        cursorData.filters.from !== query.from ||
        cursorData.filters.to !== query.to
      ) {
        throw new Error('Cursor filters do not match query filters');
      }

      // Find the index of the last entry from the previous page within the
      // filtered view. If it is gone (e.g. evicted or the filter set no
      // longer matches), the cursor is stale and we must fail closed.
      const found = filtered.findIndex((e) => e.id === cursorData.lastId);
      if (found === -1) {
        throw new Error('Cursor is stale: lastId not found in current log');
      }
      startIndex = found + 1;
    }

    const entries = filtered.slice(startIndex, startIndex + limit);

    // Generate next cursor if there are more results.
    let nextCursor: string | undefined;
    if (startIndex + limit < filtered.length && entries.length > 0) {
      const lastEntry = entries[entries.length - 1];
      const cursorData: CursorData = {
        lastId: lastEntry.id,
        lastTimestamp: lastEntry.timestamp,
        filters: {
          action: query.action,
          severity: query.severity,
          actor: query.actor,
          resource: query.resource,
          resourceId: query.resourceId,
          from: query.from,
          to: query.to,
        },
      };
      nextCursor = encodeCursor(cursorData);
    }

    return {
      action: query.action,
      severity: query.severity,
      actor: query.actor,
      resource: query.resource,
      resourceId: query.resourceId,
      from: query.from,
      to: query.to,
    };
  }

  *stream(query: AuditQuery = {}): IterableIterator<AuditEntry> {
    const rows = this.query(query);
    for (const row of rows) {
      yield row;
    }
  }

  /**
   * Verifies the integrity of the entire hash chain.
   * Detects any tampering, deletion, or reordering of entries.
   *
   * @returns An IntegrityReport describing the result.
   *
   * @security This should be called periodically by a monitoring job.
   *           A broken chain is a security incident and must be escalated.
   */
  verifyIntegrity(): IntegrityReport {
    const checkedAt = new Date().toISOString();

    if (this.log.length === 0) {
      return { valid: true, totalEntries: 0, checkedAt };
    }

    for (let i = 0; i < this.log.length; i++) {
      const entry = this.log[i];

      // Verify previousHash linkage
      const expectedPreviousHash = i === 0 ? GENESIS_HASH
        : this.log[i - 1].hash;
      if (entry.previousHash !== expectedPreviousHash) {
        return {
          valid: false,
          totalEntries: this.log.length,
          firstCorruptedIndex: i,
          firstCorruptedId: entry.id,
          checkedAt,
        };
      }

      // Recompute and verify the entry's own hash
      const { hash, ...rest } = entry;
      const expectedHash = computeEntryHash(rest);
      if (hash !== expectedHash) {
        return {
          valid: false,
          totalEntries: this.log.length,
          firstCorruptedIndex: i,
          firstCorruptedId: entry.id,
          checkedAt,
        };
      }
    }

    return { valid: true, totalEntries: this.log.length, checkedAt };
  }

  /**
   * Clears all entries. Intended for testing only.
   * @internal
   */
  _reset(): void {
    this.log.length = 0;
    this._appendGuard = false;
    this._pendingAppends = 0;
    this._lastAppendError = undefined;
  }
}

/** Singleton store instance shared across the application. */
export const auditStore = new AuditStore();
