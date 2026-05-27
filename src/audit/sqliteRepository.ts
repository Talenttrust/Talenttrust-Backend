import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import { computeEntryHash, GENESIS_HASH } from './store';
import type { AuditEntry, AuditQuery, CreateAuditEntryInput, IntegrityReport } from './types';
import type { AuditLogRepository } from './repository';

interface AuditRow {
  id: string;
  timestamp: string;
  action: AuditEntry['action'];
  severity: AuditEntry['severity'];
  actor: string;
  resource: string;
  resource_id: string;
  metadata_json: string;
  ip_address: string | null;
  correlation_id: string | null;
  hash: string;
  previous_hash: string;
}

function toAuditEntry(row: AuditRow): AuditEntry {
  return Object.freeze({
    id: row.id,
    timestamp: row.timestamp,
    action: row.action,
    severity: row.severity,
    actor: row.actor,
    resource: row.resource,
    resourceId: row.resource_id,
    metadata: Object.freeze(JSON.parse(row.metadata_json) as Record<string, unknown>),
    ipAddress: row.ip_address ?? undefined,
    correlationId: row.correlation_id ?? undefined,
    hash: row.hash,
    previousHash: row.previous_hash,
  });
}

export class SqliteAuditRepository implements AuditLogRepository {
  constructor(private readonly db: Database.Database) {
    this.initSchema();
  }

  append(input: CreateAuditEntryInput): AuditEntry {
    const insert = this.db.transaction((payload: CreateAuditEntryInput): AuditEntry => {
      const previousHashRow = this.db
        .prepare<[], { hash: string }>(
          'SELECT hash FROM audit_log_entries ORDER BY seq DESC LIMIT 1'
        )
        .get();

      const partial: Omit<AuditEntry, 'hash'> = {
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        action: payload.action,
        severity: payload.severity,
        actor: payload.actor,
        resource: payload.resource,
        resourceId: payload.resourceId,
        metadata: Object.freeze({ ...payload.metadata }),
        ipAddress: payload.ipAddress,
        correlationId: payload.correlationId,
        previousHash: previousHashRow?.hash ?? GENESIS_HASH,
      };

      const entry: AuditEntry = Object.freeze({
        ...partial,
        hash: computeEntryHash(partial),
      });

      this.db
        .prepare<
          [string, string, string, string, string, string, string, string, string | null, string | null, string, string]
        >(
          `INSERT INTO audit_log_entries
           (id, timestamp, action, severity, actor, resource, resource_id, metadata_json, ip_address, correlation_id, hash, previous_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          entry.id,
          entry.timestamp,
          entry.action,
          entry.severity,
          entry.actor,
          entry.resource,
          entry.resourceId,
          JSON.stringify(entry.metadata),
          entry.ipAddress ?? null,
          entry.correlationId ?? null,
          entry.hash,
          entry.previousHash
        );

      return entry;
    });

    return insert(input);
  }

  getById(id: string): AuditEntry | undefined {
    const row = this.db
      .prepare<[string], AuditRow>(
        `SELECT id, timestamp, action, severity, actor, resource, resource_id, metadata_json, ip_address, correlation_id, hash, previous_hash
         FROM audit_log_entries
         WHERE id = ?`
      )
      .get(id);

    return row ? toAuditEntry(row) : undefined;
  }

  query(query: AuditQuery = {}): AuditEntry[] {
    const { sql, params } = this.buildQuerySql(query);
    const rows = this.db.prepare<typeof params, AuditRow>(sql).all(...params);
    return rows.map(toAuditEntry);
  }

  *stream(query: AuditQuery = {}): IterableIterator<AuditEntry> {
    const { sql, params } = this.buildQuerySql(query);
    const cursor = this.db.prepare<typeof params, AuditRow>(sql).iterate(...params);
    for (const row of cursor) {
      yield toAuditEntry(row);
    }
  }

  count(): number {
    const row = this.db
      .prepare<[], { total: number }>('SELECT COUNT(*) AS total FROM audit_log_entries')
      .get();
    return row?.total ?? 0;
  }

  verifyIntegrity(): IntegrityReport {
    const checkedAt = new Date().toISOString();
    const rows = this.db
      .prepare<[], AuditRow>(
        `SELECT id, timestamp, action, severity, actor, resource, resource_id, metadata_json, ip_address, correlation_id, hash, previous_hash
         FROM audit_log_entries
         ORDER BY seq ASC`
      )
      .all();

    if (rows.length === 0) {
      return { valid: true, totalEntries: 0, checkedAt };
    }

    let previousHash = GENESIS_HASH;
    for (let index = 0; index < rows.length; index += 1) {
      const entry = toAuditEntry(rows[index]);

      if (entry.previousHash !== previousHash) {
        return {
          valid: false,
          totalEntries: rows.length,
          firstCorruptedIndex: index,
          firstCorruptedId: entry.id,
          checkedAt,
        };
      }

      const { hash, ...rest } = entry;
      const expectedHash = computeEntryHash(rest);
      if (hash !== expectedHash) {
        return {
          valid: false,
          totalEntries: rows.length,
          firstCorruptedIndex: index,
          firstCorruptedId: entry.id,
          checkedAt,
        };
      }

      previousHash = entry.hash;
    }

    return { valid: true, totalEntries: rows.length, checkedAt };
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_log_entries (
        seq            INTEGER PRIMARY KEY AUTOINCREMENT,
        id             TEXT    NOT NULL UNIQUE,
        timestamp      TEXT    NOT NULL,
        action         TEXT    NOT NULL,
        severity       TEXT    NOT NULL,
        actor          TEXT    NOT NULL,
        resource       TEXT    NOT NULL,
        resource_id    TEXT    NOT NULL,
        metadata_json  TEXT    NOT NULL,
        ip_address     TEXT,
        correlation_id TEXT,
        hash           TEXT    NOT NULL,
        previous_hash  TEXT    NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log_entries(timestamp);
      CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log_entries(action);
      CREATE INDEX IF NOT EXISTS idx_audit_severity ON audit_log_entries(severity);
      CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log_entries(actor);
      CREATE INDEX IF NOT EXISTS idx_audit_resource ON audit_log_entries(resource, resource_id);
    `);
  }

  private buildQuerySql(query: AuditQuery): { sql: string; params: unknown[] } {
    const where: string[] = [];
    const params: unknown[] = [];

    if (query.action) {
      where.push('action = ?');
      params.push(query.action);
    }
    if (query.severity) {
      where.push('severity = ?');
      params.push(query.severity);
    }
    if (query.actor) {
      where.push('actor = ?');
      params.push(query.actor);
    }
    if (query.resource) {
      where.push('resource = ?');
      params.push(query.resource);
    }
    if (query.resourceId) {
      where.push('resource_id = ?');
      params.push(query.resourceId);
    }
    if (query.from) {
      where.push('timestamp >= ?');
      params.push(query.from);
    }
    if (query.to) {
      where.push('timestamp <= ?');
      params.push(query.to);
    }

    const offset = Math.max(query.offset ?? 0, 0);
    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    let paginationClause = '';
    if (query.limit !== undefined) {
      paginationClause = 'LIMIT ? OFFSET ?';
      params.push(Math.max(query.limit, 0), offset);
    } else if (offset > 0) {
      paginationClause = 'LIMIT -1 OFFSET ?';
      params.push(offset);
    }

    const sql = `
      SELECT id, timestamp, action, severity, actor, resource, resource_id, metadata_json, ip_address, correlation_id, hash, previous_hash
      FROM audit_log_entries
      ${whereClause}
      ORDER BY seq ASC
      ${paginationClause}
    `;
    return { sql, params };
  }
}
