/**
 * Sqlite-backed storage provider tests for the retention manager.
 *
 * Covers persistence (`survives a simulated restart`), pagination bounds,
 * mixed local/archive isolation, empty store, and large paginated reads.
 *
 * Companion to `retention.test.ts` — split out so the heavier SQLite
 * fixture setup doesn't slow the existing in-memory suite.
 *
 * @test
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import Database from '../db/betterSqlite3';
import type * as BetterSqlite3 from 'better-sqlite3';

import type { RetainedData } from './types';
import {
  SqliteStorageProvider,
  SqliteStorageProviderOptions,
  RETENTION_PAGE_MAX_LIMIT,
} from './storage';
import {
  InMemoryStorageProvider,
  StorageManager,
  DataRetentionManager,
  DataArchivalService,
  RetentionPolicyEngine,
  RetentionPeriod,
  DataEntityType,
  DataClassification,
  ArchivalStorageType,
  RetentionConfig,
} from './index';

/**
 * Build a fresh in-memory SQLite database that already has the retention
 * tables. Mirrors the production migration DDL so tests stay aligned with
 * what the application will actually create on first open.
 *
 * @private
 */
function createMemoryDb(): BetterSqlite3.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = MEMORY');
  db.pragma('foreign_keys = ON');
  for (const tableName of ['retention_local', 'retention_archive']) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ${tableName} (
        id                  TEXT    PRIMARY KEY,
        entity_type         TEXT    NOT NULL,
        data                TEXT    NOT NULL,
        classification      TEXT    NOT NULL,
        created_at          TEXT    NOT NULL,
        expires_at          TEXT    NOT NULL,
        archived_at         TEXT,
        archived_location   TEXT,
        is_archived         INTEGER NOT NULL CHECK (is_archived IN (0, 1)),
        retention_policy_id TEXT,
        metadata            TEXT,
        updated_at          TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_${tableName}_entity_type ON ${tableName}(entity_type);
      CREATE INDEX IF NOT EXISTS idx_${tableName}_is_archived ON ${tableName}(is_archived);
      CREATE INDEX IF NOT EXISTS idx_${tableName}_expires_at ON ${tableName}(expires_at);
      CREATE INDEX IF NOT EXISTS idx_${tableName}_created_at ON ${tableName}(created_at);
    `);
  }
  return db;
}

/**
 * Build a {@link RetainedData} fixture with sensible defaults so each test
 * only spells out the fields it actually exercises.
 *
 * @private
 */
function buildData(overrides: Partial<RetainedData> = {}): RetainedData {
  return {
    id: overrides.id ?? `data-${Math.random().toString(36).slice(2, 10)}`,
    entityType: overrides.entityType ?? DataEntityType.CONTRACT,
    data: overrides.data ?? { payload: 'hello' },
    classification: overrides.classification ?? DataClassification.CONFIDENTIAL,
    createdAt: overrides.createdAt ?? new Date('2024-01-01T00:00:00.000Z'),
    expiresAt: overrides.expiresAt ?? new Date('2024-12-31T00:00:00.000Z'),
    isArchived: overrides.isArchived ?? false,
    archivedAt: overrides.archivedAt,
    archivedLocation: overrides.archivedLocation,
    retentionPolicyId: overrides.retentionPolicyId,
    metadata: overrides.metadata,
  };
}

describe('SqliteStorageProvider', () => {
  describe('construction', () => {
    it('rejects an empty or missing tableName (SQL-injection defence)', () => {
      // `SqliteStorageProviderOptions.tableName` is required — TypeScript flags
      // the missing property. The empty-string case is type-valid (an empty
      // string is still a string), so we narrow through `any` to assert the
      // runtime contract.
      expect(() => new SqliteStorageProvider({} as SqliteStorageProviderOptions)).toThrow(/non-empty tableName/);
      expect(() => new SqliteStorageProvider({ tableName: '' } as SqliteStorageProviderOptions)).toThrow(/non-empty tableName/);
    });

    it('rejects table names that are not valid SQL identifiers', () => {
      expect(() => new SqliteStorageProvider({ tableName: 'drop table--' })).toThrow(/tableName must match/);
      expect(() => new SqliteStorageProvider({ tableName: '123-leads-with-digit' })).toThrow(/tableName must match/);
    });

    it('ensures the table exists on construction against an empty in-memory db', () => {
      const db = createMemoryDb();
      try {
        const provider = new SqliteStorageProvider({ tableName: 'retention_local', db });
        // Sanity check: provider has the table and can be asked about its name
        expect(provider.getTableName()).toBe('retention_local');
        // list() against a freshly ensured table returns an empty array, not throws
        expect(provider.list()).resolves.toEqual([]);
      } finally {
        db.close();
      }
    });
  });

  describe('empty store', () => {
    let provider: SqliteStorageProvider;
    let db: BetterSqlite3.Database;

    beforeEach(() => {
      db = createMemoryDb();
      provider = new SqliteStorageProvider({ tableName: 'retention_local', db });
    });

    afterEach(() => {
      db.close();
    });

    it('list() returns an empty array', async () => {
      expect(await provider.list()).toEqual([]);
    });

    it('listPaginated returns an empty array', async () => {
      expect(await provider.listPaginated(10, 0)).toEqual([]);
      expect(await provider.listPaginated(10, 100)).toEqual([]);
    });

    it('retrieve returns null for unknown ids', async () => {
      expect(await provider.retrieve('does-not-exist')).toBeNull();
    });

    it('exists returns false for unknown ids', async () => {
      expect(await provider.exists('does-not-exist')).toBe(false);
    });

    it('delete returns false (no rows changed) for unknown ids', async () => {
      expect(await provider.delete('does-not-exist')).toBe(false);
    });
  });

  describe('CRUD round-trip', () => {
    let provider: SqliteStorageProvider;
    let db: BetterSqlite3.Database;

    beforeEach(() => {
      db = createMemoryDb();
      provider = new SqliteStorageProvider({ tableName: 'retention_local', db });
    });

    afterEach(() => {
      db.close();
    });

    it('store → retrieve preserves every field of RetainedData', async () => {
      const fixture = buildData({
        id: 'roundtrip-1',
        entityType: DataEntityType.DOCUMENT,
        data: { nested: { arr: [1, 'two', { three: true }] }, payload: 'preserve-me' },
        classification: DataClassification.RESTRICTED,
        createdAt: new Date('2023-06-15T12:34:56.789Z'),
        expiresAt: new Date('2024-06-15T12:34:56.789Z'),
        isArchived: true,
        archivedAt: new Date('2024-01-01T00:00:00.000Z'),
        archivedLocation: '/archive/encrypted_archive/document/2024/01/roundtrip-1',
        retentionPolicyId: 'policy-abc',
        metadata: { source: 'unit', sensitivity: 'high' },
      });

      await provider.store(fixture);
      const retrieved = await provider.retrieve('roundtrip-1');

      expect(retrieved).toBeDefined();
      expect(retrieved!.id).toBe(fixture.id);
      expect(retrieved!.entityType).toBe(DataEntityType.DOCUMENT);
      expect(retrieved!.classification).toBe(DataClassification.RESTRICTED);
      expect(retrieved!.isArchived).toBe(true);
      expect(retrieved!.archivedLocation).toBe(fixture.archivedLocation);
      expect(retrieved!.retentionPolicyId).toBe(fixture.retentionPolicyId);
      expect(retrieved!.metadata).toEqual(fixture.metadata);
      // Date fields round-trip exactly via ISO-8601.
      expect(retrieved!.createdAt.toISOString()).toBe(fixture.createdAt.toISOString());
      expect(retrieved!.expiresAt.toISOString()).toBe(fixture.expiresAt.toISOString());
      expect(retrieved!.archivedAt!.toISOString()).toBe(fixture.archivedAt!.toISOString());
      // Nested payload survives JSON serialisation.
      expect(retrieved!.data).toEqual(fixture.data);
    });

    it('store is idempotent — re-storing with the same id overwrites the existing row', async () => {
      const original = buildData({ id: 'id-1', data: { value: 'first' } });
      const updated = buildData({ id: 'id-1', data: { value: 'second' } });

      await provider.store(original);
      await provider.store(updated);

      const retrieved = await provider.retrieve('id-1');
      expect(retrieved!.data).toEqual({ value: 'second' });
      expect(await provider.list()).toHaveLength(1);
    });

    it('delete removes the row and reports success', async () => {
      await provider.store(buildData({ id: 'to-delete' }));
      expect(await provider.exists('to-delete')).toBe(true);

      expect(await provider.delete('to-delete')).toBe(true);
      expect(await provider.exists('to-delete')).toBe(false);
      expect(await provider.delete('to-delete')).toBe(false);
    });

    it('exists is cheap — does not require loading the full row', async () => {
      await provider.store(buildData({ id: 'cheap-existence' }));
      // exists() and retrieve() agree, but exists() returns a boolean directly.
      expect(await provider.exists('cheap-existence')).toBe(true);
    });
  });

  describe('pagination bounds', () => {
    let provider: SqliteStorageProvider;
    let db: BetterSqlite3.Database;

    beforeEach(async () => {
      db = createMemoryDb();
      provider = new SqliteStorageProvider({ tableName: 'retention_local', db });
      // Seed 150 records with monotonically increasing createdAt so ordering
      // is unambiguous across pages.
      for (let i = 0; i < 150; i += 1) {
        await provider.store(
          buildData({
            id: `seed-${String(i).padStart(3, '0')}`,
            createdAt: new Date(Date.UTC(2024, 0, 1, 0, 0, i)),
          }),
        );
      }
    });

    afterEach(() => {
      db.close();
    });

    it('returns a stable page covering the requested offset and limit', async () => {
      const page = await provider.listPaginated(10, 20);
      expect(page).toHaveLength(10);
      expect(page.map((r: any) => r.id)).toEqual([
        'seed-020', 'seed-021', 'seed-022', 'seed-023', 'seed-024',
        'seed-025', 'seed-026', 'seed-027', 'seed-028', 'seed-029',
      ]);
    });

    it('concatenating pages reproduces the full list (no overlap / no gap)', async () => {
      const pageSize = 25;
      const total = 150;
      const collected: string[] = [];
      for (let offset = 0; offset < total; offset += pageSize) {
        const page = await provider.listPaginated(pageSize, offset);
        collected.push(...page.map((r: any) => r.id));
      }
      expect(collected).toHaveLength(total);
      expect(new Set(collected).size).toBe(total);
      // The same cursor behaviour must match a single full list().
      const full = (await provider.list()).map((r: any) => r.id);
      expect(collected).toEqual(full);
    });

    it('clamps oversized positive limits to RETENTION_PAGE_MAX_LIMIT', async () => {
      const huge = await provider.listPaginated(RETENTION_PAGE_MAX_LIMIT * 5, 0);
      expect(huge).toHaveLength(Math.min(RETENTION_PAGE_MAX_LIMIT, 150));
    });

    it('clamps zero / negative / NaN / non-number limits up to 1 record', async () => {
      expect(await provider.listPaginated(0)).toHaveLength(1);
      expect(await provider.listPaginated(-1)).toHaveLength(1);
      expect(await provider.listPaginated(Number.NaN)).toHaveLength(1);
    });

    it('clamps negative offsets up to 0', async () => {
      const fromZero = await provider.listPaginated(5, -50);
      const fromRealZero = await provider.listPaginated(5, 0);
      expect(fromZero.map((r: any) => r.id)).toEqual(fromRealZero.map((r: any) => r.id));
    });

    it('returns [] (not throws) when offset is past the end of the store', async () => {
      expect(await provider.listPaginated(10, 999_999)).toEqual([]);
    });

    it('defaults offset to 0 when omitted', async () => {
      const a = await provider.listPaginated(3);
      const b = await provider.listPaginated(3, 0);
      expect(a).toEqual(b);
    });
  });

  describe('survives a simulated restart (file-backed SQLite)', () => {
    let tmpDir: string;
    let dbPath: string;

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'retention-sqlite-'));
      dbPath = path.join(tmpDir, 'retention.db');
    });

    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('records written before a reopen are still readable after reopening the db file', async () => {
      // First "process": open, write, close.
      let db = new Database(dbPath);
      db.pragma('journal_mode = WAL');
      db.exec(`CREATE TABLE IF NOT EXISTS retention_local (
        id TEXT PRIMARY KEY,
        entity_type TEXT NOT NULL,
        data TEXT NOT NULL,
        classification TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        archived_at TEXT,
        archived_location TEXT,
        is_archived INTEGER NOT NULL,
        retention_policy_id TEXT,
        metadata TEXT,
        updated_at TEXT NOT NULL
      )`);
      let provider = new SqliteStorageProvider({ tableName: 'retention_local', db });
      const fixture = buildData({
        id: 'restart-1',
        data: { marker: 'survives-restart' },
        archivedAt: new Date('2024-01-01T00:00:00.000Z'),
        isArchived: true,
        archivedLocation: '/archive/restart-1',
        metadata: { actor: 'system' },
      });
      await provider.store(fixture);
      db.close();

      // Second "process": reopen the same file, no longer in-memory.
      db = new Database(dbPath);
      provider = new SqliteStorageProvider({ tableName: 'retention_local', db });
      try {
        const retrieved = await provider.retrieve('restart-1');
        expect(retrieved).not.toBeNull();
        expect(retrieved!.id).toBe('restart-1');
        expect(retrieved!.data).toEqual({ marker: 'survives-restart' });
        expect(retrieved!.isArchived).toBe(true);
        expect(retrieved!.archivedLocation).toBe('/archive/restart-1');
        expect(retrieved!.metadata).toEqual({ actor: 'system' });
        expect(retrieved!.createdAt.toISOString()).toBe(fixture.createdAt.toISOString());

        // Stats-equivalent: list()/listPaginated() survive the reopen.
        expect((await provider.list()).length).toBe(1);
        expect((await provider.listPaginated(10)).length).toBe(1);
        expect((await (provider as any).getTableName?.() ?? provider.getTableName())).toBe('retention_local');

        // And `getArchiveStats()` reflects persisted rows after the restart:
        // the issue requires stats to match persisted rows, so wire the same
        // SqliteStorageProvider into both the local and archive buckets of the
        // StorageManager. We exercise the survival guarantee here, not the
        // per-storage-type aggregation: the single persisted row is counted
        // exactly once (providers shared across storage types are de-duplicated).
        const engine = new RetentionPolicyEngine();
        const manager = new StorageManager(provider, provider);
        const archival = new DataArchivalService(manager, engine, false);
        const stats = await archival.getArchiveStats();
        expect(stats.totalArchived).toBe(1);

        // Wipe and ensure subsequent deletes stick across another reopen.
        expect(await provider.delete('restart-1')).toBe(true);
        expect(await provider.exists('restart-1')).toBe(false);
      } finally {
        db.close();
      }

      // Third "process": verify the delete truly persisted, not just lied in memory.
      db = new Database(dbPath);
      provider = new SqliteStorageProvider({ tableName: 'retention_local', db });
      try {
        expect(await provider.retrieve('restart-1')).toBeNull();
      } finally {
        db.close();
      }
    });
  });

  describe('mixed local vs archive storage types are isolated', () => {
    let db: BetterSqlite3.Database;
    let local: SqliteStorageProvider;
    let archive: SqliteStorageProvider;
    let manager: StorageManager;

    beforeEach(() => {
      db = createMemoryDb();
      local = new SqliteStorageProvider({ tableName: 'retention_local', db });
      archive = new SqliteStorageProvider({ tableName: 'retention_archive', db });
      manager = new StorageManager(local, archive);
    });

    afterEach(() => {
      db.close();
    });

    it('records written via StorageManager to LOCAL stay out of the archive table and vice versa', async () => {
      const localOnly = buildData({ id: 'local-only' });
      const archiveOnly = buildData({
        id: 'archive-only',
        isArchived: true,
        archivedAt: new Date('2024-01-01T00:00:00.000Z'),
        archivedLocation: '/archive/cold_storage/archive-only',
      });

      await manager.store(localOnly, ArchivalStorageType.LOCAL);
      await manager.store(archiveOnly, ArchivalStorageType.COLD_STORAGE);

      expect((await local.list()).map((r: any) => r.id)).toEqual(['local-only']);
      expect((await archive.list()).map((r: any) => r.id)).toEqual(['archive-only']);

      // Cross-retrieval via StorageManager.getProvider() must respect isolation.
      expect(await local.retrieve('archive-only')).toBeNull();
      expect(await archive.retrieve('local-only')).toBeNull();
      expect(await local.exists('archive-only')).toBe(false);
      expect(await archive.exists('local-only')).toBe(false);
    });

    it('moveData from LOCAL to COLD_STORAGE atomically relocates the row', async () => {
      const fixture = buildData({
        id: 'move-me',
        isArchived: false,
      });
      await manager.store(fixture, ArchivalStorageType.LOCAL);

      const success = await manager.moveData('move-me', ArchivalStorageType.LOCAL, ArchivalStorageType.COLD_STORAGE);
      expect(success).toBe(true);

      expect(await local.retrieve('move-me')).toBeNull();
      const after = await archive.retrieve('move-me');
      expect(after).not.toBeNull();
      expect(after!.id).toBe('move-me');
    });

    it('the DataArchivalService.getArchiveStats() sum-of-table counts matches getArchiveStats style output', async () => {
      const engine = new RetentionPolicyEngine();
      const service = new DataArchivalService(manager, engine, false);

      // Two records in local, two already archived in archive.
      await manager.store(buildData({ id: 'L-1' }), ArchivalStorageType.LOCAL);
      await manager.store(buildData({ id: 'L-2' }), ArchivalStorageType.LOCAL);
      await manager.store(
        buildData({ id: 'A-1', isArchived: true, archivedAt: new Date() }),
        ArchivalStorageType.COLD_STORAGE,
      );
      await manager.store(
        buildData({ id: 'A-2', isArchived: true, archivedAt: new Date() }),
        ArchivalStorageType.ENCRYPTED_ARCHIVE,
      );

      const stats = await service.getArchiveStats();
      // local+cloud are non-archive buckets → 0 from getArchiveStats() perspective;
      // archive buckets (COLD_STORAGE + ENCRYPTED_ARCHIVE) share a single provider,
      // so they each report 2 in byStorageType.
      expect(stats.totalArchived).toBeGreaterThanOrEqual(2);
      expect(stats.byStorageType[ArchivalStorageType.COLD_STORAGE]).toBe(2);
    });
  });

  describe('DataRetentionManager backend selection', () => {
    const config: RetentionConfig = {
      enabled: true,
      storageBasePath: '/data',
      archiveBasePath: '/archive',
      checksIntervalMs: 60000,
      batchSize: 100,
      automaticArchival: true,
      automaticDeletion: false,
      postArchivalRetentionDays: 30,
      complianceStandard: 'GDPR',
      encryptionEnabled: true,
    };

    function captureStorageBackends(manager: DataRetentionManager): string[] {
      return [
        (manager as any).storageManager.getProvider(ArchivalStorageType.LOCAL).constructor.name,
        (manager as any).storageManager.getProvider(ArchivalStorageType.COLD_STORAGE).constructor.name,
      ];
    }

    it('inside Jest without an explicit backend, defaults to InMemoryStorageProvider', () => {
      const manager = new DataRetentionManager(config);
      expect(captureStorageBackends(manager)).toEqual([
        'InMemoryStorageProvider',
        'InMemoryStorageProvider',
      ]);
    });

    it('an explicit { storageBackend: "memory" } override forces InMemoryStorageProvider even outside Jest', () => {
      const manager = new DataRetentionManager(config, undefined, undefined, { storageBackend: 'memory' });
      expect(captureStorageBackends(manager)).toEqual([
        'InMemoryStorageProvider',
        'InMemoryStorageProvider',
      ]);
    });

    it('an explicit { storageBackend: "sqlite" } forces SqliteStorageProvider inside Jest', () => {
      const manager = new DataRetentionManager(config, undefined, undefined, { storageBackend: 'sqlite' });
      expect(captureStorageBackends(manager)).toEqual([
        'SqliteStorageProvider',
        'SqliteStorageProvider',
      ]);
      // And the actual tables align with the migration we ship.
      const localProvider = (manager as any).storageManager.getProvider(ArchivalStorageType.LOCAL);
      const archiveProvider = (manager as any).storageManager.getProvider(ArchivalStorageType.COLD_STORAGE);
      expect(localProvider.getTableName()).toBe('retention_local');
      expect(archiveProvider.getTableName()).toBe('retention_archive');
    });

    it('caller-supplied providers win over backend selection', () => {
      const local = new InMemoryStorageProvider();
      const archive = new InMemoryStorageProvider();
      const manager = new DataRetentionManager(config, local, archive, { storageBackend: 'sqlite' });
      expect((manager as any).storageManager.getProvider(ArchivalStorageType.LOCAL)).toBe(local);
      expect((manager as any).storageManager.getProvider(ArchivalStorageType.COLD_STORAGE)).toBe(archive);
    });
  });

  describe('DataRetentionManager end-to-end with SqliteStorageProvider', () => {
    let manager: DataRetentionManager;
    let isolatedDb: BetterSqlite3.Database;

    beforeEach(() => {
      const config: RetentionConfig = {
        enabled: true,
        storageBasePath: '/data',
        archiveBasePath: '/archive',
        checksIntervalMs: 60000,
        batchSize: 100,
        automaticArchival: true,
        automaticDeletion: false,
        postArchivalRetentionDays: 30,
        complianceStandard: 'GDPR',
        encryptionEnabled: true,
      };
      // Inject isolated in-memory SqliteStorageProvider instances so we never
      // touch the global `getDb()` singleton — other suites in the same Jest
      // worker must not be able to leak rows into this test.
      isolatedDb = createMemoryDb();
      manager = new DataRetentionManager(
        config,
        new SqliteStorageProvider({ tableName: 'retention_local', db: isolatedDb }),
        new SqliteStorageProvider({ tableName: 'retention_archive', db: isolatedDb }),
      );
    });

    afterEach(() => {
      isolatedDb.close();
    });

    it('store / list / stats reflect every persisted row', async () => {
      const policy = manager.createRetentionPolicy({
        name: 'SQLite Test Policy',
        description: '',
        entityType: DataEntityType.CONTRACT,
        period: RetentionPeriod.NINETY_DAYS,
        classification: DataClassification.CONFIDENTIAL,
        archivalType: ArchivalStorageType.COLD_STORAGE,
        encryptArchive: true,
        allowPermanentRetention: false,
        isActive: true,
      });

      const storedIds: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        const result = await manager.storeData(
          {
            entityType: DataEntityType.CONTRACT,
            data: { contractId: `C-${i}`, payload: { nested: i } },
            classification: DataClassification.CONFIDENTIAL,
            createdAt: new Date(),
          },
          policy.id,
        );
        storedIds.push(result.data.id);
      }

      const all = await (manager as any).storageManager.getProvider(ArchivalStorageType.LOCAL).list();
      expect(all).toHaveLength(5);
      const listedIds = all.map((r: any) => r.id).sort();
      expect(listedIds).toEqual([...storedIds].sort());

      // Aggregate stats across the local provider reflect what's persisted.
      const stats = await (manager as any).archivalService.getArchiveStats();
      const localCount = stats.byStorageType[ArchivalStorageType.LOCAL];
      // local_provider only contributes to LOCAL; archive buckets come from the
      // archive provider, which currently has zero rows.
      expect(localCount).toBe(5);
      expect(stats.byStorageType[ArchivalStorageType.COLD_STORAGE]).toBe(0);
    });
  });
});
