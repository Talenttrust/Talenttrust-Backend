// src/retention/archival.test.ts

import { DataArchivalService } from './archival';
import { StorageManager, InMemoryStorageProvider } from './storage';
import { RetentionPolicyEngine } from './policies';
import { ArchivalStorageType, DataEntityType, DataClassification, RetainedData } from './types';

describe('DataArchivalService - Listing and Stats', () => {
  let service: DataArchivalService;
  let manager: StorageManager;

  const createData = (id: string, storage: ArchivalStorageType, isArchived: boolean = true): RetainedData => ({
    id,
    entityType: DataEntityType.CONTRACT,
    data: { contractId: id },
    classification: DataClassification.CONFIDENTIAL,
    createdAt: new Date('2024-01-01'),
    expiresAt: new Date('2025-01-01'),
    isArchived,
    archivedAt: isArchived ? new Date('2025-01-02') : undefined,
    archivedLocation: isArchived ? `/archive/${storage}/${id}` : undefined,
  });

  beforeEach(() => {
    const localProvider = new InMemoryStorageProvider();
    const archiveProvider = new InMemoryStorageProvider();
    manager = new StorageManager(localProvider, archiveProvider);
    const engine = new RetentionPolicyEngine();
    service = new DataArchivalService(manager, engine, false);

    // Seed data across storage types
    const dataA = createData('a', ArchivalStorageType.COLD_STORAGE);
    const dataB = createData('b', ArchivalStorageType.ENCRYPTED_ARCHIVE);
    const dataC = createData('c', ArchivalStorageType.COLD_STORAGE);
    const dataD = createData('d', ArchivalStorageType.ENCRYPTED_ARCHIVE);
    // Store directly via manager to simulate already archived data
    manager.store(dataA, ArchivalStorageType.COLD_STORAGE);
    manager.store(dataB, ArchivalStorageType.ENCRYPTED_ARCHIVE);
    manager.store(dataC, ArchivalStorageType.COLD_STORAGE);
    manager.store(dataD, ArchivalStorageType.ENCRYPTED_ARCHIVE);
  });

  test('listArchivedData returns all items when no storage filter', async () => {
    const all = await service.listArchivedData();
    // Should return 4 items (2 per storage type)
    expect(all).toHaveLength(4);
    const ids = all.map(d => d.id).sort();
    expect(ids).toEqual(['a', 'b', 'c', 'd']);
  });

  test('listArchivedData filters by storage type', async () => {
    const cold = await service.listArchivedData(ArchivalStorageType.COLD_STORAGE);
    expect(cold).toHaveLength(2);
    expect(cold.map(d => d.id).sort()).toEqual(['a', 'c']);

    const encrypted = await service.listArchivedData(ArchivalStorageType.ENCRYPTED_ARCHIVE);
    expect(encrypted).toHaveLength(2);
    expect(encrypted.map(d => d.id).sort()).toEqual(['b', 'd']);
  });

  test('listArchivedData pagination works', async () => {
    const firstTwo = await service.listArchivedData(undefined, 2, 0);
    expect(firstTwo).toHaveLength(2);

    const nextTwo = await service.listArchivedData(undefined, 2, 2);
    expect(nextTwo).toHaveLength(2);
    // Ensure no overlap
    const ids = [...firstTwo, ...nextTwo].map(d => d.id).sort();
    expect(ids).toEqual(['a', 'b', 'c', 'd']);
  });

  test('getArchiveStats aggregates correctly', async () => {
    const stats = await service.getArchiveStats();
    expect(stats.totalArchived).toBe(4);
    expect(stats.byStorageType[ArchivalStorageType.COLD_STORAGE]).toBe(2);
    expect(stats.byStorageType[ArchivalStorageType.ENCRYPTED_ARCHIVE]).toBe(2);
    // other storage types should be present with 0 count
    expect(stats.byStorageType[ArchivalStorageType.LOCAL] || 0).toBe(0);
    expect(stats.byStorageType[ArchivalStorageType.CLOUD] || 0).toBe(0);
  });
});
