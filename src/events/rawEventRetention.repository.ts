/**
 * @module events/rawEventRetention.repository
 * @description Persistence for raw blockchain event payload retention.
 *
 * The repository owns every write in the retention feature:
 *  - reads raw event candidates from `smart_contract_events`,
 *  - archives payloads into `raw_event_archive` (compliance copy),
 *  - purges raw rows only **after** a successful archive (same transaction),
 *  - manages legal holds in `raw_event_holds`.
 *
 * Guarantees:
 *  - **Idempotent archival**: `raw_event_archive` is keyed by `event_id`, so
 *    re-archiving an already-archived event is a no-op that reports the event
 *    as `alreadyArchived` — a retried run never duplicates archive rows.
 *  - **Transactional archive+purge**: archive insert and raw-row delete happen
 *    in one SQLite transaction, so a crash mid-cycle can never leave a purged
 *    raw row without its archive copy.
 *  - **Bounded reads**: candidate scans are limited and offset-paginated.
 *  - All SQL uses prepared statements with bound parameters.
 */

import { createHash } from 'crypto';
import Database from 'better-sqlite3';
import type { RawEventNetwork } from './rawEventRetention';

/** A raw blockchain event payload row (as stored in `smart_contract_events`). */
export interface RawEventRecord {
  eventId: string;
  contractId: string;
  eventType: string;
  idempotencyKey?: string;
  /** Raw payload — treated as sensitive; never logged. */
  payload: string;
  /** Event timestamp as reported by the chain (ISO string). */
  timestamp: string;
  /** Retention network class; defaults to `offchain` when absent. */
  network: RawEventNetwork;
  /** Ledger sequence the event was observed at (on-chain events). */
  ledger?: number;
  /** Server-side ingestion timestamp — anchors the retention boundary. */
  ingestedAt: string;
}

/** A legal hold scoping which raw events must not be archived/purged. */
export interface RawEventHold {
  id: string;
  scopeType: 'contract' | 'network' | 'all';
  /** Contract id (scope `contract`) or network (scope `network`). */
  scopeValue?: string;
  reason: string;
  actor: string;
  createdAt: string;
  /** ISO timestamp; `undefined` = indefinite hold. */
  expiresAt?: string;
}

export interface RawEventHoldInput {
  scopeType: 'contract' | 'network' | 'all';
  scopeValue?: string;
  reason: string;
  actor: string;
  createdAt?: string;
  expiresAt?: string;
}

/** Candidate scan options — bounded and offset-paginated. */
export interface RawEventCandidateQuery {
  /** Only rows ingested at or before this cutoff are candidates. */
  cutoffByNetwork: Record<RawEventNetwork, string>;
  limit: number;
  offset?: number;
}

export interface ArchiveOutcome {
  /** True when the archive row was newly inserted. */
  archived: boolean;
  /** True when the raw row was deleted after archiving. */
  purged: boolean;
}

export interface RawEventRetentionRepository {
  listCandidates(query: RawEventCandidateQuery): RawEventRecord[];
  countCandidates(query: RawEventCandidateQuery): number;
  findRawEvent(eventId: string): RawEventRecord | undefined;
  isArchived(eventId: string): boolean;
  /** Archive (idempotent) then, when `purge`, delete the raw row — atomic. */
  archiveAndPurge(record: RawEventRecord, archivedAt: string, purge: boolean): ArchiveOutcome;
  listActiveHolds(now: string): RawEventHold[];
  addHold(input: RawEventHoldInput): RawEventHold;
  releaseHold(holdId: string): boolean;
}

interface RawEventRow {
  eventId: string;
  contractId: string;
  eventType: string;
  idempotencyKey: string | null;
  payload: string;
  timestamp: string;
  network: string | null;
  ledger: number | null;
  ingested_at: string | null;
}

interface HoldRow {
  id: string;
  scope_type: string;
  scope_value: string | null;
  reason: string;
  actor: string;
  created_at: string;
  expires_at: string | null;
}

/** Default network class applied to rows without an explicit network. */
export const DEFAULT_RAW_EVENT_NETWORK: RawEventNetwork = 'offchain';

function toRawEventRecord(row: RawEventRow): RawEventRecord {
  return {
    eventId: row.eventId,
    contractId: row.contractId,
    eventType: row.eventType,
    ...(row.idempotencyKey !== null && { idempotencyKey: row.idempotencyKey }),
    payload: row.payload,
    timestamp: row.timestamp,
    network: (row.network as RawEventNetwork) ?? DEFAULT_RAW_EVENT_NETWORK,
    ...(row.ledger !== null && { ledger: row.ledger }),
    ingestedAt: row.ingested_at ?? row.timestamp,
  };
}

function toHold(row: HoldRow): RawEventHold {
  return {
    id: row.id,
    scopeType: row.scope_type as RawEventHold['scopeType'],
    ...(row.scope_value !== null && { scopeValue: row.scope_value }),
    reason: row.reason,
    actor: row.actor,
    createdAt: row.created_at,
    ...(row.expires_at !== null && { expiresAt: row.expires_at }),
  };
}

/** Builds the per-network cutoff SQL fragment with bound parameters. */
function buildCutoffSql(
  cutoffByNetwork: Record<RawEventNetwork, string>,
): { where: string; params: string[] } {
  const clauses: string[] = [];
  const params: string[] = [];
  for (const network of Object.keys(cutoffByNetwork) as RawEventNetwork[]) {
    const cutoff = cutoffByNetwork[network];
    if (cutoff === undefined) continue;
    clauses.push(`(COALESCE(network, ?) = ? AND COALESCE(ingested_at, timestamp) <= ?)`);
    params.push(DEFAULT_RAW_EVENT_NETWORK, network, cutoff);
  }
  return {
    where: clauses.length > 0 ? `WHERE ${clauses.join(' OR ')}` : '',
    params,
  };
}

/**
 * SQLite-backed implementation over the shared database.
 * `smart_contract_events` / `raw_event_archive` / `raw_event_holds` are
 * created by migration v17.
 */
export class SqliteRawEventRetentionRepository
  implements RawEventRetentionRepository
{
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  listCandidates(query: RawEventCandidateQuery): RawEventRecord[] {
    const { where, params } = buildCutoffSql(query.cutoffByNetwork);
    const limit = Math.min(Math.max(Math.floor(query.limit), 1), 1000);
    const offset = Math.max(Math.floor(query.offset ?? 0), 0);
    const rows = this.db
      .prepare<unknown[], RawEventRow>(
        `SELECT eventId, contractId, eventType, idempotencyKey, payload, timestamp,
                network, ledger, ingested_at
         FROM smart_contract_events
         ${where}
         ORDER BY COALESCE(ingested_at, timestamp) ASC, eventId ASC
         LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset);
    return rows.map(toRawEventRecord);
  }

  countCandidates(query: RawEventCandidateQuery): number {
    const { where, params } = buildCutoffSql(query.cutoffByNetwork);
    const row = this.db
      .prepare<unknown[], { n: number }>(
        `SELECT COUNT(*) AS n FROM smart_contract_events ${where}`,
      )
      .get(...params);
    return row?.n ?? 0;
  }

  findRawEvent(eventId: string): RawEventRecord | undefined {
    const row = this.db
      .prepare<[string], RawEventRow>(
        `SELECT eventId, contractId, eventType, idempotencyKey, payload, timestamp,
                network, ledger, ingested_at
         FROM smart_contract_events WHERE eventId = ?`,
      )
      .get(eventId);
    return row ? toRawEventRecord(row) : undefined;
  }

  isArchived(eventId: string): boolean {
    const row = this.db
      .prepare<[string], { n: number }>(
        'SELECT COUNT(*) AS n FROM raw_event_archive WHERE event_id = ?',
      )
      .get(eventId);
    return (row?.n ?? 0) > 0;
  }

  archiveAndPurge(
    record: RawEventRecord,
    archivedAt: string,
    purge: boolean,
  ): ArchiveOutcome {
    const tx = this.db.transaction((): ArchiveOutcome => {
      const insert = this.db
        .prepare<[string, string, string, string | null, string, string, string]>(
          `INSERT OR IGNORE INTO raw_event_archive
             (event_id, contract_id, event_type, network, archived_at, payload, payload_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.eventId,
          record.contractId,
          record.eventType,
          record.network,
          archivedAt,
          record.payload,
          hashPayload(record.payload),
        );

      const archived = insert.changes > 0;
      let purged = false;
      if (purge && archived) {
        const del = this.db
          .prepare<[string]>(
            'DELETE FROM smart_contract_events WHERE eventId = ?',
          )
          .run(record.eventId);
        purged = del.changes > 0;
      }
      return { archived, purged };
    });

    return tx();
  }

  listActiveHolds(now: string): RawEventHold[] {
    const rows = this.db
      .prepare<[string], HoldRow>(
        `SELECT id, scope_type, scope_value, reason, actor, created_at, expires_at
         FROM raw_event_holds
         WHERE expires_at IS NULL OR expires_at > ?
         ORDER BY created_at ASC`,
      )
      .all(now);
    return rows.map(toHold);
  }

  addHold(input: RawEventHoldInput): RawEventHold {
    const id = `hold_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
    const createdAt = input.createdAt ?? new Date().toISOString();
    this.db
      .prepare<
        [string, string, string | null, string, string, string, string | null]
      >(
        `INSERT INTO raw_event_holds
           (id, scope_type, scope_value, reason, actor, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.scopeType,
        input.scopeValue ?? null,
        input.reason,
        input.actor,
        createdAt,
        input.expiresAt ?? null,
      );
    return {
      id,
      scopeType: input.scopeType,
      ...(input.scopeValue !== undefined && { scopeValue: input.scopeValue }),
      reason: input.reason,
      actor: input.actor,
      createdAt,
      ...(input.expiresAt !== undefined && { expiresAt: input.expiresAt }),
    };
  }

  releaseHold(holdId: string): boolean {
    const result = this.db
      .prepare<[string]>('DELETE FROM raw_event_holds WHERE id = ?')
      .run(holdId);
    return result.changes > 0;
  }
}

/**
 * In-memory implementation for deterministic tests and local development.
 * Mirrors the SQLite semantics (idempotent archive, transactional purge).
 */
export class InMemoryRawEventRetentionRepository
  implements RawEventRetentionRepository
{
  private readonly raw = new Map<string, RawEventRecord>();
  private readonly archive = new Map<string, { eventId: string; archivedAt: string }>();
  private readonly holds = new Map<string, RawEventHold>();

  seed(record: RawEventRecord): void {
    this.raw.set(record.eventId, { ...record });
  }

  clear(): void {
    this.raw.clear();
    this.archive.clear();
    this.holds.clear();
  }

  listCandidates(query: RawEventCandidateQuery): RawEventRecord[] {
    const offset = Math.max(Math.floor(query.offset ?? 0), 0);
    const limit = Math.min(Math.max(Math.floor(query.limit), 1), 1000);
    return Array.from(this.raw.values())
      .filter((r) => {
        const cutoff = query.cutoffByNetwork[r.network];
        return cutoff !== undefined && r.ingestedAt <= cutoff;
      })
      .sort((a, b) =>
        a.ingestedAt === b.ingestedAt
          ? a.eventId.localeCompare(b.eventId)
          : a.ingestedAt.localeCompare(b.ingestedAt),
      )
      .slice(offset, offset + limit);
  }

  countCandidates(query: RawEventCandidateQuery): number {
    return Array.from(this.raw.values()).filter((r) => {
      const cutoff = query.cutoffByNetwork[r.network];
      return cutoff !== undefined && r.ingestedAt <= cutoff;
    }).length;
  }

  findRawEvent(eventId: string): RawEventRecord | undefined {
    const record = this.raw.get(eventId);
    return record ? { ...record } : undefined;
  }

  isArchived(eventId: string): boolean {
    return this.archive.has(eventId);
  }

  archiveAndPurge(
    record: RawEventRecord,
    archivedAt: string,
    purge: boolean,
  ): ArchiveOutcome {
    const alreadyArchived = this.archive.has(record.eventId);
    if (!alreadyArchived) {
      this.archive.set(record.eventId, { eventId: record.eventId, archivedAt });
    }
    let purged = false;
    if (purge && !alreadyArchived) {
      purged = this.raw.delete(record.eventId);
    }
    return { archived: !alreadyArchived, purged };
  }

  listActiveHolds(now: string): RawEventHold[] {
    return Array.from(this.holds.values())
      .filter((h) => h.expiresAt === undefined || h.expiresAt > now)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  addHold(input: RawEventHoldInput): RawEventHold {
    const hold: RawEventHold = {
      id: `hold_${this.holds.size + 1}`,
      scopeType: input.scopeType,
      ...(input.scopeValue !== undefined && { scopeValue: input.scopeValue }),
      reason: input.reason,
      actor: input.actor,
      createdAt: input.createdAt ?? new Date().toISOString(),
      ...(input.expiresAt !== undefined && { expiresAt: input.expiresAt }),
    };
    this.holds.set(hold.id, hold);
    return { ...hold };
  }

  releaseHold(holdId: string): boolean {
    return this.holds.delete(holdId);
  }
}

/** SHA-256 of the raw payload — the only payload-derived value ever logged. */
export function hashPayload(payload: string): string {
  return createHash('sha256').update(payload).digest('hex');
}
