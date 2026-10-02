/**
 * Unit Tests for Per-Entity Retention Policy Overrides
 *
 * Covers override parsing, legal-minimum enforcement, resolved-policy
 * inspection, and integration with RetentionPolicyEngine.
 *
 * @test
 */

import {
  RetentionPolicyEngine,
  DataEntityType,
  RetentionPeriod,
  DataClassification,
  ArchivalStorageType,
  getLegalMinimums,
  getDefaultPeriods,
  resolvePeriod,
} from './policies';

describe('retention policy overrides', () => {
  // ─── getLegalMinimums ──────────────────────────────────────────────────

  describe('getLegalMinimums', () => {
    it('returns a copy of the legal-minimum map', () => {
      const mins = getLegalMinimums();
      expect(mins[DataEntityType.CONTRACT]).toBe(RetentionPeriod.ONE_YEAR);
      expect(mins[DataEntityType.TRANSACTION]).toBe(RetentionPeriod.ONE_YEAR);
      expect(mins[DataEntityType.AUDIT_LOG]).toBe(RetentionPeriod.TWO_YEARS);
      expect(mins[DataEntityType.USER_PROFILE]).toBe(RetentionPeriod.THIRTY_DAYS);
      expect(mins[DataEntityType.DOCUMENT]).toBe(RetentionPeriod.NINETY_DAYS);
      expect(mins[DataEntityType.MESSAGE]).toBe(RetentionPeriod.THIRTY_DAYS);
    });

    it('returns a new object each call (defensive copy)', () => {
      const a = getLegalMinimums();
      const b = getLegalMinimums();
      expect(a).not.toBe(b);
      expect(a).toEqual(b);
    });
  });

  // ─── getDefaultPeriods ─────────────────────────────────────────────────

  describe('getDefaultPeriods', () => {
    it('defaults all entity types to 90 days', () => {
      const defaults = getDefaultPeriods();
      for (const entityType of Object.values(DataEntityType)) {
        expect(defaults[entityType]).toBe(RetentionPeriod.NINETY_DAYS);
      }
    });
  });

  // ─── resolvePeriod ─────────────────────────────────────────────────────

  describe('resolvePeriod', () => {
    it('returns the default period when no overrides are given', () => {
      expect(resolvePeriod(DataEntityType.CONTRACT)).toBe(RetentionPeriod.NINETY_DAYS);
    });

    it('applies a valid override above the legal minimum', () => {
      const overrides = { contract: '2y' };
      expect(resolvePeriod(DataEntityType.CONTRACT, overrides)).toBe(RetentionPeriod.TWO_YEARS);
    });

    it('clamps an override that is below the legal minimum', () => {
      // Legal minimum for CONTRACT is 1y; override 30d should be clamped to 1y
      const overrides = { contract: '30d' };
      expect(resolvePeriod(DataEntityType.CONTRACT, overrides)).toBe(RetentionPeriod.ONE_YEAR);
    });

    it('accepts an override equal to the legal minimum', () => {
      const overrides = { contract: '1y' };
      expect(resolvePeriod(DataEntityType.CONTRACT, overrides)).toBe(RetentionPeriod.ONE_YEAR);
    });

    it('handles indefinite override for audit_log (above 2y minimum)', () => {
      const overrides = { audit_log: 'indefinite' };
      expect(resolvePeriod(DataEntityType.AUDIT_LOG, overrides)).toBe(RetentionPeriod.INDEFINITE);
    });

    it('clamps audit_log override below 2y to 2y', () => {
      const overrides = { audit_log: '90d' };
      expect(resolvePeriod(DataEntityType.AUDIT_LOG, overrides)).toBe(RetentionPeriod.TWO_YEARS);
    });

    it('ignores unknown entity types in overrides', () => {
      const overrides = { unknown_type: '2y' };
      expect(resolvePeriod(DataEntityType.CONTRACT, overrides)).toBe(RetentionPeriod.NINETY_DAYS);
    });

    it('ignores invalid period values in overrides', () => {
      const overrides = { contract: '5y' };
      expect(resolvePeriod(DataEntityType.CONTRACT, overrides)).toBe(RetentionPeriod.NINETY_DAYS);
    });
  });

  // ─── RetentionPolicyEngine.applyOverrides ──────────────────────────────

  describe('RetentionPolicyEngine.applyOverrides', () => {
    let engine: RetentionPolicyEngine;

    beforeEach(() => {
      engine = new RetentionPolicyEngine();
    });

    it('creates default policies for each overridden entity type', () => {
      const overrides = {
        contract: '2y',
        transaction: '1y',
      };

      const applied = engine.applyOverrides(overrides);
      expect(applied).toHaveLength(2);

      const contractDefault = engine.getDefaultPolicyForEntityType(DataEntityType.CONTRACT);
      expect(contractDefault).toBeDefined();
      expect(contractDefault!.period).toBe(RetentionPeriod.TWO_YEARS);
      expect(contractDefault!.name).toContain('(env override)');

      const txDefault = engine.getDefaultPolicyForEntityType(DataEntityType.TRANSACTION);
      expect(txDefault).toBeDefined();
      expect(txDefault!.period).toBe(RetentionPeriod.ONE_YEAR);
    });

    it('clamps overrides below legal minimum to the legal minimum', () => {
      const overrides = { audit_log: '30d' }; // below 2y minimum
      const applied = engine.applyOverrides(overrides);

      expect(applied).toHaveLength(1);
      const policy = engine.getDefaultPolicyForEntityType(DataEntityType.AUDIT_LOG);
      expect(policy!.period).toBe(RetentionPeriod.TWO_YEARS);
    });

    it('does not duplicate policies when called twice with the same overrides', () => {
      const overrides = { contract: '2y' };
      engine.applyOverrides(overrides);
      const applied = engine.applyOverrides(overrides);

      // Second call should not create new policies; period unchanged.
      expect(applied).toHaveLength(0);
    });

    it('updates an existing default policy when the period changes', () => {
      engine.applyOverrides({ contract: '2y' });
      const applied = engine.applyOverrides({ contract: 'indefinite' });

      expect(applied).toHaveLength(1);
      const policy = engine.getDefaultPolicyForEntityType(DataEntityType.CONTRACT);
      expect(policy!.period).toBe(RetentionPeriod.INDEFINITE);
    });

    it('skips unknown entity types silently', () => {
      const applied = engine.applyOverrides({ unknown_type: '2y' } as any);
      expect(applied).toHaveLength(0);
    });

    it('returns an empty array when overrides is empty', () => {
      const applied = engine.applyOverrides({});
      expect(applied).toHaveLength(0);
    });

    it('assigns RESTRICTED classification to audit_log overrides', () => {
      engine.applyOverrides({ audit_log: 'indefinite' });
      const policy = engine.getDefaultPolicyForEntityType(DataEntityType.AUDIT_LOG);
      expect(policy!.classification).toBe(DataClassification.RESTRICTED);
      expect(policy!.encryptArchive).toBe(true);
    });

    it('assigns CONFIDENTIAL classification to transaction overrides', () => {
      engine.applyOverrides({ transaction: '2y' });
      const policy = engine.getDefaultPolicyForEntityType(DataEntityType.TRANSACTION);
      expect(policy!.classification).toBe(DataClassification.CONFIDENTIAL);
      expect(policy!.encryptArchive).toBe(true);
    });

    it('assigns INTERNAL classification to other entity types', () => {
      engine.applyOverrides({ message: '1y' });
      const policy = engine.getDefaultPolicyForEntityType(DataEntityType.MESSAGE);
      expect(policy!.classification).toBe(DataClassification.INTERNAL);
      expect(policy!.encryptArchive).toBe(false);
    });
  });

  // ─── RetentionPolicyEngine.getResolvedPolicies ─────────────────────────

  describe('RetentionPolicyEngine.getResolvedPolicies', () => {
    let engine: RetentionPolicyEngine;

    beforeEach(() => {
      engine = new RetentionPolicyEngine();
    });

    it('returns default periods for all entity types when no overrides applied', () => {
      const resolved = engine.getResolvedPolicies();

      for (const entityType of Object.values(DataEntityType)) {
        expect(resolved[entityType]).toEqual({
          period: RetentionPeriod.NINETY_DAYS,
          source: 'default',
        });
      }
    });

    it('marks overridden entity types with source "override"', () => {
      engine.applyOverrides({ contract: '2y', audit_log: 'indefinite' });
      const resolved = engine.getResolvedPolicies();

      expect(resolved[DataEntityType.CONTRACT]).toEqual({
        period: RetentionPeriod.TWO_YEARS,
        source: 'override',
      });
      expect(resolved[DataEntityType.AUDIT_LOG]).toEqual({
        period: RetentionPeriod.INDEFINITE,
        source: 'override',
      });
      // Non-overridden types remain default
      expect(resolved[DataEntityType.MESSAGE]).toEqual({
        period: RetentionPeriod.NINETY_DAYS,
        source: 'default',
      });
    });

    it('reflects clamped periods in resolved output', () => {
      engine.applyOverrides({ audit_log: '30d' }); // below 2y minimum
      const resolved = engine.getResolvedPolicies();

      expect(resolved[DataEntityType.AUDIT_LOG]).toEqual({
        period: RetentionPeriod.TWO_YEARS,
        source: 'override',
      });
    });
  });

  // ─── calculateExpirationDate integration ───────────────────────────────

  describe('calculateExpirationDate with overrides', () => {
    it('uses the overridden period when no explicit policy is set', () => {
      const engine = new RetentionPolicyEngine();
      engine.applyOverrides({ contract: '2y' });

      const data = {
        id: 'test-1',
        entityType: DataEntityType.CONTRACT,
        data: {},
        classification: DataClassification.INTERNAL,
        createdAt: new Date('2025-01-01'),
        expiresAt: new Date('2025-01-01'),
        isArchived: false,
      };

      const expiresAt = engine.calculateExpirationDate(data);
      // 2 years from 2025-01-01
      const expectedMs = new Date('2025-01-01').getTime() + 730 * 24 * 60 * 60 * 1000;
      expect(expiresAt.getTime()).toBe(expectedMs);
    });

    it('falls back to the default 90-day period when no override exists', () => {
      const engine = new RetentionPolicyEngine();

      const data = {
        id: 'test-2',
        entityType: DataEntityType.MESSAGE,
        data: {},
        classification: DataClassification.INTERNAL,
        createdAt: new Date('2025-01-01'),
        expiresAt: new Date('2025-01-01'),
        isArchived: false,
      };

      const expiresAt = engine.calculateExpirationDate(data);
      const expectedMs = new Date('2025-01-01').getTime() + 90 * 24 * 60 * 60 * 1000;
      expect(expiresAt.getTime()).toBe(expectedMs);
    });

    it('still respects an explicitly set policy over overrides', () => {
      const engine = new RetentionPolicyEngine();
      engine.applyOverrides({ contract: '2y' });

      // Create an explicit policy with a different period
      const explicitPolicy = engine.createPolicy({
        name: 'Custom Contract Policy',
        description: 'Explicit override',
        entityType: DataEntityType.CONTRACT,
        period: RetentionPeriod.SIX_MONTHS,
        classification: DataClassification.CONFIDENTIAL,
        archivalType: ArchivalStorageType.COLD_STORAGE,
        encryptArchive: true,
        allowPermanentRetention: false,
        isActive: true,
      });

      const data = {
        id: 'test-3',
        entityType: DataEntityType.CONTRACT,
        data: {},
        classification: DataClassification.INTERNAL,
        createdAt: new Date('2025-01-01'),
        expiresAt: new Date('2025-01-01'),
        isArchived: false,
        retentionPolicyId: explicitPolicy.id,
      };

      const expiresAt = engine.calculateExpirationDate(data);
      const expectedMs = new Date('2025-01-01').getTime() + 180 * 24 * 60 * 60 * 1000;
      expect(expiresAt.getTime()).toBe(expectedMs);
    });
  });
});
