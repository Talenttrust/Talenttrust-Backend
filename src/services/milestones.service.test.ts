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
});
