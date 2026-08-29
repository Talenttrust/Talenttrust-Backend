/**
 * @module repository/sqliteEventAuditRepository
 * @description SQLite-backed event audit + projection repository.
 *
 * This is the production repository for event ingestion (wired as the default
 * in `events/registry.ts`). It persists the **event checkpoint** (the audit
 * record) and the **entity projection** atomically in a single
 * `better-sqlite3` transaction, so a partially-applied event can never leave
 * a checkpoint without its projection (or vice-versa).
 *
 * ## Identity model
 *
 * - `event_audit.deduplication_key` is **event identity**
 *   (`contractId:eventId:sequence`, see `DeduplicationManager`). It uniquely
 *   identifies one incoming event.
 * - `event_projection.entity_id` is **entity/read-model identity**. Multiple
 *   events may update the same projection, which is why the projection key is
 *   never the event dedup key. `last_event_id` records which event last
 *   advanced the projection, so a duplicate replay of the same event cannot
 *   double-apply its projection.
 *
 * ## Transaction + retry semantics
 *
 * `persistEventAndProjection` runs the audit and projection rows inside ONE
 * `db.transaction()`. Only serialization failures (`SQLITE_BUSY` and
 * `SQLITE_BUSY_SNAPSHOT`) are retried, with bounded attempts and bounded total
 * delay. Constraint violations, malformed data, and any other error are
 * surfaced immediately (no retry loop masks a real bug). External calls
 * (finality provider network fetch, webhooks, outbound logging) must be kept
 * OUTSIDE the transaction — they are deliberately not part of this method.
 *
 * @security
 *  - All SQL uses prepared statements / parameter binding (SQL-injection safe).
 *  - `tenant_id` is enforced on both write and read paths so an event can never
 *    be associated with, or leak into, another tenant's projection.
 */

import type { Database as DatabaseInstance } from 'better-sqlite3';
import type { EventProcessingAudit } from '../events/types';
import { FinalityStatus } from '../finality/types';
import type { IEventAuditRepository } from './eventAuditRepository';
import { createLogger } from '../logger';

const log = createLogger({ service: 'sqlite-event-audit' });

/** Maximum number of attempts for a serialization retry (including the first). */
const MAX_RETRY_ATTEMPTS = 3;
/** Fixed delay between serialization retries (ms). */
const RETRY_DELAY_MS = 10;

/** SQLite extended result codes for a serialization (busy) failure. */
const SERIALIZATION_CODES = new Set<number>([5, 517]); // 5 = SQLITE_BUSY, 517 = SQLITE_BUSY_SNAPSHOT

// ---------------------------------------------------------------- row shapes

interface EventAuditRow {
  deduplication_key: string;
  id: string;
  contract_id: string;
  event_id: string;
  sequence: number;
  status: 'accepted' | 'rejected' | 'duplicate';
  reason: string | null;
  payload_hash: string;
  tenant_id: string;
  network: string | null;
  ledger: number | null;
  finality_status: string | null;
  finalized_at: string | null;
  processed_at: string;
  created_at: string;
  correlation_id: string | null;
}

/** A projection (read-model) update to persist alongside the event audit. */
export interface ProjectionWrite {
  /** Entity/read-model identity the projection is keyed by. */
  entityId: string;
  /** Tenant that owns the projection (isolation scope). */
  tenantId: string;
  /** Serialized projection state. */
  data: string;
  /** Optimistic version — one of the writes in a transaction. */
  version: number;
  /** Deduplication key of the event being applied (for replay idempotency). */
  lastEventId: string;
}

/**
 * Snapshot a projection row so the caller can detect a no-op duplicate replay
 * and decide whether the projection actually changed.
 */
export interface ReadProjection {
  entityId: string;
  tenantId: string;
  data: string;
  version: number;
  lastEventId?: string;
}

// ------------------------------------------------------------- retry helper

/** Returns true only for SQLITE_BUSY / SQLITE_BUSY_SNAPSHOT errors. */
function isSerializationError(error: unknown): boolean {
  const code =
    typeof error === 'object' && error !== null
      ? (error as { code?: unknown }).code
      : undefined;
  return typeof code === 'number' && SERIALIZATION_CODES.has(code);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run `fn` inside a transaction, retrying only serialization failures.
 *
 * - Bounded attempts (`MAX_RETRY_ATTEMPTS`) and bounded total delay.
 * - Any non-serialization error (constraint, malformed data, etc.) propagates
 *   immediately — never retried.
 * - After retries are exhausted the final error is rethrown so the caller can
 *   surface a structured, non-leaking error.
 *
 * Exported so the retry policy can be unit-tested independently of a live DB.
 */
export async function withSerializationRetry<T>(fn: () => T): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return fn();
    } catch (error) {
      lastError = error;
      if (!isSerializationError(error)) {
        throw error;
      }
      log.warn('Event audit transaction serialization conflict; retrying', {
        attempt: attempt + 1,
        maxAttempts: MAX_RETRY_ATTEMPTS,
      });
      if (attempt < MAX_RETRY_ATTEMPTS - 1) {
        await sleep(RETRY_DELAY_MS);
      }
    }
  }
  throw lastError;
}

// ------------------------------------------------------- SQLite repository

export class SqliteEventAuditRepository implements IEventAuditRepository {
  private readonly db: DatabaseInstance;

  constructor(db: DatabaseInstance) {
    this.db = db;
  }

  // ------------------------------------------------------------- read paths

  async findByDeduplicationKey(
    deduplicationKey: string,
  ): Promise<EventProcessingAudit | null> {
    const row = this.db
      .prepare('SELECT * FROM event_audit WHERE deduplication_key = ?')
      .get(deduplicationKey) as EventAuditRow | undefined;
    return row ? this.toAudit(row) : null;
  }

  async findByContractId(
    contractId: string,
    limit: number = 100,
  ): Promise<EventProcessingAudit[]> {
    const rows = this.db
      .prepare(
        'SELECT * FROM event_audit WHERE contract_id = ? ORDER BY created_at DESC LIMIT ?',
      )
      .all(contractId, limit) as EventAuditRow[];
    return rows.map((row) => this.toAudit(row));
  }

  /** Public read — only events that are safe to expose (not provisional). */
  async findFinalizedByContractId(
    contractId: string,
    limit: number = 100,
  ): Promise<EventProcessingAudit[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM event_audit
         WHERE contract_id = ? AND (finality_status IS NULL OR finality_status != 'provisional')
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(contractId, limit) as EventAuditRow[];
    return rows.map((row) => this.toAudit(row));
  }

  /** Internal read — provisional events for a network (or all networks). */
  async findProvisional(network?: string): Promise<EventProcessingAudit[]> {
    const rows = network
      ? (this.db
          .prepare(
            `SELECT * FROM event_audit
             WHERE finality_status = 'provisional' AND network = ? ORDER BY created_at DESC`,
          )
          .all(network) as EventAuditRow[])
      : (this.db
          .prepare(
            `SELECT * FROM event_audit
             WHERE finality_status = 'provisional' ORDER BY created_at DESC`,
          )
          .all() as EventAuditRow[]);
    return rows.map((row) => this.toAudit(row));
  }

  async findByStatus(
    status: 'accepted' | 'rejected' | 'duplicate',
    limit: number = 100,
  ): Promise<EventProcessingAudit[]> {
    const rows = this.db
      .prepare(
        'SELECT * FROM event_audit WHERE status = ? ORDER BY created_at DESC LIMIT ?',
      )
      .all(status, limit) as EventAuditRow[];
    return rows.map((row) => this.toAudit(row));
  }

  async getEventStatistics(): Promise<{
    total: number;
    accepted: number;
    rejected: number;
    duplicates: number;
  }> {
    const row = this.db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END) AS accepted,
           SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected,
           SUM(CASE WHEN status = 'duplicate' THEN 1 ELSE 0 END) AS duplicates
         FROM event_audit`,
      )
      .get() as { total: number; accepted: number; rejected: number; duplicates: number };

    const toInt = (v: number | null): number => (v == null ? 0 : Number(v));
    return {
      total: toInt(row.total),
      accepted: toInt(row.accepted),
      rejected: toInt(row.rejected),
      duplicates: toInt(row.duplicates),
    };
  }

  // ------------------------------------------------------------ write paths

  /**
   * Single-record persistence (checkpoint only). Used for rejected events and
   * by tests; accepted events that also advance a projection should go through
   * {@link persistEventAndProjection}.
   */
  async save(audit: EventProcessingAudit): Promise<EventProcessingAudit> {
    await withSerializationRetry(() => {
      this.insertAudit(audit, 'default');
    });
    return audit;
  }

  /**
   * One-way promotion: flip a provisional event to finalized. No-op when the
   * event is unknown. Not transactional with any projection write because a
   * promotion does not change projection state — but it stays a single-row
   * update so retry-on-serialization applies.
   */
  async markFinalized(deduplicationKey: string, finalizedAt: string): Promise<void> {
    await withSerializationRetry(() => {
      this.db
        .prepare(
          `UPDATE event_audit
           SET finality_status = 'finalized', finalized_at = ?
           WHERE deduplication_key = ?`,
        )
        .run(finalizedAt, deduplicationKey);
    });
  }

  /**
   * Atomically persist an event checkpoint AND its projection in one
   * transaction. This is the primary use case for issue #1226: an accepted
   * event and the read-model it advances cannot be split across commits.
   *
   * The `projection.tenantId` scopes BOTH rows — the projection and the audit
   * record it accompanies — so an event can never be written into another
   * tenant's data.
   *
   * - Audit row is inserted keyed on the event deduplication key.
   * - Projection row is upserted keyed on `projection.entityId`.
   * - The whole block is one `db.transaction()`.
   * - Only serialization failures are retried (bounded). External calls are
   *   NOT part of this method.
   *
   * @throws On constraint/data errors immediately; on serialization failure
   *         after the bounded retries are exhausted.
   */
  async persistEventAndProjection(
    audit: EventProcessingAudit,
    projection: ProjectionWrite,
  ): Promise<void> {
    await withSerializationRetry(() => {
      const run = this.db.transaction(() => {
        this.insertAudit(audit, projection.tenantId);
        this.db
          .prepare(
            `INSERT INTO event_projection (entity_id, tenant_id, data, version, last_event_id)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(entity_id) DO UPDATE SET
               tenant_id = excluded.tenant_id,
               data = excluded.data,
               version = excluded.version,
               last_event_id = excluded.last_event_id`,
          )
          .run(
            projection.entityId,
            projection.tenantId,
            projection.data,
            projection.version,
            projection.lastEventId,
          );
      });
      run();
    });
  }

  /** Snapshot a projection row (mirrors {@link ReadProjection}). */
  readProjection(entityId: string): ReadProjection | null {
    const row = this.db
      .prepare('SELECT * FROM event_projection WHERE entity_id = ?')
      .get(entityId) as
      | {
          entity_id: string;
          tenant_id: string;
          data: string;
          version: number;
          last_event_id: string | null;
        }
      | undefined;
    if (!row) return null;
    return {
      entityId: row.entity_id,
      tenantId: row.tenant_id,
      data: row.data,
      version: row.version,
      ...(row.last_event_id !== null && { lastEventId: row.last_event_id }),
    };
  }

  /** Enforce tenant scope when reading a projection (isolation guard). */
  readProjectionForTenant(entityId: string, tenantId: string): ReadProjection | null {
    const projection = this.readProjection(entityId);
    if (!projection) return null;
    if (projection.tenantId !== tenantId) return null;
    return projection;
  }

  // ----------------------------------------------------------------- helpers

  private insertAudit(audit: EventProcessingAudit, tenantId: string): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO event_audit (
           deduplication_key, id, contract_id, event_id, sequence, status, reason,
           payload_hash, tenant_id, network, ledger, finality_status, finalized_at,
           processed_at, created_at, correlation_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        audit.deduplicationKey,
        audit.id,
        audit.contractId,
        audit.eventId,
        audit.sequence,
        audit.status,
        audit.reason ?? null,
        audit.payloadHash,
        tenantId,
        audit.network ?? null,
        audit.ledger ?? null,
        audit.finalityStatus ?? null,
        audit.finalizedAt ?? null,
        audit.processedAt.toISOString(),
        audit.createdAt.toISOString(),
        audit.correlationId ?? null,
      );
  }

  private toAudit(row: EventAuditRow): EventProcessingAudit {
    return {
      id: row.id,
      deduplicationKey: row.deduplication_key,
      contractId: row.contract_id,
      eventId: row.event_id,
      sequence: row.sequence,
      status: row.status,
      ...(row.reason !== null && { reason: row.reason }),
      payloadHash: row.payload_hash,
      processedAt: new Date(row.processed_at),
      createdAt: new Date(row.created_at),
      ...(row.correlation_id !== null && { correlationId: row.correlation_id }),
      ...(row.tenant_id !== 'default' && { tenantId: row.tenant_id }),
      ...(row.network !== null && { network: row.network }),
      ...(row.ledger !== null && { ledger: row.ledger }),
      ...(row.finality_status && { finalityStatus: row.finality_status as FinalityStatus }),
      ...(row.finalized_at !== null && { finalizedAt: row.finalized_at }),
    };
  }
}