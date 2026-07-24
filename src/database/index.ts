import { randomUUID } from 'crypto';
import { getDb } from '../db/database';
import { ContractMetadata, Contract, User, ApiKey } from './schema';

/**
 * DatabaseService — SQLite-backed persistence for contracts, users, and API
 * keys. This replaces the previous JSON-file implementation in
 * data/database.json, which had no concurrency control and was subject to
 * silent data loss under parallel writes.
 *
 * All queries use prepared statements with parameterised binding — no string
 * interpolation — preventing SQL injection.
 *
 * The service delegates database lifecycle (open, WAL mode, migrations) to
 * `src/db/database.ts`. Tests should call `getDb(':memory:')` before
 * constructing this service to obtain an isolated, ephemeral database.
 */

// ---------------------------------------------------------------------------
// Row types — the shape of rows as stored in SQLite (TEXT dates, INTEGER bools)
// ---------------------------------------------------------------------------

interface ContractMetadataRow {
  id: string;
  contract_id: string;
  key: string;
  value: string;
  data_type: 'string' | 'number' | 'boolean' | 'json';
  is_sensitive: number;
  created_by: string;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

interface ContractRow {
  id: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

interface UserRow {
  id: string;
  email: string;
  role: 'user' | 'admin';
  created_at: string;
  updated_at: string;
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

// ---------------------------------------------------------------------------
// Row-to-domain mappers
// ---------------------------------------------------------------------------

function toContractMetadata(row: ContractMetadataRow): ContractMetadata {
  return {
    id: row.id,
    contract_id: row.contract_id,
    key: row.key,
    value: row.value,
    data_type: row.data_type,
    is_sensitive: row.is_sensitive === 1,
    created_by: row.created_by,
    updated_by: row.updated_by ?? undefined,
    created_at: new Date(row.created_at),
    updated_at: new Date(row.updated_at),
    deleted_at: row.deleted_at ? new Date(row.deleted_at) : undefined,
  };
}

function toContract(row: ContractRow): Contract {
  return {
    id: row.id,
    created_by: row.created_by,
    created_at: new Date(row.created_at),
    updated_at: new Date(row.updated_at),
    deleted_at: row.deleted_at ? new Date(row.deleted_at) : undefined,
  };
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    created_at: new Date(row.created_at),
    updated_at: new Date(row.updated_at),
  };
}

function toApiKey(row: ApiKeyRow): ApiKey {
  return {
    id: row.id,
    name: row.name,
    key_hash: row.key_hash,
    key_selector: row.key_selector ?? undefined,
    scope: JSON.parse(row.scope) as string[],
    created_by: row.created_by,
    created_at: new Date(row.created_at),
    updated_at: new Date(row.updated_at),
    expires_at: row.expires_at ? new Date(row.expires_at) : undefined,
    last_used_at: row.last_used_at ? new Date(row.last_used_at) : undefined,
    is_active: row.is_active === 1,
  };
}

// ---------------------------------------------------------------------------
// DatabaseService
// ---------------------------------------------------------------------------

class DatabaseService {
  // ---------------------------------------------------------------------------
  // Contract Metadata
  // ---------------------------------------------------------------------------

  createContractMetadata(
    data: Omit<ContractMetadata, 'id' | 'created_at' | 'updated_at'>
  ): ContractMetadata {
    const db = getDb();
    const now = new Date().toISOString();
    const id = randomUUID();

    db.prepare<[string, string, string, string, string, number, string, string | null, string, string]>(`
      INSERT INTO contract_metadata
        (id, contract_id, key, value, data_type, is_sensitive, created_by, updated_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      data.contract_id,
      data.key,
      data.value,
      data.data_type,
      data.is_sensitive ? 1 : 0,
      data.created_by,
      data.updated_by ?? null,
      now,
      now,
    );

    return toContractMetadata(
      db.prepare<[string], ContractMetadataRow>(
        'SELECT * FROM contract_metadata WHERE id = ?'
      ).get(id)!
    );
  }

  getContractMetadataByContractId(
    contractId: string,
    options: {
      page?: number;
      limit?: number;
      key?: string;
      data_type?: string;
      includeDeleted?: boolean;
    } = {}
  ): { records: ContractMetadata[]; total: number; page: number; limit: number } {
    const db = getDb();
    const MAX_LIMIT = 100;
    const { page = 1, limit = 20, key, data_type, includeDeleted = false } = options;
    const boundedLimit = Math.min(Math.max(1, limit), MAX_LIMIT);
    const offset = (page - 1) * boundedLimit;

    // Build WHERE clause
    const conditions: string[] = ['contract_id = ?'];
    const params: unknown[] = [contractId];

    if (!includeDeleted) {
      conditions.push('deleted_at IS NULL');
    }
    if (key !== undefined) {
      conditions.push('key = ?');
      params.push(key);
    }
    if (data_type !== undefined) {
      conditions.push('data_type = ?');
      params.push(data_type);
    }

    const where = conditions.join(' AND ');

    const { count } = db.prepare<unknown[], { count: number }>(
      `SELECT COUNT(*) AS count FROM contract_metadata WHERE ${where}`
    ).get(...params)!;

    const rows = db.prepare<unknown[], ContractMetadataRow>(
      `SELECT * FROM contract_metadata WHERE ${where}
       ORDER BY created_at DESC, id ASC
       LIMIT ? OFFSET ?`
    ).all(...params, boundedLimit, offset);

    return {
      records: rows.map(toContractMetadata),
      total: count,
      page,
      limit: boundedLimit,
    };
  }

  getContractMetadataById(id: string): ContractMetadata | null {
    const db = getDb();
    const row = db.prepare<[string], ContractMetadataRow>(
      'SELECT * FROM contract_metadata WHERE id = ? AND deleted_at IS NULL'
    ).get(id);
    return row ? toContractMetadata(row) : null;
  }

  updateContractMetadata(
    id: string,
    updates: Partial<Pick<ContractMetadata, 'value' | 'is_sensitive' | 'updated_by'>>
  ): ContractMetadata | null {
    const db = getDb();
    const now = new Date().toISOString();

    const setClauses: string[] = ['updated_at = ?'];
    const params: unknown[] = [now];

    if (updates.value !== undefined) {
      setClauses.push('value = ?');
      params.push(updates.value);
    }
    if (updates.is_sensitive !== undefined) {
      setClauses.push('is_sensitive = ?');
      params.push(updates.is_sensitive ? 1 : 0);
    }
    if (updates.updated_by !== undefined) {
      setClauses.push('updated_by = ?');
      params.push(updates.updated_by);
    }

    const result = db.prepare<unknown[]>(
      `UPDATE contract_metadata SET ${setClauses.join(', ')}
       WHERE id = ? AND deleted_at IS NULL`
    ).run(...params, id);

    if (result.changes === 0) return null;

    return toContractMetadata(
      db.prepare<[string], ContractMetadataRow>(
        'SELECT * FROM contract_metadata WHERE id = ?'
      ).get(id)!
    );
  }

  deleteContractMetadata(id: string): boolean {
    const db = getDb();
    const now = new Date().toISOString();

    const result = db.prepare<[string, string, string]>(
      `UPDATE contract_metadata SET deleted_at = ?, updated_at = ?
       WHERE id = ? AND deleted_at IS NULL`
    ).run(now, now, id);

    return result.changes > 0;
  }

  findContractMetadataByKey(contractId: string, key: string): ContractMetadata | null {
    const db = getDb();
    const row = db.prepare<[string, string], ContractMetadataRow>(
      'SELECT * FROM contract_metadata WHERE contract_id = ? AND key = ? AND deleted_at IS NULL'
    ).get(contractId, key);
    return row ? toContractMetadata(row) : null;
  }

  // ---------------------------------------------------------------------------
  // Contracts (lightweight container — stored in db_contracts, not contracts)
  // ---------------------------------------------------------------------------

  getContractById(id: string): Contract | null {
    const db = getDb();
    const row = db.prepare<[string], ContractRow>(
      'SELECT * FROM db_contracts WHERE id = ? AND deleted_at IS NULL'
    ).get(id);
    return row ? toContract(row) : null;
  }

  createContract(data: Omit<Contract, 'id' | 'created_at' | 'updated_at'>): Contract {
    const db = getDb();
    const now = new Date().toISOString();
    const id = randomUUID();

    db.prepare<[string, string, string, string, string | null]>(`
      INSERT INTO db_contracts (id, created_by, created_at, updated_at, deleted_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, data.created_by, now, now, data.deleted_at?.toISOString() ?? null);

    return toContract(
      db.prepare<[string], ContractRow>(
        'SELECT * FROM db_contracts WHERE id = ?'
      ).get(id)!
    );
  }

  // ---------------------------------------------------------------------------
  // Users (stored in db_users — separate from the auth-focused users table)
  // ---------------------------------------------------------------------------

  getUserById(id: string): User | null {
    const db = getDb();
    const row = db.prepare<[string], UserRow>(
      'SELECT * FROM db_users WHERE id = ?'
    ).get(id);
    return row ? toUser(row) : null;
  }

  createUser(data: Omit<User, 'id' | 'created_at' | 'updated_at'>): User {
    const db = getDb();
    const now = new Date().toISOString();
    const id = randomUUID();

    db.prepare<[string, string, string, string, string]>(`
      INSERT INTO db_users (id, email, role, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, data.email, data.role, now, now);

    return toUser(
      db.prepare<[string], UserRow>(
        'SELECT * FROM db_users WHERE id = ?'
      ).get(id)!
    );
  }

  // ---------------------------------------------------------------------------
  // API Keys
  // ---------------------------------------------------------------------------

  createApiKey(data: Omit<ApiKey, 'id' | 'created_at' | 'updated_at'>): ApiKey {
    const db = getDb();
    const now = new Date().toISOString();
    const id = randomUUID();

    db.prepare<[string, string, string, string | null, string, string, string, string, string | null, string | null, number]>(`
      INSERT INTO api_keys
        (id, name, key_hash, key_selector, scope, created_by, created_at, updated_at, expires_at, last_used_at, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      data.name,
      data.key_hash,
      data.key_selector ?? null,
      JSON.stringify(data.scope),
      data.created_by,
      now,
      now,
      data.expires_at?.toISOString() ?? null,
      data.last_used_at?.toISOString() ?? null,
      data.is_active ? 1 : 0,
    );

    return toApiKey(
      db.prepare<[string], ApiKeyRow>(
        'SELECT * FROM api_keys WHERE id = ?'
      ).get(id)!
    );
  }

  getApiKeyById(id: string): ApiKey | null {
    const db = getDb();
    const row = db.prepare<[string], ApiKeyRow>(
      'SELECT * FROM api_keys WHERE id = ? AND is_active = 1'
    ).get(id);
    return row ? toApiKey(row) : null;
  }

  getApiKeyByHash(keyHash: string): ApiKey | null {
    const db = getDb();
    const row = db.prepare<[string], ApiKeyRow>(
      'SELECT * FROM api_keys WHERE key_hash = ? AND is_active = 1'
    ).get(keyHash);
    return row ? toApiKey(row) : null;
  }

  getApiKeyBySelector(selector: string): ApiKey | null {
    const db = getDb();
    const row = db.prepare<[string], ApiKeyRow>(
      'SELECT * FROM api_keys WHERE key_selector = ? AND is_active = 1'
    ).get(selector);
    return row ? toApiKey(row) : null;
  }

  updateApiKey(
    id: string,
    updates: Partial<Pick<ApiKey, 'name' | 'scope' | 'expires_at' | 'is_active' | 'last_used_at' | 'key_selector'>>
  ): ApiKey | null {
    const db = getDb();
    const now = new Date().toISOString();

    const setClauses: string[] = ['updated_at = ?'];
    const params: unknown[] = [now];

    if (updates.name !== undefined) {
      setClauses.push('name = ?');
      params.push(updates.name);
    }
    if (updates.scope !== undefined) {
      setClauses.push('scope = ?');
      params.push(JSON.stringify(updates.scope));
    }
    if (updates.expires_at !== undefined) {
      setClauses.push('expires_at = ?');
      params.push(updates.expires_at ? updates.expires_at.toISOString() : null);
    }
    if (updates.is_active !== undefined) {
      setClauses.push('is_active = ?');
      params.push(updates.is_active ? 1 : 0);
    }
    if (updates.last_used_at !== undefined) {
      setClauses.push('last_used_at = ?');
      params.push(updates.last_used_at ? updates.last_used_at.toISOString() : null);
    }
    if (updates.key_selector !== undefined) {
      setClauses.push('key_selector = ?');
      params.push(updates.key_selector);
    }

    const result = db.prepare<unknown[]>(
      `UPDATE api_keys SET ${setClauses.join(', ')} WHERE id = ?`
    ).run(...params, id);

    if (result.changes === 0) return null;

    return toApiKey(
      db.prepare<[string], ApiKeyRow>(
        'SELECT * FROM api_keys WHERE id = ?'
      ).get(id)!
    );
  }

  deactivateApiKey(id: string): boolean {
    const db = getDb();
    const now = new Date().toISOString();

    const result = db.prepare<[string, string]>(
      'UPDATE api_keys SET is_active = 0, updated_at = ? WHERE id = ?'
    ).run(now, id);

    return result.changes > 0;
  }

  rotateApiKey(id: string, newKeyHash: string, newKeySelector?: string): ApiKey | null {
    const db = getDb();
    const now = new Date().toISOString();

    const setClauses = ['key_hash = ?', 'updated_at = ?'];
    const params: unknown[] = [newKeyHash, now];

    if (newKeySelector !== undefined) {
      setClauses.push('key_selector = ?');
      params.push(newKeySelector);
    }

    const result = db.prepare<unknown[]>(
      `UPDATE api_keys SET ${setClauses.join(', ')} WHERE id = ?`
    ).run(...params, id);

    if (result.changes === 0) return null;

    return toApiKey(
      db.prepare<[string], ApiKeyRow>(
        'SELECT * FROM api_keys WHERE id = ?'
      ).get(id)!
    );
  }

  /**
   * Returns all active API keys that do not yet have a `key_selector` set.
   * Used by the legacy fallback path in validateApiKey.
   */
  getApiKeysWithoutSelector(): ApiKey[] {
    const db = getDb();
    const rows = db.prepare<[], ApiKeyRow>(
      'SELECT * FROM api_keys WHERE key_selector IS NULL AND is_active = 1'
    ).all();
    return rows.map(toApiKey);
  }

  /**
   * Returns the count of API keys that do not yet have a `key_selector` set.
   *
   * Selectors cannot be derived from stored hashes; they are backfilled lazily
   * when the plain-text key becomes available during validation. This method is
   * provided for monitoring and operational reporting only.
   */
  backfillKeySelectors(): number {
    const db = getDb();
    const row = db.prepare<[], { count: number }>(
      'SELECT COUNT(*) AS count FROM api_keys WHERE key_selector IS NULL'
    ).get();
    return row?.count ?? 0;
  }

  // ---------------------------------------------------------------------------
  // Cleanup — used in tests only
  // ---------------------------------------------------------------------------

  clearDatabase(): void {
    const db = getDb();
    db.prepare('DELETE FROM contract_metadata').run();
    db.prepare('DELETE FROM db_contracts').run();
    db.prepare('DELETE FROM db_users').run();
    db.prepare('DELETE FROM api_keys').run();
  }
}

export const database = new DatabaseService();
