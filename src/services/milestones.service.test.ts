import { ContractBoundsError, MAX_MILESTONES_PER_CONTRACT, MAX_CONTRACT_AMOUNT_STROOPS } from '../contracts/bounds';
import { SoftDeleteRetentionError } from '../utils/softDelete';
import {
  MilestoneConflictError,
  MilestoneNotFoundError,
  MilestonesService,
  MILESTONES_SOFT_DELETE_RETENTION_DAYS_ENV,
} from './milestones.service';

describe('MilestonesService', () => {
  let milestonesService: MilestonesService;

  beforeEach(() => {
    milestonesService = new MilestonesService();
    milestonesService.clearStore();
    delete process.env[MILESTONES_SOFT_DELETE_RETENTION_DAYS_ENV];
  });

  afterEach(() => {
    milestonesService.clearStore();
    delete process.env[MILESTONES_SOFT_DELETE_RETENTION_DAYS_ENV];
  });

  describe('validateMilestonesAgainstBudget', () => {
    it('validates successfully when there are no milestones', () => {
      expect(() => {
        milestonesService.validateMilestonesAgainstBudget(1000, undefined);
      }).not.toThrow();
    });

    it('validates successfully with valid milestones and budget', () => {
      const milestones = [
        { title: 'M1', amount: 500 },
        { title: 'M2', amount: 500 },
      ];
      expect(() => {
        milestonesService.validateMilestonesAgainstBudget(1000, milestones as any);
      }).not.toThrow();
    });

    it('throws ContractBoundsError when budget exceeds maximum', () => {
      expect(() => {
        milestonesService.validateMilestonesAgainstBudget(MAX_CONTRACT_AMOUNT_STROOPS + 1);
      }).toThrow(ContractBoundsError);
    });

    it('throws ContractBoundsError when total milestone amount exceeds contract budget', () => {
      const milestones = [{ title: 'M1', amount: 1500 }];
      expect(() => {
        milestonesService.validateMilestonesAgainstBudget(1000, milestones as any);
      }).toThrow(/Total milestone amount exceeds maximum contract amount/);
    });

    it('throws ContractBoundsError when milestone count exceeds max allowed', () => {
      const milestones = Array.from({ length: MAX_MILESTONES_PER_CONTRACT + 1 }, (_, i) => ({
        title: `M${i}`,
        amount: 1,
      }));
      expect(() => {
        milestonesService.validateMilestonesAgainstBudget(1000, milestones as any);
      }).toThrow(/Milestone count/);
    });
  });

  describe('soft-delete lifecycle', () => {
    const contractId = 'contract-softdelete-1';

    function seed() {
      return milestonesService.create(contractId, {
        title: 'Design',
        description: 'Mockups',
        amount: 1_000_000,
      });
    }

    it('create + list returns active milestone; soft-delete hides it from default reads', () => {
      const created = seed();
      expect(milestonesService.listByContract(contractId)).toHaveLength(1);
      expect(milestonesService.getById(contractId, created.id).id).toBe(created.id);

      const deleted = milestonesService.softDelete(contractId, created.id);
      expect(deleted.deletedAt).toBeInstanceOf(Date);

      expect(milestonesService.listByContract(contractId)).toHaveLength(0);
      expect(() => milestonesService.getById(contractId, created.id)).toThrow(MilestoneNotFoundError);

      const withDeleted = milestonesService.listByContract(contractId, { includeDeleted: true });
      expect(withDeleted).toHaveLength(1);
      expect(withDeleted[0]!.deletedAt).toBeInstanceOf(Date);
    });

    it('restore within retention window makes the milestone visible again', () => {
      process.env[MILESTONES_SOFT_DELETE_RETENTION_DAYS_ENV] = '30';
      const created = seed();
      const deletedAt = new Date('2026-01-01T00:00:00.000Z');
      milestonesService.softDelete(contractId, created.id, deletedAt);

      const restored = milestonesService.restore(
        contractId,
        created.id,
        new Date('2026-01-10T00:00:00.000Z'),
      );
      expect(restored.deletedAt).toBeNull();
      expect(milestonesService.listByContract(contractId)).toHaveLength(1);
    });

    it('restore past retention window throws SoftDeleteRetentionError', () => {
      process.env[MILESTONES_SOFT_DELETE_RETENTION_DAYS_ENV] = '30';
      const created = seed();
      milestonesService.softDelete(
        contractId,
        created.id,
        new Date('2026-01-01T00:00:00.000Z'),
      );

      expect(() =>
        milestonesService.restore(
          contractId,
          created.id,
          new Date('2026-03-01T00:00:00.000Z'),
        ),
      ).toThrow(SoftDeleteRetentionError);
    });

    it('purgeExpired hard-deletes only past-window soft-deleted records', () => {
      process.env[MILESTONES_SOFT_DELETE_RETENTION_DAYS_ENV] = '30';
      const keep = seed();
      const purgeTarget = milestonesService.create(contractId, {
        title: 'Old',
        amount: 100,
      });
      const recentDeleted = milestonesService.create(contractId, {
        title: 'Recent',
        amount: 100,
      });

      milestonesService.softDelete(
        contractId,
        purgeTarget.id,
        new Date('2025-01-01T00:00:00.000Z'),
      );
      milestonesService.softDelete(
        contractId,
        recentDeleted.id,
        new Date('2026-07-01T00:00:00.000Z'),
      );

      const purged = milestonesService.purgeExpired(new Date('2026-07-20T00:00:00.000Z'));
      expect(purged).toBe(1);
      expect(milestonesService.storeSize()).toBe(2);
      expect(milestonesService.getById(contractId, keep.id).id).toBe(keep.id);
      expect(
        milestonesService.getById(contractId, recentDeleted.id, { includeDeleted: true }).id,
      ).toBe(recentDeleted.id);
      expect(() =>
        milestonesService.getById(contractId, purgeTarget.id, { includeDeleted: true }),
      ).toThrow(MilestoneNotFoundError);
    });

    it('soft-deleting twice yields conflict; restoring active yields conflict', () => {
      const created = seed();
      milestonesService.softDelete(contractId, created.id);
      expect(() => milestonesService.softDelete(contractId, created.id)).toThrow(
        MilestoneConflictError,
      );

      const active = seed();
      expect(() => milestonesService.restore(contractId, active.id)).toThrow(
        MilestoneConflictError,
      );
    });

    it('rejects operations for unknown milestone or wrong contract', () => {
      const created = seed();
      expect(() => milestonesService.softDelete('other-contract', created.id)).toThrow(
        MilestoneNotFoundError,
      );
      expect(() => milestonesService.softDelete(contractId, 'missing-id')).toThrow(
        MilestoneNotFoundError,
      );
      expect(() => milestonesService.restore(contractId, 'missing-id')).toThrow(
        MilestoneNotFoundError,
      );
    });

    it('reads retention days from env', () => {
      expect(milestonesService.getRetentionDays()).toBe(30);
      process.env[MILESTONES_SOFT_DELETE_RETENTION_DAYS_ENV] = '14';
      expect(milestonesService.getRetentionDays()).toBe(14);
    });

    it('sorts listed milestones by createdAt ascending', () => {
      const first = milestonesService.create(contractId, { title: 'First', amount: 1 });
      const second = milestonesService.create(contractId, { title: 'Second', amount: 2 });
      const listed = milestonesService.listByContract(contractId);
      expect(listed.map((m) => m.id)).toEqual([first.id, second.id]);
    });

    it('getById with includeDeleted returns soft-deleted records', () => {
      const created = seed();
      milestonesService.softDelete(contractId, created.id);
      const found = milestonesService.getById(contractId, created.id, { includeDeleted: true });
      expect(found.deletedAt).toBeInstanceOf(Date);
    });
  });

  describe('create — field defaults', () => {
    const contractId = 'contract-defaults-1';

    it('defaults description to empty string when not supplied', () => {
      const m = milestonesService.create(contractId, { title: 'T', amount: 100 });
      expect(m.description).toBe('');
    });

    it('defaults completed to false when not supplied', () => {
      const m = milestonesService.create(contractId, { title: 'T', amount: 100 });
      expect(m.completed).toBe(false);
    });

    it('stores explicit description and completed values', () => {
      const m = milestonesService.create(contractId, {
        title: 'T',
        amount: 100,
        description: 'Some detail',
        completed: true,
      });
      expect(m.description).toBe('Some detail');
      expect(m.completed).toBe(true);
    });

    it('stores optional deadline when supplied', () => {
      const deadline = '2026-12-31T23:59:59.000Z';
      const m = milestonesService.create(contractId, { title: 'T', amount: 100, deadline });
      expect(m.deadline).toBe(deadline);
    });

    it('omits deadline from record when not supplied', () => {
      const m = milestonesService.create(contractId, { title: 'T', amount: 100 });
      expect(m.deadline).toBeUndefined();
    });

    it('sets deletedAt to null on a freshly created record', () => {
      const m = milestonesService.create(contractId, { title: 'T', amount: 100 });
      expect(m.deletedAt).toBeNull();
    });
  });

  describe('listByContract — contract isolation', () => {
    it('does not return milestones belonging to a different contract', () => {
      const contractA = 'contract-iso-A';
      const contractB = 'contract-iso-B';
      milestonesService.create(contractA, { title: 'A', amount: 1 });
      milestonesService.create(contractB, { title: 'B', amount: 2 });

      const listA = milestonesService.listByContract(contractA);
      expect(listA).toHaveLength(1);
      expect(listA[0]!.title).toBe('A');

      const listB = milestonesService.listByContract(contractB);
      expect(listB).toHaveLength(1);
      expect(listB[0]!.title).toBe('B');
    });

    it('returns empty array for a contract that has no milestones', () => {
      const listed = milestonesService.listByContract('contract-empty-99');
      expect(listed).toEqual([]);
    });
  });

  describe('getById — wrong contract mismatch', () => {
    it('throws MilestoneNotFoundError when milestoneId exists but contractId is wrong', () => {
      const contractId = 'contract-mismatch-1';
      const m = milestonesService.create(contractId, { title: 'X', amount: 50 });
      expect(() =>
        milestonesService.getById('wrong-contract', m.id),
      ).toThrow(MilestoneNotFoundError);
    });
  });

  describe('purgeExpired — edge cases', () => {
    const contractId = 'contract-purge-edge';

    beforeEach(() => {
      process.env[MILESTONES_SOFT_DELETE_RETENTION_DAYS_ENV] = '30';
    });

    it('returns 0 when there are no soft-deleted records at all', () => {
      milestonesService.create(contractId, { title: 'Active', amount: 1 });
      const purged = milestonesService.purgeExpired(new Date());
      expect(purged).toBe(0);
    });

    it('returns 0 when the store is completely empty', () => {
      expect(milestonesService.purgeExpired(new Date())).toBe(0);
    });

    it('does not purge a record that is deleted exactly at the boundary (not yet past)', () => {
      const m = milestonesService.create(contractId, { title: 'Boundary', amount: 1 });
      const deletedAt = new Date('2026-01-01T00:00:00.000Z');
      milestonesService.softDelete(contractId, m.id, deletedAt);

      // exactly at the retention boundary — isWithinRetentionWindow uses <=
      const atBoundary = new Date(
        deletedAt.getTime() + 30 * 24 * 60 * 60 * 1000,
      );
      const purged = milestonesService.purgeExpired(atBoundary);
      expect(purged).toBe(0);
      // record still present
      expect(
        milestonesService.getById(contractId, m.id, { includeDeleted: true }).id,
      ).toBe(m.id);
    });

    it('purges a record that is one millisecond past the boundary', () => {
      const m = milestonesService.create(contractId, { title: 'OverBoundary', amount: 1 });
      const deletedAt = new Date('2026-01-01T00:00:00.000Z');
      milestonesService.softDelete(contractId, m.id, deletedAt);

      // one ms past the boundary
      const pastBoundary = new Date(
        deletedAt.getTime() + 30 * 24 * 60 * 60 * 1000 + 1,
      );
      const purged = milestonesService.purgeExpired(pastBoundary);
      expect(purged).toBe(1);
      expect(() =>
        milestonesService.getById(contractId, m.id, { includeDeleted: true }),
      ).toThrow(MilestoneNotFoundError);
    });
  });

  describe('validateBounds', () => {
    it('does not throw for valid milestones within policy caps', () => {
      expect(() =>
        milestonesService.validateBounds(1_000_000, [{ title: 'M', amount: 500 } as any]),
      ).not.toThrow();
    });

    it('throws ContractBoundsError when milestone count exceeds MAX_MILESTONES_PER_CONTRACT', () => {
      const milestones = Array.from({ length: MAX_MILESTONES_PER_CONTRACT + 1 }, (_, i) => ({
        title: `M${i}`,
        amount: 1,
      }));
      expect(() =>
        milestonesService.validateBounds(999_999, milestones as any),
      ).toThrow(ContractBoundsError);
    });
  });
});
