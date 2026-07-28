/**
 * Unit Tests for Data Purge Module
 *
 * Tests for dry-run mode and purge functionality.
 *
 * @test
 */

import {
  executePurge,
  runPurge,
  isDryRunFromEnv,
  isDryRunFromArgs,
  PurgeResult,
  PurgeCandidateCount,
} from './purge';
import { StorageManager, InMemoryStorageProvider, ArchivalStorageType, DataClassification, DataEntityType } from './index';

describe('Purge Module', () => {
  let storageManager: StorageManager;
  let localProvider: InMemoryStorageProvider;
  let coldProvider: InMemoryStorageProvider;

  beforeEach(() => {
    localProvider = new InMemoryStorageProvider();
    coldProvider = new InMemoryStorageProvider();
    storageManager = new StorageManager(localProvider, coldProvider);
  });

  // Helper to create test data
  const createTestData = (
    id: string,
    options: {
      isArchived?: boolean;
      expired?: boolean;
      archivedDaysAgo?: number;
    } = {},
  ) => {
    const now = Date.now();
    const expired = options.expired ?? false;
    const isArchived = options.isArchived ?? false;
    const archivedDaysAgo = options.archivedDaysAgo ?? 0;

    return {
      id,
      entityType: DataEntityType.CONTRACT,
      data: { contractId: `contract-${id}` },
      classification: DataClassification.CONFIDENTIAL,
      createdAt: new Date(now - 100 * 24 * 60 * 60 * 1000),
      expiresAt: expired ? new Date(now - 10 * 24 * 60 * 60 * 1000) : new Date(now + 10 * 24 * 60 * 60 * 1000),
      isArchived,
      archivedAt: isArchived && archivedDaysAgo > 0 ? new Date(now - archivedDaysAgo * 24 * 60 * 60 * 1000) : undefined,
    };
  };

  describe('isDryRunFromEnv', () => {
    const originalEnv = process.env.RETENTION_DRY_RUN;

    afterEach(() => {
      // Restore original env
      if (originalEnv === undefined) {
        delete process.env.RETENTION_DRY_RUN;
      } else {
        process.env.RETENTION_DRY_RUN = originalEnv;
      }
    });

    it('should return true when RETENTION_DRY_RUN is "true"', () => {
      process.env.RETENTION_DRY_RUN = 'true';
      expect(isDryRunFromEnv()).toBe(true);
    });

    it('should return false when RETENTION_DRY_RUN is "false"', () => {
      process.env.RETENTION_DRY_RUN = 'false';
      expect(isDryRunFromEnv()).toBe(false);
    });

    it('should return false when RETENTION_DRY_RUN is not set', () => {
      delete process.env.RETENTION_DRY_RUN;
      expect(isDryRunFromEnv()).toBe(false);
    });

    it('should return false for other values', () => {
      process.env.RETENTION_DRY_RUN = 'yes';
      expect(isDryRunFromEnv()).toBe(false);
    });
  });

  describe('isDryRunFromArgs', () => {
    it('should return true for --dry-run flag', () => {
      expect(isDryRunFromArgs(['node', 'script.js', '--dry-run'])).toBe(true);
    });

    it('should return true for --dry-run=true flag', () => {
      expect(isDryRunFromArgs(['node', 'script.js', '--dry-run=true'])).toBe(true);
    });

    it('should return false when no dry-run flag', () => {
      expect(isDryRunFromArgs(['node', 'script.js'])).toBe(false);
    });

    it('should return false for --dry-run=false', () => {
      expect(isDryRunFromArgs(['node', 'script.js', '--dry-run=false'])).toBe(false);
    });

    it('should work with custom args array', () => {
      expect(isDryRunFromArgs(['--dry-run'])).toBe(true);
      expect(isDryRunFromArgs(['--other-flag'])).toBe(false);
    });
  });

  describe('executePurge', () => {
    describe('dry-run mode', () => {
      it('should not delete any data in dry-run mode', async () => {
        // Add expired data
        const expiredData = createTestData('expired-1', { expired: true });
        await localProvider.store(expiredData);

        // Verify data exists
        const beforeCount = (await localProvider.list()).length;
        expect(beforeCount).toBe(1);

        // Run dry-run purge
        const result = await executePurge(storageManager, 30, { dryRun: true });

        // Verify no data was deleted
        const afterCount = (await localProvider.list()).length;
        expect(afterCount).toBe(1);
        expect(result.dryRun).toBe(true);
        expect(result.deleted).toBe(0);
      });

      it('should report candidate counts in dry-run mode', async () => {
        // Add multiple expired items
        await localProvider.store(createTestData('expired-1', { expired: true }));
        await localProvider.store(createTestData('expired-2', { expired: true }));
        await localProvider.store(createTestData('not-expired', { expired: false }));

        // Add archived data past retention
        await coldProvider.store(createTestData('archived-1', { isArchived: true, archivedDaysAgo: 40 }));
        await coldProvider.store(createTestData('archived-2', { isArchived: true, archivedDaysAgo: 35 }));

        const result = await executePurge(storageManager, 30, { dryRun: true });

        expect(result.dryRun).toBe(true);
        expect(result.candidates).toBeDefined();
        expect(result.candidates.length).toBeGreaterThan(0);

        // Find local_data count (should be 2 expired items)
        const localCandidate = result.candidates.find(c => c.table === 'local_data');
        expect(localCandidate).toBeDefined();
        expect(localCandidate!.count).toBe(2);
      });

      it('should use same query logic as real purge', async () => {
        // Setup test data
        await localProvider.store(createTestData('expired-1', { expired: true }));
        await localProvider.store(createTestData('expired-2', { expired: true }));
        await coldProvider.store(createTestData('archived-1', { isArchived: true, archivedDaysAgo: 40 }));

        // Get dry-run counts
        const dryRunResult = await executePurge(storageManager, 30, { dryRun: true });

        // Run actual purge on same data
        const purgeResult = await executePurge(storageManager, 30, { dryRun: false });

        // Counts should match
        expect(dryRunResult.candidates).toEqual(purgeResult.candidates);
      });
    });

    describe('real purge mode', () => {
      it('should delete expired non-archived data', async () => {
        // Add expired and non-expired data
        await localProvider.store(createTestData('expired-1', { expired: true }));
        await localProvider.store(createTestData('expired-2', { expired: true }));
        await localProvider.store(createTestData('not-expired', { expired: false }));

        const result = await executePurge(storageManager, 30, { dryRun: false });

        expect(result.dryRun).toBe(false);
        expect(result.deleted).toBe(2);

        // Verify only non-expired remains
        const remaining = await localProvider.list();
        expect(remaining.length).toBe(1);
        expect(remaining[0].id).toBe('not-expired');
      });

      it('should delete archived data past retention period', async () => {
        // Add archived data with different ages
        await coldProvider.store(createTestData('archived-old', { isArchived: true, archivedDaysAgo: 40 }));
        await coldProvider.store(createTestData('archived-recent', { isArchived: true, archivedDaysAgo: 10 }));

        const result = await executePurge(storageManager, 30, { dryRun: false });

        // Only the old archived data should be deleted
        expect(result.deleted).toBe(1);

        const remaining = await coldProvider.list();
        expect(remaining.length).toBe(1);
        expect(remaining[0].id).toBe('archived-recent');
      });

      it('should not delete non-expired data', async () => {
        await localProvider.store(createTestData('active-1', { expired: false }));
        await localProvider.store(createTestData('active-2', { expired: false }));

        const result = await executePurge(storageManager, 30, { dryRun: false });

        expect(result.deleted).toBe(0);
        expect((await localProvider.list()).length).toBe(2);
      });
    });

    describe('candidate counting', () => {
      it('should count candidates correctly per table', async () => {
        // Local storage: 2 expired, 1 not expired
        await localProvider.store(createTestData('local-expired-1', { expired: true }));
        await localProvider.store(createTestData('local-expired-2', { expired: true }));
        await localProvider.store(createTestData('local-active', { expired: false }));

        // Cold storage: 1 old archived, 1 recent archived
        await coldProvider.store(createTestData('cold-old', { isArchived: true, archivedDaysAgo: 40 }));
        await coldProvider.store(createTestData('cold-recent', { isArchived: true, archivedDaysAgo: 10 }));

        const result = await executePurge(storageManager, 30, { dryRun: true });

        const localCount = result.candidates.find(c => c.table === 'local_data');
        const coldCount = result.candidates.find(c => c.table === 'cold_storage');

        expect(localCount?.count).toBe(2);
        expect(coldCount?.count).toBe(1);
      });

      it('should handle empty storage', async () => {
        const result = await executePurge(storageManager, 30, { dryRun: true });

        expect(result.candidates).toBeDefined();
        expect(result.candidates.every(c => c.count === 0)).toBe(true);
      });
    });
  });

  describe('runPurge', () => {
    it('should accept dryRun parameter', async () => {
      await localProvider.store(createTestData('test', { expired: true }));

      // Dry-run
      const dryResult = await runPurge(storageManager, 30, true);
      expect(dryResult.dryRun).toBe(true);
      expect((await localProvider.list()).length).toBe(1);

      // Real purge
      const realResult = await runPurge(storageManager, 30, false);
      expect(realResult.dryRun).toBe(false);
      expect((await localProvider.list()).length).toBe(0);
    });
  });

  describe('dry-run reported counts match actual purge counts', () => {
    it('should report same counts for dry-run and real purge on same fixture', async () => {
      // Create a comprehensive fixture
      // Local: expired and active
      await localProvider.store(createTestData('local-expired-1', { expired: true }));
      await localProvider.store(createTestData('local-expired-2', { expired: true }));
      await localProvider.store(createTestData('local-expired-3', { expired: true }));
      await localProvider.store(createTestData('local-active-1', { expired: false }));
      await localProvider.store(createTestData('local-active-2', { expired: false }));

      // Cold storage: various archival ages
      await coldProvider.store(createTestData('cold-40d', { isArchived: true, archivedDaysAgo: 40 }));
      await coldProvider.store(createTestData('cold-35d', { isArchived: true, archivedDaysAgo: 35 }));
      await coldProvider.store(createTestData('cold-20d', { isArchived: true, archivedDaysAgo: 20 }));
      await coldProvider.store(createTestData('cold-10d', { isArchived: true, archivedDaysAgo: 10 }));

      // Run dry-run first
      const dryRunResult = await executePurge(storageManager, 30, { dryRun: true });

      // Then run real purge
      const purgeResult = await executePurge(storageManager, 30, { dryRun: false });

      // Verify counts match
      expect(dryRunResult.candidates).toEqual(purgeResult.candidates);

      // Verify the actual deletion count matches the sum of candidate counts
      const totalCandidates = dryRunResult.candidates.reduce((sum, c) => sum + c.count, 0);
      expect(purgeResult.deleted).toBe(totalCandidates);
    });

    it('should have matching counts across multiple storage types', async () => {
      // Setup data in multiple storage types
      await localProvider.store(createTestData('local-1', { expired: true }));
      await coldProvider.store(createTestData('cold-1', { isArchived: true, archivedDaysAgo: 50 }));

      const dryRunResult = await executePurge(storageManager, 30, { dryRun: true });
      const purgeResult = await executePurge(storageManager, 30, { dryRun: false });

      // Each table's count should match
      for (const dryCandidate of dryRunResult.candidates) {
        const purgeCandidate = purgeResult.candidates.find(c => c.table === dryCandidate.table);
        expect(purgeCandidate).toBeDefined();
        expect(purgeCandidate!.count).toBe(dryCandidate.count);
      }
    });
  });
});
