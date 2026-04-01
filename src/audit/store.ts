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
 * Production note: Replace the in-memory array with a write-once database table
 * (e.g. PostgreSQL with row-level security and no UPDATE/DELETE grants) while
 * keeping this interface contract intact.
 */

import { createHash, randomUUID } from 'crypto';
import type { AuditEntry, AuditQuery, CreateAuditEntryInput, IntegrityReport } from './types';

/** Sentinel hash used as the previousHash of the very first entry. */
export const GENESIS_HASH = 'GENESIS';

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
 * AuditStore — append-only, hash-chained audit log.
 *
 * @example
 * ```ts
 * const store = new AuditStore();
 * store.append({ action: 'CONTRACT_CREATED', severity: 'INFO', actor: 'user-1', ... });
 * const report = store.verifyIntegrity();
 * ```
 */
export class AuditStore {
  /** Internal append-only log. Never mutate directly. */
  private readonly log: AuditEntry[] = [];

  /**
   * Appends a new immutable entry to the log.
   * Automatically assigns id, timestamp, previousHash, and hash.
   *
   * @param input - Caller-supplied fields (must not contain raw PII).
   * @returns The frozen, persisted AuditEntry.
   */
  append(input: CreateAuditEntryInput): AuditEntry {
    const previousHash =
      this.log.length === 0 ? GENESIS_HASH : this.log[this.log.length - 1].hash;

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

    this.log.push(entry);
    return entry;
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
    const limit = Math.min(query.limit ?? 100, 1000);
    const offset = Math.max(query.offset ?? 0, 0);

    let results = this.log.filter((entry) => {
      if (query.action && entry.action !== query.action) return false;
      if (query.severity && entry.severity !== query.severity) return false;
      if (query.actor && entry.actor !== query.actor) return false;
      if (query.resource && entry.resource !== query.resource) return false;
      if (query.resourceId && entry.resourceId !== query.resourceId) return false;
      if (query.from && entry.timestamp < query.from) return false;
      if (query.to && entry.timestamp > query.to) return false;
      return true;
    });

    return results.slice(offset, offset + limit);
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
      const expectedPreviousHash = i === 0 ? GENESIS_HASH : this.log[i - 1].hash;
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
  }
}

/** Singleton store instance shared across the application. */
export const auditStore = new AuditStore();
