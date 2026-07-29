/**
 * Tests for the SQLite-backed DatabaseService.
 *
 * Each suite runs against an isolated in-memory database, injected through
 * `setMetadataStore` so that `getDb()` never touches a real file.
 */

import { getDb, closeDb } from '../db/database';
import { SqliteMetadataStore, setMetadataStore } from './sqliteStore';
import { database } from './index';
import type { ApiKey, ContractMetadata } from './schema';

let store: SqliteMetadataStore;

beforeAll(() => {
  const db = getDb(':memory:');
  store = new SqliteMetadataStore(db);
  setMetadataStore(store);
});

afterAll(() => {
  setMetadataStore(null);
  closeDb();
});

beforeEach(() => {
  store.clear();
});

const metadataInput = (overrides: Partial<ContractMetadata> = {}) => ({
  contract_id: 'contract-1',
  key: 'region',
  value: 'eu-west-1',
  data_type: 'string' as const,
  is_sensitive: false,
  created_by: 'user-1',
  ...overrides,
});

const apiKeyInput = (overrides: Partial<ApiKey> = {}) => ({
  name: 'ci-key',
  key_hash: 'salt:hash',
  key_selector: 'sel-1',
  scope: ['read', 'write'],
  created_by: 'user-1',
  is_active: true,
  ...overrides,
});

describe('contract metadata', () => {
  it('persists a record and assigns id and timestamps', async () => {
    const created = await database.createContractMetadata(metadataInput());

    expect(created.id).toEqual(expect.any(String));
    expect(created.created_at).toBeInstanceOf(Date);
    expect(created.updated_at).toBeInstanceOf(Date);

    const fetched = await database.getContractMetadataById(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.value).toBe('eu-west-1');
    expect(fetched?.contract_id).toBe('contract-1');
  });

  it('round-trips the is_sensitive boolean rather than a SQLite integer', async () => {
    const created = await database.createContractMetadata(
      metadataInput({ is_sensitive: true })
    );
    const fetched = await database.getContractMetadataById(created.id);

    expect(fetched?.is_sensitive).toBe(true);
  });

  it('returns null for an unknown id', async () => {
    await expect(database.getContractMetadataById('missing')).resolves.toBeNull();
  });

  it('finds a record by contract and key', async () => {
    await database.createContractMetadata(metadataInput());

    const found = await database.findContractMetadataByKey('contract-1', 'region');
    expect(found?.value).toBe('eu-west-1');

    await expect(
      database.findContractMetadataByKey('contract-1', 'absent')
    ).resolves.toBeNull();
  });

  it('updates only the mutable fields and bumps updated_at', async () => {
    const created = await database.createContractMetadata(metadataInput());

    const updated = await database.updateContractMetadata(created.id, {
      value: 'us-east-1',
      updated_by: 'user-2',
    });

    expect(updated?.value).toBe('us-east-1');
    expect(updated?.updated_by).toBe('user-2');
    expect(updated?.key).toBe('region');
    expect(updated?.updated_at.getTime()).toBeGreaterThanOrEqual(
      created.created_at.getTime()
    );

    const reloaded = await database.getContractMetadataById(created.id);
    expect(reloaded?.value).toBe('us-east-1');
  });

  it('returns null when updating a missing record', async () => {
    await expect(
      database.updateContractMetadata('missing', { value: 'x' })
    ).resolves.toBeNull();
  });

  it('soft-deletes so the row is hidden but retained', async () => {
    const created = await database.createContractMetadata(metadataInput());

    await expect(database.deleteContractMetadata(created.id)).resolves.toBe(true);
    await expect(database.getContractMetadataById(created.id)).resolves.toBeNull();

    const hidden = await database.getContractMetadataByContractId('contract-1');
    expect(hidden.total).toBe(0);

    const withDeleted = await database.getContractMetadataByContractId('contract-1', {
      includeDeleted: true,
    });
    expect(withDeleted.total).toBe(1);
    expect(withDeleted.records[0]?.deleted_at).toBeInstanceOf(Date);
  });

  it('does not delete the same record twice', async () => {
    const created = await database.createContractMetadata(metadataInput());

    await expect(database.deleteContractMetadata(created.id)).resolves.toBe(true);
    await expect(database.deleteContractMetadata(created.id)).resolves.toBe(false);
  });
});

describe('contract metadata listing', () => {
  /** Inserted directly so created_at values are deterministic. */
  const seed = (id: string, createdAt: string, overrides: Partial<ContractMetadata> = {}) =>
    store.insertMetadata({
      id,
      contract_id: 'contract-1',
      key: 'k',
      value: 'v',
      data_type: 'string',
      is_sensitive: false,
      created_by: 'user-1',
      created_at: new Date(createdAt),
      updated_at: new Date(createdAt),
      ...overrides,
    } as ContractMetadata);

  it('orders newest first with id ascending as the tie-breaker', async () => {
    seed('b', '2026-01-02T00:00:00.000Z');
    seed('a', '2026-01-02T00:00:00.000Z');
    seed('c', '2026-01-01T00:00:00.000Z');

    const page = await database.getContractMetadataByContractId('contract-1');

    expect(page.records.map(r => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('paginates without losing the total', async () => {
    seed('a', '2026-01-03T00:00:00.000Z');
    seed('b', '2026-01-02T00:00:00.000Z');
    seed('c', '2026-01-01T00:00:00.000Z');

    const first = await database.getContractMetadataByContractId('contract-1', {
      page: 1,
      limit: 2,
    });
    expect(first.records.map(r => r.id)).toEqual(['a', 'b']);
    expect(first.total).toBe(3);

    const second = await database.getContractMetadataByContractId('contract-1', {
      page: 2,
      limit: 2,
    });
    expect(second.records.map(r => r.id)).toEqual(['c']);
    expect(second.total).toBe(3);
  });

  it('clamps the limit to the 1..100 range', async () => {
    seed('a', '2026-01-01T00:00:00.000Z');

    await expect(
      database.getContractMetadataByContractId('contract-1', { limit: 5000 })
    ).resolves.toMatchObject({ limit: 100 });

    await expect(
      database.getContractMetadataByContractId('contract-1', { limit: 0 })
    ).resolves.toMatchObject({ limit: 1 });
  });

  it('filters by key and by data_type', async () => {
    seed('a', '2026-01-03T00:00:00.000Z', { key: 'region' });
    seed('b', '2026-01-02T00:00:00.000Z', { key: 'tier', data_type: 'number' });

    const byKey = await database.getContractMetadataByContractId('contract-1', {
      key: 'tier',
    });
    expect(byKey.records.map(r => r.id)).toEqual(['b']);

    const byType = await database.getContractMetadataByContractId('contract-1', {
      data_type: 'number',
    });
    expect(byType.records.map(r => r.id)).toEqual(['b']);
  });

  it('scopes results to the requested contract', async () => {
    seed('a', '2026-01-01T00:00:00.000Z');
    seed('b', '2026-01-01T00:00:00.000Z', { contract_id: 'contract-2' });

    const page = await database.getContractMetadataByContractId('contract-1');
    expect(page.records.map(r => r.id)).toEqual(['a']);
  });
});

describe('api keys', () => {
  it('creates a key and preserves the scope array', async () => {
    const created = await database.createApiKey(apiKeyInput());

    const fetched = await database.getApiKeyById(created.id);
    expect(fetched?.scope).toEqual(['read', 'write']);
    expect(fetched?.is_active).toBe(true);
  });

  it('looks a key up by hash and by selector', async () => {
    await database.createApiKey(apiKeyInput());

    await expect(database.getApiKeyByHash('salt:hash')).resolves.not.toBeNull();
    await expect(database.getApiKeyBySelector('sel-1')).resolves.not.toBeNull();
    await expect(database.getApiKeyByHash('nope')).resolves.toBeNull();
  });

  it('hides deactivated keys from every active lookup', async () => {
    const created = await database.createApiKey(apiKeyInput());

    await expect(database.deactivateApiKey(created.id)).resolves.toBe(true);

    await expect(database.getApiKeyById(created.id)).resolves.toBeNull();
    await expect(database.getApiKeyByHash('salt:hash')).resolves.toBeNull();
    await expect(database.getApiKeyBySelector('sel-1')).resolves.toBeNull();
  });

  it('reports false when deactivating a missing key', async () => {
    await expect(database.deactivateApiKey('missing')).resolves.toBe(false);
  });

  it('updates mutable fields', async () => {
    const created = await database.createApiKey(apiKeyInput());

    const updated = await database.updateApiKey(created.id, {
      name: 'renamed',
      scope: ['read'],
    });

    expect(updated?.name).toBe('renamed');
    expect(updated?.scope).toEqual(['read']);

    const reloaded = await database.getApiKeyById(created.id);
    expect(reloaded?.name).toBe('renamed');
  });

  it('rotates the hash, keeping the selector when none is supplied', async () => {
    const created = await database.createApiKey(apiKeyInput());

    const rotated = await database.rotateApiKey(created.id, 'salt:newhash');
    expect(rotated?.key_hash).toBe('salt:newhash');
    expect(rotated?.key_selector).toBe('sel-1');

    await expect(database.getApiKeyByHash('salt:hash')).resolves.toBeNull();
    await expect(database.getApiKeyByHash('salt:newhash')).resolves.not.toBeNull();
  });

  it('rotates the selector when one is supplied', async () => {
    const created = await database.createApiKey(apiKeyInput());

    const rotated = await database.rotateApiKey(created.id, 'salt:newhash', 'sel-2');
    expect(rotated?.key_selector).toBe('sel-2');
  });

  it('returns null when rotating a missing key', async () => {
    await expect(database.rotateApiKey('missing', 'h')).resolves.toBeNull();
  });

  it('counts keys that still lack a selector', async () => {
    await database.createApiKey(apiKeyInput());
    await expect(database.backfillKeySelectors()).resolves.toBe(0);

    store.insertApiKey({
      id: 'legacy',
      name: 'legacy',
      key_hash: 'salt:legacy',
      scope: [],
      created_by: 'user-1',
      created_at: new Date('2026-01-01T00:00:00.000Z'),
      updated_at: new Date('2026-01-01T00:00:00.000Z'),
      is_active: true,
    } as ApiKey);

    await expect(database.backfillKeySelectors()).resolves.toBe(1);
  });
});

describe('listApiKeysPage', () => {
  const seedKey = (id: string, createdAt: string) =>
    store.insertApiKey({
      id,
      name: id,
      key_hash: `hash-${id}`,
      key_selector: `sel-${id}`,
      scope: [],
      created_by: 'user-1',
      created_at: new Date(createdAt),
      updated_at: new Date(createdAt),
      is_active: true,
    } as ApiKey);

  it('returns a newest-first page with no cursor when the set is exhausted', async () => {
    seedKey('a', '2026-01-02T00:00:00.000Z');
    seedKey('b', '2026-01-01T00:00:00.000Z');

    const page = await database.listApiKeysPage('user-1');

    expect(page.data.map(k => k.id)).toEqual(['a', 'b']);
    expect(page.hasNextPage).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it('walks every record exactly once across cursor pages', async () => {
    seedKey('a', '2026-01-04T00:00:00.000Z');
    seedKey('b', '2026-01-03T00:00:00.000Z');
    seedKey('c', '2026-01-02T00:00:00.000Z');

    const first = await database.listApiKeysPage('user-1', { limit: 2 });
    expect(first.data.map(k => k.id)).toEqual(['a', 'b']);
    expect(first.hasNextPage).toBe(true);
    expect(first.nextCursor).not.toBeNull();

    const second = await database.listApiKeysPage('user-1', {
      limit: 2,
      cursor: first.nextCursor as string,
    });
    expect(second.data.map(k => k.id)).toEqual(['c']);
    expect(second.hasNextPage).toBe(false);
    expect(second.nextCursor).toBeNull();
  });

  it('breaks ties on identical timestamps by descending id', async () => {
    seedKey('a', '2026-01-01T00:00:00.000Z');
    seedKey('b', '2026-01-01T00:00:00.000Z');
    seedKey('c', '2026-01-01T00:00:00.000Z');

    const first = await database.listApiKeysPage('user-1', { limit: 2 });
    expect(first.data.map(k => k.id)).toEqual(['c', 'b']);

    const second = await database.listApiKeysPage('user-1', {
      limit: 2,
      cursor: first.nextCursor as string,
    });
    expect(second.data.map(k => k.id)).toEqual(['a']);
  });

  it('excludes other owners and inactive keys', async () => {
    seedKey('a', '2026-01-02T00:00:00.000Z');
    store.insertApiKey({
      id: 'other',
      name: 'other',
      key_hash: 'hash-other',
      scope: [],
      created_by: 'user-2',
      created_at: new Date('2026-01-03T00:00:00.000Z'),
      updated_at: new Date('2026-01-03T00:00:00.000Z'),
      is_active: true,
    } as ApiKey);

    const created = await database.createApiKey(apiKeyInput({ key_selector: 'sel-x' }));
    await database.deactivateApiKey(created.id);

    const page = await database.listApiKeysPage('user-1');
    expect(page.data.map(k => k.id)).toEqual(['a']);
  });

  it('falls back to the default limit for non-positive input', async () => {
    seedKey('a', '2026-01-01T00:00:00.000Z');

    const page = await database.listApiKeysPage('user-1', { limit: 0 });
    expect(page.limit).toBeGreaterThan(0);
    expect(page.data.map(k => k.id)).toEqual(['a']);
  });
});

describe('legacy JSON import', () => {
  it('imports records once and ignores repeat runs', () => {
    const legacy = {
      contract_metadata: [
        {
          id: 'legacy-md',
          contract_id: 'contract-9',
          key: 'k',
          value: 'v',
          data_type: 'string',
          is_sensitive: false,
          created_by: 'user-1',
          created_at: new Date('2026-01-01T00:00:00.000Z'),
          updated_at: new Date('2026-01-01T00:00:00.000Z'),
        } as ContractMetadata,
      ],
      api_keys: [
        {
          id: 'legacy-key',
          name: 'legacy',
          key_hash: 'salt:legacy',
          scope: ['read'],
          created_by: 'user-1',
          created_at: new Date('2026-01-01T00:00:00.000Z'),
          updated_at: new Date('2026-01-01T00:00:00.000Z'),
          is_active: true,
        } as ApiKey,
      ],
    };

    expect(store.importFromJson(legacy)).toEqual({ metadata: 1, apiKeys: 1 });

    // Idempotent: a second pass inserts nothing and overwrites nothing.
    expect(store.importFromJson(legacy)).toEqual({ metadata: 0, apiKeys: 0 });

    expect(store.findMetadataById('legacy-md')?.value).toBe('v');
    expect(store.findApiKeyById('legacy-key')?.scope).toEqual(['read']);
  });

  it('accepts a payload with neither collection present', () => {
    expect(store.importFromJson({})).toEqual({ metadata: 0, apiKeys: 0 });
  });
});
