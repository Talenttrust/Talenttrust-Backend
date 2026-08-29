/**
 * SQLite-backed storage for the collections that previously lived in
 * `data/database.json`.
 *
 * Scope note: only `contract_metadata` and `api_keys` are handled here.
 * `contracts` and `users` are intentionally excluded because `src/db/types.ts`
 * already defines *different* `Contract` and `User` shapes, and the SQLite
 * `contracts` / `users` tables are built for that model (title, clientId,
 * amount, version / username, password_hash). Writing the JSON-shaped records
 * into those tables would silently corrupt them. See
 * `docs/persistence-json-to-sqlite.md`.
 *
 * Schema handling follows the pattern already used by `src/audit/sqliteRepository.ts`,
 * `src/events/idempotencyStore.ts` and `src/queue/webhook-dlq.ts`: the store
 * owns an idempotent `CREATE TABLE IF NOT EXISTS` bootstrap rather than adding
 * an entry to the checksummed registry in `src/db/migrations.ts`.
 *
 * All statements use parameter binding; no SQL is built by string interpolation.
 */

import { getDb } from '../db/database';
import type { ContractMetadata, ApiKey } from './schema';

/** better-sqlite3 stores booleans as INTEGER. */
function toInt(value: boolean): number {
  return value ? 1 : 0;
}

function fromInt(value: number): boolean {
  return value === 1;
}

/** Dates round-trip as ISO-8601 TEXT so ordering is lexicographic and stable. */
function toIso(value: Date | string | undefined | null): string | null {
  if (value === undefined || value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function fromIso(value: string | null): Date | undefined {
  return value === null ? undefined : new Date(value);
}

interface ContractMetadataRow {
  id: string;
  contract_id: string;
  key: string;
  value: string;
  data_type: string;
  is_sensitive: number;
  created_by: string;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

interface ApiKeyRow {
  id: string;
  name: string;
  key_hash: string;
  key_selector: string | null;
  scope: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  is_active: number;
}

function mapMetadata(row: ContractMetadataRow): ContractMetadata {
  const record: ContractMetadata = {
    id: row.id,
    contract_id: row.contract_id,
    key: row.key,
    value: row.value,
    data_type: row.data_type as ContractMetadata['data_type'],
    is_sensitive: fromInt(row.is_sensitive),
    created_by: row.created_by,
    created_at: new Date(row.created_at),
    updated_at: new Date(row.updated_at),
  };
  if (row.updated_by !== null) record.updated_by = row.updated_by;
  const deletedAt = fromIso(row.deleted_at);
  if (deletedAt) record.deleted_at = deletedAt;
  return record;
}

function mapApiKey(row: ApiKeyRow): ApiKey {
  const key: ApiKey = {
    id: row.id,
    name: row.name,
    key_hash: row.key_hash,
    scope: JSON.parse(row.scope) as string[],
    created_by: row.created_by,
    created_at: new Date(row.created_at),
    updated_at: new Date(row.updated_at),
    is_active: fromInt(row.is_active),
  };
  if (row.key_selector !== null) key.key_selector = row.key_selector;
  const expiresAt = fromIso(row.expires_at);
  if (expiresAt) key.expires_at = expiresAt;
  const lastUsedAt = fromIso(row.last_used_at);
  if (lastUsedAt) key.last_used_at = lastUsedAt;
  return key;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

export class SqliteMetadataStore {
  private readonly db: Db;

  constructor(db?: Db) {
    this.db = db ?? getDb();
    this.initSchema();
  }

  /**
   * Idempotent schema bootstrap. Safe to call on every construction.
   *
   * No FOREIGN KEY on `created_by`: those ids still point at JSON-backed users,
   * and `foreign_keys = ON` is set globally in `src/db/database.ts`, so a real
   * constraint here would reject every insert.
   */
  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS contract_metadata (
        id           TEXT    PRIMARY KEY,
        contract_id  TEXT    NOT NULL,
        key          TEXT    NOT NULL,
        value        TEXT    NOT NULL,
        data_type    TEXT    NOT NULL,
        is_sensitive INTEGER NOT NULL DEFAULT 0,
        created_by   TEXT    NOT NULL,
        updated_by   TEXT,
        created_at   TEXT    NOT NULL,
        updated_at   TEXT    NOT NULL,
        deleted_at   TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_contract_metadata_lookup
        ON contract_metadata (contract_id, created_at DESC, id);

      CREATE INDEX IF NOT EXISTS idx_contract_metadata_key
        ON contract_metadata (contract_id, key);

      CREATE TABLE IF NOT EXISTS api_keys (
        id           TEXT    PRIMARY KEY,
        name         TEXT    NOT NULL,
        key_hash     TEXT    NOT NULL,
        key_selector TEXT,
        scope        TEXT    NOT NULL,
        created_by   TEXT    NOT NULL,
        created_at   TEXT    NOT NULL,
        updated_at   TEXT    NOT NULL,
        expires_at   TEXT,
        last_used_at TEXT,
        is_active    INTEGER NOT NULL DEFAULT 1
      );

      CREATE INDEX IF NOT EXISTS idx_api_keys_owner
        ON api_keys (created_by, is_active, created_at DESC, id DESC);

      CREATE INDEX IF NOT EXISTS idx_api_keys_selector
        ON api_keys (key_selector);

      CREATE INDEX IF NOT EXISTS idx_api_keys_hash
        ON api_keys (key_hash);
    `);
  }

  // -------------------------------------------------------------------------
  // Contract metadata
  // -------------------------------------------------------------------------

  insertMetadata(record: ContractMetadata): ContractMetadata {
    this.db
      .prepare(
        `INSERT INTO contract_metadata
           (id, contract_id, key, value, data_type, is_sensitive,
            created_by, updated_by, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.id,
        record.contract_id,
        record.key,
        record.value,
        record.data_type,
        toInt(record.is_sensitive),
        record.created_by,
        record.updated_by ?? null,
        toIso(record.created_at),
        toIso(record.updated_at),
        toIso(record.deleted_at)
      );
    return record;
  }

  findMetadataById(id: string): ContractMetadata | null {
    const row = this.db
      .prepare(
        `SELECT * FROM contract_metadata WHERE id = ? AND deleted_at IS NULL`
      )
      .get(id) as ContractMetadataRow | undefined;
    return row ? mapMetadata(row) : null;
  }

  findMetadataByKey(contractId: string, key: string): ContractMetadata | null {
    const row = this.db
      .prepare(
        `SELECT * FROM contract_metadata
          WHERE contract_id = ? AND key = ? AND deleted_at IS NULL`
      )
      .get(contractId, key) as ContractMetadataRow | undefined;
    return row ? mapMetadata(row) : null;
  }

  /**
   * Offset-paginated metadata for a contract.
   *
   * Ordering mirrors the previous in-memory sort exactly: newest first, with id
   * ascending as the tie-breaker so pages are absolutely stable.
   */
  listMetadata(
    contractId: string,
    options: {
      offset: number;
      limit: number;
      key?: string;
      dataType?: string;
      includeDeleted: boolean;
    }
  ): { records: ContractMetadata[]; total: number } {
    const clauses = ['contract_id = ?'];
    const params: Array<string | number> = [contractId];

    if (!options.includeDeleted) clauses.push('deleted_at IS NULL');
    if (options.key !== undefined) {
      clauses.push('key = ?');
      params.push(options.key);
    }
    if (options.dataType !== undefined) {
      clauses.push('data_type = ?');
      params.push(options.dataType);
    }

    const where = clauses.join(' AND ');

    const { total } = this.db
      .prepare(`SELECT COUNT(*) AS total FROM contract_metadata WHERE ${where}`)
      .get(...params) as { total: number };

    const rows = this.db
      .prepare(
        `SELECT * FROM contract_metadata
          WHERE ${where}
          ORDER BY created_at DESC, id ASC
          LIMIT ? OFFSET ?`
      )
      .all(...params, options.limit, options.offset) as ContractMetadataRow[];

    return { records: rows.map(mapMetadata), total };
  }

  updateMetadata(
    id: string,
    updates: Partial<Pick<ContractMetadata, 'value' | 'is_sensitive' | 'updated_by'>>,
    updatedAt: Date
  ): ContractMetadata | null {
    const existing = this.findMetadataById(id);
    if (!existing) return null;

    const merged: ContractMetadata = { ...existing, ...updates, updated_at: updatedAt };

    this.db
      .prepare(
        `UPDATE contract_metadata
            SET value = ?, is_sensitive = ?, updated_by = ?, updated_at = ?
          WHERE id = ? AND deleted_at IS NULL`
      )
      .run(
        merged.value,
        toInt(merged.is_sensitive),
        merged.updated_by ?? null,
        toIso(merged.updated_at),
        id
      );

    return merged;
  }

  softDeleteMetadata(id: string, when: Date): boolean {
    const result = this.db
      .prepare(
        `UPDATE contract_metadata
            SET deleted_at = ?, updated_at = ?
          WHERE id = ? AND deleted_at IS NULL`
      )
      .run(toIso(when), toIso(when), id) as { changes: number };
    return result.changes > 0;
  }

  // -------------------------------------------------------------------------
  // API keys
  // -------------------------------------------------------------------------

  insertApiKey(key: ApiKey): ApiKey {
    this.db
      .prepare(
        `INSERT INTO api_keys
           (id, name, key_hash, key_selector, scope, created_by,
            created_at, updated_at, expires_at, last_used_at, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        key.id,
        key.name,
        key.key_hash,
        key.key_selector ?? null,
        JSON.stringify(key.scope ?? []),
        key.created_by,
        toIso(key.created_at),
        toIso(key.updated_at),
        toIso(key.expires_at),
        toIso(key.last_used_at),
        toInt(key.is_active)
      );
    return key;
  }

  findApiKeyById(id: string, activeOnly = true): ApiKey | null {
    const sql = activeOnly
      ? `SELECT * FROM api_keys WHERE id = ? AND is_active = 1`
      : `SELECT * FROM api_keys WHERE id = ?`;
    const row = this.db.prepare(sql).get(id) as ApiKeyRow | undefined;
    return row ? mapApiKey(row) : null;
  }

  findActiveApiKeyBy(column: 'key_hash' | 'key_selector', value: string): ApiKey | null {
    // `column` is constrained by its union type, never caller-supplied text,
    // so this template cannot be used for injection.
    const row = this.db
      .prepare(`SELECT * FROM api_keys WHERE ${column} = ? AND is_active = 1`)
      .get(value) as ApiKeyRow | undefined;
    return row ? mapApiKey(row) : null;
  }

  /**
   * Cursor page of active keys for an owner, newest first.
   * Fetches `limit + 1` rows so the caller can detect a further page without a
   * second COUNT query.
   */
  listApiKeysAfter(
    userId: string,
    limit: number,
    cursor: { createdAt: string; id: string } | null
  ): ApiKey[] {
    if (cursor) {
      const rows = this.db
        .prepare(
          `SELECT * FROM api_keys
            WHERE created_by = ? AND is_active = 1
              AND (created_at < ? OR (created_at = ? AND id < ?))
            ORDER BY created_at DESC, id DESC
            LIMIT ?`
        )
        .all(userId, cursor.createdAt, cursor.createdAt, cursor.id, limit + 1) as ApiKeyRow[];
      return rows.map(mapApiKey);
    }

    const rows = this.db
      .prepare(
        `SELECT * FROM api_keys
          WHERE created_by = ? AND is_active = 1
          ORDER BY created_at DESC, id DESC
          LIMIT ?`
      )
      .all(userId, limit + 1) as ApiKeyRow[];
    return rows.map(mapApiKey);
  }

  updateApiKey(
    id: string,
    updates: Partial<
      Pick<ApiKey, 'name' | 'scope' | 'expires_at' | 'is_active' | 'last_used_at' | 'key_selector'>
    >,
    updatedAt: Date
  ): ApiKey | null {
    const existing = this.findApiKeyById(id, false);
    if (!existing) return null;

    const merged: ApiKey = { ...existing, ...updates, updated_at: updatedAt };

    this.db
      .prepare(
        `UPDATE api_keys
            SET name = ?, scope = ?, expires_at = ?, last_used_at = ?,
                key_selector = ?, is_active = ?, updated_at = ?
          WHERE id = ?`
      )
      .run(
        merged.name,
        JSON.stringify(merged.scope ?? []),
        toIso(merged.expires_at),
        toIso(merged.last_used_at),
        merged.key_selector ?? null,
        toInt(merged.is_active),
        toIso(merged.updated_at),
        id
      );

    return merged;
  }

  setApiKeyActive(id: string, isActive: boolean, when: Date): boolean {
    const result = this.db
      .prepare(`UPDATE api_keys SET is_active = ?, updated_at = ? WHERE id = ?`)
      .run(toInt(isActive), toIso(when), id) as { changes: number };
    return result.changes > 0;
  }

  rotateApiKey(
    id: string,
    newKeyHash: string,
    newKeySelector: string | undefined,
    when: Date
  ): ApiKey | null {
    const existing = this.findApiKeyById(id, false);
    if (!existing) return null;

    const selector = newKeySelector !== undefined ? newKeySelector : existing.key_selector ?? null;

    this.db
      .prepare(
        `UPDATE api_keys SET key_hash = ?, key_selector = ?, updated_at = ? WHERE id = ?`
      )
      .run(newKeyHash, selector, toIso(when), id);

    return this.findApiKeyById(id, false);
  }

  countApiKeysWithoutSelector(): number {
    const { total } = this.db
      .prepare(
        `SELECT COUNT(*) AS total FROM api_keys
          WHERE key_selector IS NULL OR key_selector = ''`
      )
      .get() as { total: number };
    return total;
  }

  // -------------------------------------------------------------------------
  // Maintenance
  // -------------------------------------------------------------------------

  /**
   * One-shot import of legacy JSON records.
   *
   * Runs inside a transaction and uses INSERT OR IGNORE keyed on the primary
   * key, so re-running it is harmless and never duplicates or overwrites rows.
   * Returns the number of rows actually inserted.
   */
  importFromJson(data: {
    contract_metadata?: ContractMetadata[];
    api_keys?: ApiKey[];
  }): { metadata: number; apiKeys: number } {
    const metadataRows = data.contract_metadata ?? [];
    const apiKeyRows = data.api_keys ?? [];

    const insertMetadata = this.db.prepare(
      `INSERT OR IGNORE INTO contract_metadata
         (id, contract_id, key, value, data_type, is_sensitive,
          created_by, updated_by, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    const insertApiKey = this.db.prepare(
      `INSERT OR IGNORE INTO api_keys
         (id, name, key_hash, key_selector, scope, created_by,
          created_at, updated_at, expires_at, last_used_at, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    let metadata = 0;
    let apiKeys = 0;

    const run = this.db.transaction(() => {
      for (const record of metadataRows) {
        const result = insertMetadata.run(
          record.id,
          record.contract_id,
          record.key,
          record.value,
          record.data_type,
          toInt(record.is_sensitive),
          record.created_by,
          record.updated_by ?? null,
          toIso(record.created_at),
          toIso(record.updated_at),
          toIso(record.deleted_at)
        ) as { changes: number };
        metadata += result.changes;
      }

      for (const key of apiKeyRows) {
        const result = insertApiKey.run(
          key.id,
          key.name,
          key.key_hash,
          key.key_selector ?? null,
          JSON.stringify(key.scope ?? []),
          key.created_by,
          toIso(key.created_at),
          toIso(key.updated_at),
          toIso(key.expires_at),
          toIso(key.last_used_at),
          toInt(key.is_active)
        ) as { changes: number };
        apiKeys += result.changes;
      }
    });

    run();

    return { metadata, apiKeys };
  }

  /** Removes every migrated row. Used by tests. */
  clear(): void {
    this.db.exec('DELETE FROM contract_metadata; DELETE FROM api_keys;');
  }
}

let sharedStore: SqliteMetadataStore | null = null;

/** Lazily-created shared store, so importing this module opens no connection. */
export function getMetadataStore(): SqliteMetadataStore {
  if (!sharedStore) {
    sharedStore = new SqliteMetadataStore();
  }
  return sharedStore;
}

/** Test hook: swap in a store backed by an in-memory database. */
export function setMetadataStore(store: SqliteMetadataStore | null): void {
  sharedStore = store;
}
