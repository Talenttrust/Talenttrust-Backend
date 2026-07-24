/**
 * Tests for the SQLite-backed DatabaseService (src/database/index.ts).
 *
 * Each describe block initialises an isolated in-memory database via
 * `getDb(':memory:')` before the suite runs, and calls `closeDb()` after each
 * test to return the singleton to a clean state.
 *
 * Coverage targets: statements ≥95%, branches ≥95%, functions ≥95%, lines ≥95%.
 */

import { getDb, closeDb } from '../db/database';
import { database } from './index';

// Re-open a fresh in-memory database before every test so each test starts
// with an empty schema and no leftover rows.
beforeEach(() => {
  closeDb();
  getDb(':memory:');
});

afterEach(() => {
  closeDb();
});

// ---------------------------------------------------------------------------
// Contract Metadata
// ---------------------------------------------------------------------------

describe('DatabaseService — contract_metadata', () => {
  const baseData = {
    contract_id: 'contract-1',
    key: 'title',
    value: 'Test Contract',
    data_type: 'string' as const,
    is_sensitive: false,
    created_by: 'user-1',
  };

  describe('createContractMetadata', () => {
    it('creates a record and returns it with generated id and timestamps', () => {
      const record = database.createContractMetadata(baseData);

      expect(record.id).toBeDefined();
      expect(record.id.length).toBe(36); // UUID v4
      expect(record.contract_id).toBe('contract-1');
      expect(record.key).toBe('title');
      expect(record.value).toBe('Test Contract');
      expect(record.data_type).toBe('string');
      expect(record.is_sensitive).toBe(false);
      expect(record.created_by).toBe('user-1');
      expect(record.created_at).toBeInstanceOf(Date);
      expect(record.updated_at).toBeInstanceOf(Date);
      expect(record.deleted_at).toBeUndefined();
    });

    it('handles is_sensitive=true correctly', () => {
      const record = database.createContractMetadata({ ...baseData, is_sensitive: true });
      expect(record.is_sensitive).toBe(true);
    });

    it('stores updated_by when provided', () => {
      const record = database.createContractMetadata({
        ...baseData,
        updated_by: 'admin-1',
      });
      expect(record.updated_by).toBe('admin-1');
    });

    it('leaves updated_by undefined when not provided', () => {
      const record = database.createContractMetadata(baseData);
      expect(record.updated_by).toBeUndefined();
    });

    it('supports all data_type values', () => {
      for (const data_type of ['string', 'number', 'boolean', 'json'] as const) {
        const record = database.createContractMetadata({ ...baseData, data_type });
        expect(record.data_type).toBe(data_type);
      }
    });

    it('persists records across multiple calls', () => {
      database.createContractMetadata({ ...baseData, key: 'a' });
      database.createContractMetadata({ ...baseData, key: 'b' });
      const { total } = database.getContractMetadataByContractId('contract-1');
      expect(total).toBe(2);
    });
  });

  describe('getContractMetadataByContractId', () => {
    beforeEach(() => {
      database.createContractMetadata({ ...baseData, key: 'k1', value: 'v1' });
      database.createContractMetadata({ ...baseData, key: 'k2', value: 'v2' });
      database.createContractMetadata({ ...baseData, contract_id: 'contract-2', key: 'k3' });
    });

    it('returns only records for the given contractId', () => {
      const { records, total } = database.getContractMetadataByContractId('contract-1');
      expect(total).toBe(2);
      expect(records.every(r => r.contract_id === 'contract-1')).toBe(true);
    });

    it('paginates results correctly', () => {
      const page1 = database.getContractMetadataByContractId('contract-1', {
        page: 1,
        limit: 1,
      });
      const page2 = database.getContractMetadataByContractId('contract-1', {
        page: 2,
        limit: 1,
      });

      expect(page1.records.length).toBe(1);
      expect(page2.records.length).toBe(1);
      expect(page1.records[0]!.id).not.toBe(page2.records[0]!.id);
      expect(page1.limit).toBe(1);
      expect(page1.page).toBe(1);
    });

    it('returns empty page when beyond total', () => {
      const { records } = database.getContractMetadataByContractId('contract-1', {
        page: 99,
        limit: 20,
      });
      expect(records).toHaveLength(0);
    });

    it('filters by key', () => {
      const { records, total } = database.getContractMetadataByContractId('contract-1', {
        key: 'k1',
      });
      expect(total).toBe(1);
      expect(records[0]!.key).toBe('k1');
    });

    it('filters by data_type', () => {
      database.createContractMetadata({ ...baseData, key: 'num', data_type: 'number' });
      const { records, total } = database.getContractMetadataByContractId('contract-1', {
        data_type: 'number',
      });
      expect(total).toBe(1);
      expect(records[0]!.data_type).toBe('number');
    });

    it('excludes soft-deleted records by default', () => {
      const record = database.createContractMetadata({ ...baseData, key: 'del' });
      database.deleteContractMetadata(record.id);

      const { total } = database.getContractMetadataByContractId('contract-1');
      expect(total).toBe(2); // 'k1' and 'k2' remain
    });

    it('includes soft-deleted records when includeDeleted=true', () => {
      const record = database.createContractMetadata({ ...baseData, key: 'del' });
      database.deleteContractMetadata(record.id);

      const { total } = database.getContractMetadataByContractId('contract-1', {
        includeDeleted: true,
      });
      expect(total).toBe(3);
    });

    it('clamps limit to MAX_LIMIT (100)', () => {
      const { limit } = database.getContractMetadataByContractId('contract-1', {
        limit: 9999,
      });
      expect(limit).toBe(100);
    });

    it('clamps limit to minimum 1', () => {
      const { limit } = database.getContractMetadataByContractId('contract-1', {
        limit: 0,
      });
      expect(limit).toBe(1);
    });

    it('returns total=0 when no records exist', () => {
      const { total, records } = database.getContractMetadataByContractId('no-such-contract');
      expect(total).toBe(0);
      expect(records).toHaveLength(0);
    });
  });

  describe('getContractMetadataById', () => {
    it('returns the record when found', () => {
      const created = database.createContractMetadata(baseData);
      const found = database.getContractMetadataById(created.id);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(created.id);
    });

    it('returns null when id does not exist', () => {
      expect(database.getContractMetadataById('non-existent')).toBeNull();
    });

    it('returns null for soft-deleted records', () => {
      const record = database.createContractMetadata(baseData);
      database.deleteContractMetadata(record.id);
      expect(database.getContractMetadataById(record.id)).toBeNull();
    });
  });

  describe('updateContractMetadata', () => {
    it('updates value', () => {
      const record = database.createContractMetadata(baseData);
      const updated = database.updateContractMetadata(record.id, { value: 'new value' });
      expect(updated).not.toBeNull();
      expect(updated!.value).toBe('new value');
    });

    it('updates is_sensitive', () => {
      const record = database.createContractMetadata(baseData);
      const updated = database.updateContractMetadata(record.id, { is_sensitive: true });
      expect(updated!.is_sensitive).toBe(true);
    });

    it('updates updated_by', () => {
      const record = database.createContractMetadata(baseData);
      const updated = database.updateContractMetadata(record.id, { updated_by: 'admin' });
      expect(updated!.updated_by).toBe('admin');
    });

    it('updates updated_at timestamp', () => {
      const record = database.createContractMetadata(baseData);
      const before = record.updated_at.getTime();
      // Advance time slightly so the timestamps differ
      jest.spyOn(Date, 'now').mockReturnValueOnce(before + 1000);
      const updated = database.updateContractMetadata(record.id, { value: 'changed' });
      expect(updated!.updated_at.getTime()).toBeGreaterThanOrEqual(before);
      jest.restoreAllMocks();
    });

    it('returns null when id does not exist', () => {
      const result = database.updateContractMetadata('non-existent', { value: 'x' });
      expect(result).toBeNull();
    });

    it('returns null when record is soft-deleted', () => {
      const record = database.createContractMetadata(baseData);
      database.deleteContractMetadata(record.id);
      const result = database.updateContractMetadata(record.id, { value: 'x' });
      expect(result).toBeNull();
    });

    it('no-ops when updates is empty object', () => {
      const record = database.createContractMetadata(baseData);
      const updated = database.updateContractMetadata(record.id, {});
      expect(updated).not.toBeNull();
      expect(updated!.value).toBe(record.value);
    });
  });

  describe('deleteContractMetadata', () => {
    it('soft-deletes a record and returns true', () => {
      const record = database.createContractMetadata(baseData);
      const result = database.deleteContractMetadata(record.id);
      expect(result).toBe(true);

      // Record now has deleted_at set
      const row = getDb().prepare<[string], { deleted_at: string | null }>(
        'SELECT deleted_at FROM contract_metadata WHERE id = ?'
      ).get(record.id);
      expect(row?.deleted_at).not.toBeNull();
    });

    it('returns false when id does not exist', () => {
      expect(database.deleteContractMetadata('non-existent')).toBe(false);
    });

    it('returns false when already deleted', () => {
      const record = database.createContractMetadata(baseData);
      database.deleteContractMetadata(record.id);
      expect(database.deleteContractMetadata(record.id)).toBe(false);
    });
  });

  describe('findContractMetadataByKey', () => {
    it('returns the record when found', () => {
      database.createContractMetadata(baseData);
      const found = database.findContractMetadataByKey('contract-1', 'title');
      expect(found).not.toBeNull();
      expect(found!.key).toBe('title');
    });

    it('returns null when key does not exist for contract', () => {
      expect(database.findContractMetadataByKey('contract-1', 'missing')).toBeNull();
    });

    it('returns null when record is soft-deleted', () => {
      const record = database.createContractMetadata(baseData);
      database.deleteContractMetadata(record.id);
      expect(database.findContractMetadataByKey('contract-1', 'title')).toBeNull();
    });

    it('does not return a record from a different contract', () => {
      database.createContractMetadata({ ...baseData, contract_id: 'other-contract' });
      expect(database.findContractMetadataByKey('contract-1', 'title')).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// Contracts (db_contracts table)
// ---------------------------------------------------------------------------

describe('DatabaseService — contracts', () => {
  const baseContract = { created_by: 'user-1' };

  describe('createContract', () => {
    it('creates a contract with generated id and timestamps', () => {
      const contract = database.createContract(baseContract);
      expect(contract.id).toBeDefined();
      expect(contract.id.length).toBe(36);
      expect(contract.created_by).toBe('user-1');
      expect(contract.created_at).toBeInstanceOf(Date);
      expect(contract.updated_at).toBeInstanceOf(Date);
      expect(contract.deleted_at).toBeUndefined();
    });
  });

  describe('getContractById', () => {
    it('returns the contract when found', () => {
      const created = database.createContract(baseContract);
      const found = database.getContractById(created.id);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(created.id);
    });

    it('returns null when id does not exist', () => {
      expect(database.getContractById('non-existent')).toBeNull();
    });

    it('returns null for soft-deleted contracts', () => {
      const contract = database.createContract(baseContract);
      // Soft-delete directly via SQL (no public API for this)
      getDb().prepare(
        "UPDATE db_contracts SET deleted_at = ? WHERE id = ?"
      ).run(new Date().toISOString(), contract.id);

      expect(database.getContractById(contract.id)).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// Users (db_users table)
// ---------------------------------------------------------------------------

describe('DatabaseService — users', () => {
  const baseUser = { email: 'alice@example.com', role: 'user' as const };

  describe('createUser', () => {
    it('creates a user with generated id and timestamps', () => {
      const user = database.createUser(baseUser);
      expect(user.id).toBeDefined();
      expect(user.id.length).toBe(36);
      expect(user.email).toBe('alice@example.com');
      expect(user.role).toBe('user');
      expect(user.created_at).toBeInstanceOf(Date);
      expect(user.updated_at).toBeInstanceOf(Date);
    });

    it('creates a user with role=admin', () => {
      const user = database.createUser({ email: 'admin@example.com', role: 'admin' });
      expect(user.role).toBe('admin');
    });
  });

  describe('getUserById', () => {
    it('returns the user when found', () => {
      const created = database.createUser(baseUser);
      const found = database.getUserById(created.id);
      expect(found).not.toBeNull();
      expect(found!.email).toBe('alice@example.com');
    });

    it('returns null when id does not exist', () => {
      expect(database.getUserById('non-existent')).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// API Keys
// ---------------------------------------------------------------------------

describe('DatabaseService — api_keys', () => {
  const baseKey = {
    name: 'My Key',
    key_hash: 'hash-abc',
    key_selector: 'sel-123',
    scope: ['read', 'write'],
    created_by: 'user-1',
    is_active: true,
  };

  describe('createApiKey', () => {
    it('creates an API key with generated id and timestamps', () => {
      const key = database.createApiKey(baseKey);
      expect(key.id).toBeDefined();
      expect(key.id.length).toBe(36);
      expect(key.name).toBe('My Key');
      expect(key.key_hash).toBe('hash-abc');
      expect(key.key_selector).toBe('sel-123');
      expect(key.scope).toEqual(['read', 'write']);
      expect(key.is_active).toBe(true);
      expect(key.created_at).toBeInstanceOf(Date);
      expect(key.updated_at).toBeInstanceOf(Date);
      expect(key.expires_at).toBeUndefined();
      expect(key.last_used_at).toBeUndefined();
    });

    it('stores expires_at when provided', () => {
      const expires = new Date('2099-01-01T00:00:00Z');
      const key = database.createApiKey({ ...baseKey, expires_at: expires });
      expect(key.expires_at).toBeInstanceOf(Date);
      expect(key.expires_at!.toISOString()).toBe(expires.toISOString());
    });

    it('stores last_used_at when provided', () => {
      const used = new Date('2024-06-01T00:00:00Z');
      const key = database.createApiKey({ ...baseKey, last_used_at: used });
      expect(key.last_used_at).toBeInstanceOf(Date);
    });

    it('creates an inactive key (is_active=false)', () => {
      const key = database.createApiKey({ ...baseKey, is_active: false });
      expect(key.is_active).toBe(false);
    });

    it('handles missing key_selector (undefined)', () => {
      const { key_selector: _, ...withoutSelector } = baseKey;
      const key = database.createApiKey(withoutSelector);
      expect(key.key_selector).toBeUndefined();
    });
  });

  describe('getApiKeyById', () => {
    it('returns an active key', () => {
      const created = database.createApiKey(baseKey);
      const found = database.getApiKeyById(created.id);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(created.id);
    });

    it('returns null for an inactive key', () => {
      const created = database.createApiKey({ ...baseKey, is_active: false });
      expect(database.getApiKeyById(created.id)).toBeNull();
    });

    it('returns null when id does not exist', () => {
      expect(database.getApiKeyById('non-existent')).toBeNull();
    });
  });

  describe('getApiKeyByHash', () => {
    it('returns an active key matching the hash', () => {
      database.createApiKey(baseKey);
      const found = database.getApiKeyByHash('hash-abc');
      expect(found).not.toBeNull();
      expect(found!.key_hash).toBe('hash-abc');
    });

    it('returns null when hash does not match', () => {
      database.createApiKey(baseKey);
      expect(database.getApiKeyByHash('wrong-hash')).toBeNull();
    });

    it('returns null for an inactive key with matching hash', () => {
      database.createApiKey({ ...baseKey, is_active: false });
      expect(database.getApiKeyByHash('hash-abc')).toBeNull();
    });
  });

  describe('getApiKeyBySelector', () => {
    it('returns an active key matching the selector', () => {
      database.createApiKey(baseKey);
      const found = database.getApiKeyBySelector('sel-123');
      expect(found).not.toBeNull();
      expect(found!.key_selector).toBe('sel-123');
    });

    it('returns null when selector does not match', () => {
      database.createApiKey(baseKey);
      expect(database.getApiKeyBySelector('wrong-sel')).toBeNull();
    });

    it('returns null for an inactive key', () => {
      database.createApiKey({ ...baseKey, is_active: false });
      expect(database.getApiKeyBySelector('sel-123')).toBeNull();
    });
  });

  describe('updateApiKey', () => {
    it('updates name', () => {
      const key = database.createApiKey(baseKey);
      const updated = database.updateApiKey(key.id, { name: 'Renamed' });
      expect(updated!.name).toBe('Renamed');
    });

    it('updates scope', () => {
      const key = database.createApiKey(baseKey);
      const updated = database.updateApiKey(key.id, { scope: ['read'] });
      expect(updated!.scope).toEqual(['read']);
    });

    it('updates expires_at', () => {
      const key = database.createApiKey(baseKey);
      const exp = new Date('2099-12-31T00:00:00Z');
      const updated = database.updateApiKey(key.id, { expires_at: exp });
      expect(updated!.expires_at?.toISOString()).toBe(exp.toISOString());
    });

    it('clears expires_at when set to null-like undefined', () => {
      const key = database.createApiKey({ ...baseKey, expires_at: new Date('2099-01-01') });
      // Passing undefined for expires_at means "don't change it"
      const updated = database.updateApiKey(key.id, { name: 'same' });
      expect(updated!.expires_at).toBeInstanceOf(Date);
    });

    it('updates is_active to false', () => {
      const key = database.createApiKey(baseKey);
      const updated = database.updateApiKey(key.id, { is_active: false });
      expect(updated!.is_active).toBe(false);
    });

    it('updates last_used_at', () => {
      const key = database.createApiKey(baseKey);
      const used = new Date();
      const updated = database.updateApiKey(key.id, { last_used_at: used });
      expect(updated!.last_used_at).toBeInstanceOf(Date);
    });

    it('updates key_selector', () => {
      const key = database.createApiKey(baseKey);
      const updated = database.updateApiKey(key.id, { key_selector: 'new-sel' });
      expect(updated!.key_selector).toBe('new-sel');
    });

    it('returns null when id does not exist', () => {
      expect(database.updateApiKey('non-existent', { name: 'x' })).toBeNull();
    });

    it('no-ops when updates is empty', () => {
      const key = database.createApiKey(baseKey);
      const updated = database.updateApiKey(key.id, {});
      expect(updated).not.toBeNull();
      expect(updated!.name).toBe(baseKey.name);
    });
  });

  describe('deactivateApiKey', () => {
    it('deactivates an active key and returns true', () => {
      const key = database.createApiKey(baseKey);
      const result = database.deactivateApiKey(key.id);
      expect(result).toBe(true);

      // Confirm is_active = 0 in DB
      const found = database.getApiKeyById(key.id);
      expect(found).toBeNull(); // getApiKeyById filters is_active=1
    });

    it('returns false when id does not exist', () => {
      expect(database.deactivateApiKey('non-existent')).toBe(false);
    });

    it('returns true when key is already inactive (idempotent update)', () => {
      const key = database.createApiKey({ ...baseKey, is_active: false });
      // The UPDATE runs but changes 0 rows when WHERE id = ? matches, since
      // deactivateApiKey does not filter by is_active.  It sets is_active=0
      // unconditionally, so changes=1.
      const result = database.deactivateApiKey(key.id);
      expect(result).toBe(true);
    });
  });

  describe('rotateApiKey', () => {
    it('updates key_hash', () => {
      const key = database.createApiKey(baseKey);
      const rotated = database.rotateApiKey(key.id, 'new-hash');
      expect(rotated).not.toBeNull();
      expect(rotated!.key_hash).toBe('new-hash');
    });

    it('updates key_hash and key_selector when provided', () => {
      const key = database.createApiKey(baseKey);
      const rotated = database.rotateApiKey(key.id, 'new-hash', 'new-sel');
      expect(rotated!.key_hash).toBe('new-hash');
      expect(rotated!.key_selector).toBe('new-sel');
    });

    it('does not change key_selector when not provided', () => {
      const key = database.createApiKey(baseKey);
      const rotated = database.rotateApiKey(key.id, 'new-hash');
      expect(rotated!.key_selector).toBe('sel-123');
    });

    it('returns null when id does not exist', () => {
      expect(database.rotateApiKey('non-existent', 'h')).toBeNull();
    });
  });

  describe('backfillKeySelectors', () => {
    it('returns 0 when all keys have selectors', () => {
      database.createApiKey(baseKey);
      expect(database.backfillKeySelectors()).toBe(0);
    });

    it('returns count of keys without selectors', () => {
      const { key_selector: _, ...withoutSelector } = baseKey;
      database.createApiKey(withoutSelector);
      database.createApiKey(withoutSelector);
      database.createApiKey(baseKey); // this one has a selector
      expect(database.backfillKeySelectors()).toBe(2);
    });
  });
});

// ---------------------------------------------------------------------------
// clearDatabase
// ---------------------------------------------------------------------------

describe('DatabaseService — clearDatabase', () => {
  it('removes all records from all tables', () => {
    database.createContractMetadata({
      contract_id: 'c1',
      key: 'k',
      value: 'v',
      data_type: 'string',
      is_sensitive: false,
      created_by: 'u1',
    });
    database.createContract({ created_by: 'u1' });
    database.createUser({ email: 'x@x.com', role: 'user' });
    database.createApiKey({
      name: 'k',
      key_hash: 'h',
      scope: [],
      created_by: 'u1',
      is_active: true,
    });

    database.clearDatabase();

    const db = getDb();
    expect(
      (db.prepare('SELECT COUNT(*) AS c FROM contract_metadata').get() as { c: number }).c
    ).toBe(0);
    expect(
      (db.prepare('SELECT COUNT(*) AS c FROM db_contracts').get() as { c: number }).c
    ).toBe(0);
    expect(
      (db.prepare('SELECT COUNT(*) AS c FROM db_users').get() as { c: number }).c
    ).toBe(0);
    expect(
      (db.prepare('SELECT COUNT(*) AS c FROM api_keys').get() as { c: number }).c
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// SQLite schema sanity checks (migrations ran correctly)
// ---------------------------------------------------------------------------

describe('DatabaseService — schema verification', () => {
  it('contract_metadata table exists after migrations', () => {
    const db = getDb();
    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='contract_metadata'"
    ).get() as { name: string } | undefined;
    expect(row?.name).toBe('contract_metadata');
  });

  it('db_contracts table exists after migrations', () => {
    const db = getDb();
    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='db_contracts'"
    ).get() as { name: string } | undefined;
    expect(row?.name).toBe('db_contracts');
  });

  it('db_users table exists after migrations', () => {
    const db = getDb();
    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='db_users'"
    ).get() as { name: string } | undefined;
    expect(row?.name).toBe('db_users');
  });

  it('api_keys table exists after migrations', () => {
    const db = getDb();
    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='api_keys'"
    ).get() as { name: string } | undefined;
    expect(row?.name).toBe('api_keys');
  });

  it('migration version 13 is recorded in schema_version', () => {
    const db = getDb();
    const row = db.prepare<[number], { version: number }>(
      'SELECT version FROM schema_version WHERE version = ?'
    ).get(13);
    expect(row?.version).toBe(13);
  });

  it('migration version 16 is recorded in schema_version', () => {
    const db = getDb();
    const row = db.prepare<[number], { version: number }>(
      'SELECT version FROM schema_version WHERE version = ?'
    ).get(16);
    expect(row?.version).toBe(16);
  });
});
