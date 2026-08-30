/**
 * @module events/eventQuarantine
 * @description Durable quarantine for contract events this backend cannot
 * yet process safely (unknown contract schema versions).
 *
 * An event from a newer contract cannot be fed into projections that assume
 * an older payload shape, but it must not be silently dropped either — it is
 * retained here (payload redacted, reason sanitized) so operators can
 * reprocess it through an authenticated, audited flow once support ships.
 *
 * Invariants:
 *  - **No silent deletion** — entries are only removed by an explicit replay
 *    success; capacity overflow evicts the oldest pending entry (mirrors the
 *    job-quarantine and webhook DLQ policies).
 *  - **Redacted persistence** — the stored payload is passed through
 *    `redactPayload` and the reason through the safe-error sanitizer, so no
 *    secrets or internal stack details are persisted.
 *  - **Bounded replay** — replay attempts are counted; past
 *    `maxReplayAttempts` the entry is flagged so it no longer counts as
 *    pending (replay backoff is an operator concern, never silent deletion).
 */

import DatabaseConstructor from '../db/betterSqlite3';
import * as crypto from 'crypto';
import path from 'path';
import { Counter, Registry } from 'prom-client';
import { redactPayload } from '../utils/redact';
import { sanitizeErrorMessage } from '../errors/safeErrors';

/** A single quarantined event as consumed by inspection/replay. */
export interface QuarantinedEventEntry {
  id: string;
  contractId: string;
  eventId: string;
  sequence: number;
  schemaVersion?: number;
  eventType: string;
  /** Redacted event payload (the full normalized event envelope). */
  payload: Record<string, unknown>;
  reason: string;
  quarantinedAt: string;
  replayedAt?: string;
  replayAttempts: number;
  createdAt: string;
  updatedAt: string;
}

export interface EventQuarantineQuery {
  contractId?: string;
  eventType?: string;
  limit?: number;
  offset?: number;
}

export interface EventQuarantineConfig {
  maxCapacity: number;
  maxReplayAttempts: number;
}

const DEFAULT_QUARANTINE_CONFIG: EventQuarantineConfig = {
  maxCapacity: 10_000,
  maxReplayAttempts: 5,
};

let quarantineMetricsCounter: Counter<string> | null = null;

/** Initialize the `event_quarantine_operations_total` counter (idempotent). */
export function initializeEventQuarantineMetrics(registry: Registry): void {
  if (quarantineMetricsCounter) return;
  quarantineMetricsCounter = new Counter({
    name: 'event_quarantine_operations_total',
    help: 'Total number of event quarantine operations',
    labelNames: ['operation'] as const,
    registers: [registry],
  });
}

export function resetEventQuarantineMetrics(): void {
  quarantineMetricsCounter = null;
}

function incrementQuarantineMetric(operation: string): void {
  quarantineMetricsCounter?.inc({ operation });
}

/**
 * SQLite-backed event quarantine store. Uses the shared
 * `DatabaseConstructor` helper so the environment's native/mock binding is
 * honored (including the in-memory fallback under test).
 */
export class EventQuarantineStorage {
  private db: ReturnType<typeof DatabaseConstructor>;
  private config: EventQuarantineConfig;

  constructor(dbPath?: string, config: Partial<EventQuarantineConfig> = {}) {
    const resolvedPath =
      dbPath ||
      process.env.EVENT_QUARANTINE_PATH ||
      path.join(process.cwd(), 'data', 'event-quarantine.db');
    this.db = new DatabaseConstructor(resolvedPath);
    this.config = { ...DEFAULT_QUARANTINE_CONFIG, ...config };
    this.initialize();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS event_quarantine (
        id TEXT PRIMARY KEY,
        contract_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        schema_version INTEGER,
        event_type TEXT NOT NULL,
        payload TEXT NOT NULL,
        reason TEXT NOT NULL,
        quarantined_at TEXT NOT NULL,
        replayed_at TEXT,
        replay_attempts INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    this.db.exec(
      'CREATE INDEX IF NOT EXISTS idx_event_quarantine_contract_id ON event_quarantine(contract_id)',
    );
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS idx_event_quarantine_quarantined_at ON event_quarantine(quarantined_at)',
    );
  }

  /**
   * Add a quarantined event. The payload is redacted before persistence and
   * the reason sanitized so neither secrets nor stack details are stored.
   */
  addEntry(input: {
    contractId: string;
    eventId: string;
    sequence: number;
    schemaVersion?: number;
    eventType: string;
    payload: unknown;
    reason: string;
  }): string {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    const pendingCount = this.getPendingCount();
    if (pendingCount >= this.config.maxCapacity) {
      this.evictOldest();
      incrementQuarantineMetric('drop_overflow');
    }

    const redactedPayload = redactPayload(input.payload);
    const safeReason = sanitizeErrorMessage(input.reason, 'event_quarantine');

    const stmt = this.db.prepare(`
      INSERT INTO event_quarantine (
        id, contract_id, event_id, sequence, schema_version, event_type,
        payload, reason, quarantined_at, replay_attempts, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      input.contractId,
      input.eventId,
      input.sequence,
      input.schemaVersion ?? null,
      input.eventType,
      JSON.stringify(redactedPayload),
      safeReason,
      now,
      0,
      now,
      now,
    );
    incrementQuarantineMetric('enqueue');

    return id;
  }

  private getPendingCount(): number {
    const stmt = this.db.prepare(
      'SELECT COUNT(*) as count FROM event_quarantine WHERE replayed_at IS NULL',
    );
    return (stmt.get() as { count: number }).count;
  }

  private evictOldest(): void {
    const stmt = this.db.prepare(`
      DELETE FROM event_quarantine
      WHERE id = (
        SELECT id FROM event_quarantine
        WHERE replayed_at IS NULL
        ORDER BY quarantined_at ASC
        LIMIT 1
      )
    `);
    stmt.run();
  }

  getEntry(id: string): QuarantinedEventEntry | null {
    const stmt = this.db.prepare('SELECT * FROM event_quarantine WHERE id = ?');
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    return row ? this.mapRowToEntry(row) : null;
  }

  /** Return the stored (redacted) event payload plus identity fields. */
  getPayload(id: string): {
    contractId: string;
    eventId: string;
    sequence: number;
    schemaVersion?: number;
    eventType: string;
    payload: Record<string, unknown>;
  } | null {
    const entry = this.getEntry(id);
    if (!entry) return null;
    return {
      contractId: entry.contractId,
      eventId: entry.eventId,
      sequence: entry.sequence,
      schemaVersion: entry.schemaVersion,
      eventType: entry.eventType,
      payload: entry.payload,
    };
  }

  listEntries(query: EventQuarantineQuery = {}): QuarantinedEventEntry[] {
    const { limit = 50, offset = 0, contractId, eventType } = query;

    let sql = 'SELECT * FROM event_quarantine WHERE 1=1';
    const params: unknown[] = [];

    if (contractId) {
      sql += ' AND contract_id = ?';
      params.push(contractId);
    }
    if (eventType) {
      sql += ' AND event_type = ?';
      params.push(eventType);
    }

    sql += ' ORDER BY quarantined_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map((row) => this.mapRowToEntry(row));
  }

  incrementReplayAttempts(id: string): { success: boolean; attempts: number; maxExceeded: boolean } {
    const entry = this.getEntry(id);
    if (!entry) {
      return { success: false, attempts: 0, maxExceeded: false };
    }

    const newAttempts = entry.replayAttempts + 1;
    const maxExceeded = newAttempts >= this.config.maxReplayAttempts;
    const now = new Date().toISOString();
    this.db
      .prepare('UPDATE event_quarantine SET replay_attempts = ?, updated_at = ? WHERE id = ?')
      .run(newAttempts, now, id);
    incrementQuarantineMetric('replay_attempt');

    return { success: true, attempts: newAttempts, maxExceeded };
  }

  markReplayed(id: string): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .prepare('UPDATE event_quarantine SET replayed_at = ?, updated_at = ? WHERE id = ?')
      .run(now, now, id);
    return result.changes > 0;
  }

  getStats(): { total: number; pending: number; replayed: number } {
    const totalStmt = this.db.prepare('SELECT COUNT(*) as count FROM event_quarantine');
    const pendingStmt = this.db.prepare(
      'SELECT COUNT(*) as count FROM event_quarantine WHERE replayed_at IS NULL',
    );
    const replayedStmt = this.db.prepare(
      'SELECT COUNT(*) as count FROM event_quarantine WHERE replayed_at IS NOT NULL',
    );

    return {
      total: (totalStmt.get() as { count: number }).count,
      pending: (pendingStmt.get() as { count: number }).count,
      replayed: (replayedStmt.get() as { count: number }).count,
    };
  }

  close(): void {
    this.db.close();
  }

  private mapRowToEntry(row: Record<string, unknown>): QuarantinedEventEntry {
    return {
      id: row.id as string,
      contractId: row.contract_id as string,
      eventId: row.event_id as string,
      sequence: row.sequence as number,
      schemaVersion: row.schema_version === null ? undefined : (row.schema_version as number),
      eventType: row.event_type as string,
      payload: JSON.parse(row.payload as string) as Record<string, unknown>,
      reason: row.reason as string,
      quarantinedAt: row.quarantined_at as string,
      replayedAt: row.replayed_at as string | undefined,
      replayAttempts: (row.replay_attempts as number) ?? 0,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }
}

let instance: EventQuarantineStorage | null = null;

export function getEventQuarantineStorage(dbPath?: string): EventQuarantineStorage {
  if (!instance) {
    if (process.env.NODE_ENV === 'test') {
      instance = new EventQuarantineStorage(dbPath ?? ':memory:');
    } else {
      instance = new EventQuarantineStorage(dbPath);
    }
  }
  return instance;
}

export function clearEventQuarantineInstance(): void {
  if (instance) {
    instance.close();
    instance = null;
  }
}

export { DEFAULT_QUARANTINE_CONFIG };
