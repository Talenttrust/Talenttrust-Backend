/**
 * Storage abstraction layer for retained data
 *
 * Provides a flexible interface for storing, retrieving, and managing
 * retained data with support for different storage backends.
 *
 * @module retention/storage
 */

import { RetainedData, ArchivalStorageType, DataClassification } from './types';
import Database from '../db/betterSqlite3';
import type * as BetterSqlite3 from 'better-sqlite3';
import { getDb } from '../db/database';

/**
 * Maximum records returned by a single bounded `listPaginated` call.
 * The bound protects callers from accidentally materialising an entire
 * archive into memory and matches the conservative cap used elsewhere
 * in the codbase ({@link database.getContractMetadataByContractId}).
 */
export const RETENTION_PAGE_MAX_LIMIT = 1000;

/**
 * Abstract storage provider interface
 *
 * Allows implementation of different storage backends (local, cloud, encrypted, etc.)
 *
 * @interface IStorageProvider
 */
export interface IStorageProvider {
  /**
   * Store a data entity
   * @param {RetainedData} data - Data to store
   * @returns {Promise<string>} Storage location/ID
   */
  store(data: RetainedData): Promise<string>;

  /**
   * Retrieve stored data
   * @param {string} id - Data identifier
   * @returns {Promise<RetainedData | null>} Retrieved data or null if not found
   */
  retrieve(id: string): Promise<RetainedData | null>;

  /**
   * Delete stored data
   * @param {string} id - Data identifier
   * @returns {Promise<boolean>} Success status
   */
  delete(id: string): Promise<boolean>;

  /**
   * List all stored data
   * @returns {Promise<RetainedData[]>} All stored data
   */
  list(): Promise<RetainedData[]>;

  /**
   * Bounded/paginated list of stored data ordered by `created_at` then `id`,
   * giving callers a stable cursor across pages.
   *
   * @param {number} limit - Maximum records to return. Values <= 0 are clamped up
   *   to 1; values above {@link RETENTION_PAGE_MAX_LIMIT} are clamped down.
   * @param {number} [offset=0] - Records to skip before the first result.
   *   Negative offsets are clamped to 0.
   * @returns {Promise<RetainedData[]>} A page of stored data.
   */
  listPaginated(limit: number, offset?: number): Promise<RetainedData[]>;

  /**
   * Check if data exists
   * @param {string} id - Data identifier
   * @returns {Promise<boolean>} Existence status
   */
  exists(id: string): Promise<boolean>;
}

/**
 * In-memory storage provider implementation
 *
 * Suitable for development, testing, and small-scale deployments.
 * Data is stored in application memory.
 *
 * @class InMemoryStorageProvider
 * @implements {IStorageProvider}
 */
export class InMemoryStorageProvider implements IStorageProvider {
  private storage: Map<string, RetainedData> = new Map();

  /**
   * Store data in memory
   * @param {RetainedData} data - Data to store
   * @returns {Promise<string>} Data ID
   */
  async store(data: RetainedData): Promise<string> {
    this.storage.set(data.id, { ...data });
    return data.id;
  }

  /**
   * Retrieve data from memory
   * @param {string} id - Data identifier
   * @returns {Promise<RetainedData | null>}
   */
  async retrieve(id: string): Promise<RetainedData | null> {
    return this.storage.get(id) || null;
  }

  /**
   * Delete data from memory
   * @param {string} id - Data identifier
   * @returns {Promise<boolean>}
   */
  async delete(id: string): Promise<boolean> {
    return this.storage.delete(id);
  }

  /**
   * List all data in memory
   * @returns {Promise<RetainedData[]>}
   */
  async list(): Promise<RetainedData[]> {
    return Array.from(this.storage.values());
  }

  /**
   * Bounded/paginated list backed by the in-memory map.
   *
   * Pagination uses the same ordering as {@link InMemoryStorageProvider.list}
   * (insertion order → conventionally `created_at` ascending) so call sites
   * share a stable cursor between full and paged reads.
   *
   * @inheritDoc IStorageProvider.listPaginated
   */
  async listPaginated(limit: number, offset: number = 0): Promise<RetainedData[]> {
    const boundedLimit = clampPageLimit(limit);
    const boundedOffset = Math.max(0, Math.floor(offset));
    return Array.from(this.storage.values()).slice(boundedOffset, boundedOffset + boundedLimit);
  }

  /**
   * Check if data exists
   * @param {string} id - Data identifier
   * @returns {Promise<boolean>}
   */
  async exists(id: string): Promise<boolean> {
    return this.storage.has(id);
  }

  /**
   * Clear all data (useful for testing)
   * @returns {void}
   */
  clear(): void {
    this.storage.clear();
  }

  /**
   * Get storage size
   * @returns {number}
   */
  size(): number {
    return this.storage.size;
  }
}

/**
 * Options accepted by {@link SqliteStorageProvider}.
 *
 * @interface SqliteStorageProviderOptions
 * @property {string} tableName - SQLite table that backs this provider. Each
 *   provider instance must use a distinct table (the migration creates
 *   `retention_local` and `retention_archive`); using the same table for
 *   two providers will cause them to silently alias and reuse each other's
 *   rows.
 * @property {BetterSqlite3.Database} [db] - Optional explicit database handle.
 *   When omitted, the singleton from {@link getDb} is used. Tests typically
 *   pass a `:memory:` database for isolation.
 */
export interface SqliteStorageProviderOptions {
  tableName: string;
  db?: BetterSqlite3.Database;
}

/**
 * Row shape persisted by {@link SqliteStorageProvider}. Mirrors the
 * `RetainedData` columns with `Date` fields serialised as ISO-8601 strings
 * and the `data` / `metadata` payloads as JSON.
 *
 * @private
 */
interface RetentionRow {
  id: string;
  entity_type: string;
  data: string;
  classification: string;
  created_at: string;
  expires_at: string;
  archived_at: string | null;
  archived_location: string | null;
  is_archived: number;
  retention_policy_id: string | null;
  metadata: string | null;
  updated_at: string;
}

/**
 * SQLite-backed {@link IStorageProvider} used by default for the retention
 * manager in non-test environments.
 *
 * Records survive process restarts (the underlying file is durable), writes
 * are atomic via SQLite's per-statement transaction model, and reads are
 * bounded through {@link SqliteStorageProvider.listPaginated}.
 *
 * @class SqliteStorageProvider
 * @implements {IStorageProvider}
 *
 * @example
 *   // Provider for the local retention bucket
 *   const local = new SqliteStorageProvider({ tableName: 'retention_local' });
 *   await local.store(myRetainedData);
 *
 * @example
 *   // Test-only ephemeral provider that never touches the global DB
 *   import BetterSqlite3 from '../db/betterSqlite3';
 *   const db = new BetterSqlite3(':memory:');
 *   const provider = new SqliteStorageProvider({ tableName: 'retention_local', db });
 */
export class SqliteStorageProvider implements IStorageProvider {
  private readonly db: BetterSqlite3.Database;
  private readonly tableName: string;
  private readonly insertStmt: BetterSqlite3.Statement<[Record<string, unknown>]>;
  private readonly selectByIdStmt: BetterSqlite3.Statement<[string]>;
  private readonly deleteByIdStmt: BetterSqlite3.Statement<[string]>;
  private readonly selectAllStmt: BetterSqlite3.Statement<[]>;
  private readonly selectPageStmt: BetterSqlite3.Statement<[number, number]>;
  private readonly existsStmt: BetterSqlite3.Statement<[string]>;

  /**
   * Initialise a SQLite-backed retention provider.
   *
   * The constructor is synchronous and idempotent: `{tableName}` is ensured
   * via `CREATE TABLE IF NOT EXISTS`, so it is safe to instantiate during
   * module load and reuse.
   *
   * @param {SqliteStorageProviderOptions} options - Provider configuration.
   */
  constructor(options: SqliteStorageProviderOptions) {
    if (!options || !options.tableName || typeof options.tableName !== 'string') {
      throw new Error('SqliteStorageProvider requires a non-empty tableName option');
    }
    // Only allow identifier-shaped table names to defeat SQL injection via
    // the table name interpolation in CREATE / DML statements.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(options.tableName)) {
      throw new Error(`SqliteStorageProvider tableName must match /^[A-Za-z_][A-Za-z0-9_]*$/; got '${options.tableName}'`);
    }

    this.tableName = options.tableName;
    // `getDb()` is typed to return its constructor (a pre-existing quirk of
    // `src/db/database.ts`); at runtime the cached value is the database
    // instance, so we narrow with a one-shot cast here.
    this.db = options.db ?? (getDb() as unknown as BetterSqlite3.Database);
    this.ensureTable();

    // Cache prepared statements for the lifetime of the provider. Re-using
    // prepared statements is the primary performance win in better-sqlite3
    // and matches the pattern elsewhere in the codebase.
    this.insertStmt = this.db.prepare(
      `INSERT OR REPLACE INTO ${this.tableName} (
         id, entity_type, data, classification,
         created_at, expires_at, archived_at, archived_location,
         is_archived, retention_policy_id, metadata, updated_at
       ) VALUES (
         @id, @entity_type, @data, @classification,
         @created_at, @expires_at, @archived_at, @archived_location,
         @is_archived, @retention_policy_id, @metadata, @updated_at
       )`,
    );
    this.selectByIdStmt = this.db.prepare(
      `SELECT * FROM ${this.tableName} WHERE id = ?`,
    );
    this.deleteByIdStmt = this.db.prepare(
      `DELETE FROM ${this.tableName} WHERE id = ?`,
    );
    this.selectAllStmt = this.db.prepare(
      `SELECT * FROM ${this.tableName} ORDER BY created_at ASC, id ASC`,
    );
    this.selectPageStmt = this.db.prepare(
      `SELECT * FROM ${this.tableName} ORDER BY created_at ASC, id ASC LIMIT ? OFFSET ?`,
    );
    this.existsStmt = this.db.prepare(
      `SELECT 1 FROM ${this.tableName} WHERE id = ?`,
    );
  }

  /**
   * Returns the table name backing this provider. Exposed for tests and diagnostics.
   * @returns {string}
   */
  getTableName(): string {
    return this.tableName;
  }

  /**
   * Persist a single record. `INSERT OR REPLACE` makes repeated calls idempotent —
   * the second `store` with the same `data.id` overwrites the previous row rather
   * than producing a constraint error.
   *
   * @inheritDoc IStorageProvider.store
   */
  async store(data: RetainedData): Promise<string> {
    const now = new Date().toISOString();
    this.insertStmt.run({
      id: data.id,
      entity_type: data.entityType,
      data: JSON.stringify(data.data ?? null),
      classification: data.classification,    created_at: data.createdAt.toISOString(),
        expires_at: data.expiresAt.toISOString(),
        archived_at: data.archivedAt ? data.archivedAt.toISOString() : null,
      archived_location: data.archivedLocation ?? null,
      is_archived: data.isArchived ? 1 : 0,
      retention_policy_id: data.retentionPolicyId ?? null,
      metadata: data.metadata ? JSON.stringify(data.metadata) : null,
      updated_at: now,
    });
    return data.id;
  }

  /**
   * Fetch a record by id or `null` when no row matches.
   *
   * @inheritDoc IStorageProvider.retrieve
   */
  async retrieve(id: string): Promise<RetainedData | null> {
    const row = this.selectByIdStmt.get(id) as RetentionRow | undefined;
    if (!row) return null;
    return rowToRetainedData(row);
  }

  /**
   * Delete a record by id. Returns `true` when a row was actually removed.
   *
   * @inheritDoc IStorageProvider.delete
   */
  async delete(id: string): Promise<boolean> {
    const result = this.deleteByIdStmt.run(id);
    return result.changes > 0;
  }

  /**
   * List every record in insertion-order (created_at then id).
   *
   * Prefer {@link SqliteStorageProvider.listPaginated} for large archives;
   * this method materialises the full result set.
   *
   * @inheritDoc IStorageProvider.list
   */
  async list(): Promise<RetainedData[]> {
    const rows = this.selectAllStmt.all() as RetentionRow[];
    return rows.map(rowToRetainedData);
  }

  /**
   * Stable, bounded page read backed by `LIMIT`/`OFFSET`. The order matches
   * {@link SqliteStorageProvider.list} so pages compose into a deterministic
   * cursor across calls.
   *
   * @inheritDoc IStorageProvider.listPaginated
   */
  async listPaginated(limit: number, offset: number = 0): Promise<RetainedData[]> {
    const boundedLimit = clampPageLimit(limit);
    const boundedOffset = Math.max(0, Math.floor(offset));
    const rows = this.selectPageStmt.all(boundedLimit, boundedOffset) as RetentionRow[];
    return rows.map(rowToRetainedData);
  }

  /**
   * Cheap existence probe that avoids materialising the row.
   *
   * @inheritDoc IStorageProvider.exists
   */
  async exists(id: string): Promise<boolean> {
    const result = this.existsStmt.get(id);
    return result !== undefined;
  }

  /**
   * Make sure the underlying table exists. Mirrors the production migration
   * so unit tests can spin up an in-memory provider without running the full
   * migration set first.
   *
   * @private
   */
  private ensureTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${this.tableName} (
        id                    TEXT    PRIMARY KEY,
        entity_type           TEXT    NOT NULL,
        data                  TEXT    NOT NULL,
        classification        TEXT    NOT NULL,
        created_at            TEXT    NOT NULL,
        expires_at            TEXT    NOT NULL,
        archived_at           TEXT,
        archived_location     TEXT,
        is_archived           INTEGER NOT NULL CHECK (is_archived IN (0, 1)),
        retention_policy_id   TEXT,
        metadata              TEXT,
        updated_at            TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_${this.tableName}_entity_type
        ON ${this.tableName}(entity_type);
      CREATE INDEX IF NOT EXISTS idx_${this.tableName}_is_archived
        ON ${this.tableName}(is_archived);
      CREATE INDEX IF NOT EXISTS idx_${this.tableName}_expires_at
        ON ${this.tableName}(expires_at);
      CREATE INDEX IF NOT EXISTS idx_${this.tableName}_created_at
        ON ${this.tableName}(created_at);
    `);
  }
}

/**
 * Storage manager for handling multiple storage backends
 *
 * @class StorageManager
 */
export class StorageManager {
  private localProvider: IStorageProvider;
  private archiveProvider: IStorageProvider;

  /**
   * Initialize storage manager with providers
   * @param {IStorageProvider} [localProvider] - Local storage provider (defaults to in-memory)
   * @param {IStorageProvider} [archiveProvider] - Archive storage provider (defaults to in-memory)
   */
  constructor(
    localProvider?: IStorageProvider,
    archiveProvider?: IStorageProvider,
  ) {
    this.localProvider = localProvider || new InMemoryStorageProvider();
    this.archiveProvider = archiveProvider || new InMemoryStorageProvider();
  }

  /**
   * Store data with appropriate provider based on archival status
   * @param {RetainedData} data - Data to store
   * @param {ArchivalStorageType} [storageType='local'] - Storage type
   * @returns {Promise<string>} Storage location
   */
  async store(data: RetainedData, storageType: ArchivalStorageType = ArchivalStorageType.LOCAL): Promise<string> {
    const provider = this.getProvider(storageType);
    return provider.store(data);
  }

  /**
   * Retrieve data from appropriate storage
   * @param {string} id - Data identifier
   * @param {ArchivalStorageType} [storageType='local'] - Storage type
   * @returns {Promise<RetainedData | null>}
   */
  async retrieve(id: string, storageType: ArchivalStorageType = ArchivalStorageType.LOCAL): Promise<RetainedData | null> {
    const provider = this.getProvider(storageType);
    return provider.retrieve(id);
  }

  /**
   * Move data between storage types
   * @param {string} id - Data identifier
   * @param {ArchivalStorageType} fromType - Source storage type
   * @param {ArchivalStorageType} toType - Destination storage type
   * @returns {Promise<boolean>} Success status
   */
  async moveData(
    id: string,
    fromType: ArchivalStorageType,
    toType: ArchivalStorageType,
  ): Promise<boolean> {
    const data = await this.retrieve(id, fromType);
    if (!data) return false;

    const toProvider = this.getProvider(toType);
    const stored = await toProvider.store(data);

    if (stored) {
      const fromProvider = this.getProvider(fromType);
      await fromProvider.delete(id);
      return true;
    }
    return false;
  }

  /**
   * Delete data from specified storage
   * @param {string} id - Data identifier
   * @param {ArchivalStorageType} [storageType='local'] - Storage type
   * @returns {Promise<boolean>}
   */
  async delete(id: string, storageType: ArchivalStorageType = ArchivalStorageType.LOCAL): Promise<boolean> {
    const provider = this.getProvider(storageType);
    return provider.delete(id);
  }

  /**
   * Get provider for storage type
   * @param {ArchivalStorageType} storageType - Storage type
   * @returns {IStorageProvider}
   */
  public getProvider(storageType: ArchivalStorageType): IStorageProvider {
    switch (storageType) {
      case ArchivalStorageType.COLD_STORAGE:
      case ArchivalStorageType.ENCRYPTED_ARCHIVE:
        return this.archiveProvider;
      default:
        return this.localProvider;
    }
  }
}

/**
 * Clamp a caller-supplied pagination limit into [1, RETENTION_PAGE_MAX_LIMIT].
 * Bad inputs (NaN, negatives, non-numbers) are pushed to 1; oversized limits
 * collapse to the cap.
 *
 * @private
 */
function clampPageLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) return 1;
  return Math.min(Math.floor(limit), RETENTION_PAGE_MAX_LIMIT);
}

/**
 * Hydrate a {@link RetentionRow} into a {@link RetainedData}. The conversion
 * is intentionally defensive — `null` vs `undefined` matches the optional-vs-
 * present semantics from the in-memory implementation and JSON-safe defaults
 * avoid `JSON.parse('null')` crashes on empty payloads.
 *
 * @private
 */
function rowToRetainedData(row: RetentionRow): RetainedData {
  let parsedPayload: unknown = null;
  if (row.data && row.data !== 'null') {
    try {
      parsedPayload = JSON.parse(row.data);
    } catch {
      parsedPayload = row.data;
    }
  }

  let parsedMetadata: Record<string, unknown> | undefined;
  if (row.metadata) {
    try {
      parsedMetadata = JSON.parse(row.metadata);
    } catch {
      parsedMetadata = undefined;
    }
  }

  return {
    id: row.id,
    entityType: row.entity_type as RetainedData['entityType'],
    data: parsedPayload,
    classification: row.classification as DataClassification,
    createdAt: new Date(row.created_at),
    expiresAt: new Date(row.expires_at),
    archivedAt: row.archived_at ? new Date(row.archived_at) : undefined,
    archivedLocation: row.archived_location ?? undefined,
    isArchived: Boolean(row.is_archived),
    retentionPolicyId: row.retention_policy_id ?? undefined,
    metadata: parsedMetadata,
  };
}
