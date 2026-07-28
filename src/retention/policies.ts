/**
 * Data Retention Policies Engine
 * 
 * Manages retention policies and determines when data should be archived
 * or deleted based on configured retention periods and compliance rules.
 * 
 * @module retention/policies
 */

import {
  RetentionPolicy as _RetentionPolicy,
  RetentionPeriod as _RetentionPeriod,
  DataEntityType as _DataEntityType,
  DataClassification as _DataClassification,
  ArchivalStorageType as _ArchivalStorageType,
  RetainedData as _RetainedData,
  RetentionStatus as _RetentionStatus,
} from './types';

export type RetentionPolicy = _RetentionPolicy;
export type RetainedData = _RetainedData;
export type RetentionStatus = _RetentionStatus;
export const RetentionPeriod = _RetentionPeriod;
export const DataEntityType = _DataEntityType;
export const DataClassification = _DataClassification;
export const ArchivalStorageType = _ArchivalStorageType;

/**
 * Retention period durations in milliseconds
 * @private
 * @type {Record<RetentionPeriod, number>}
 */
const PERIOD_DURATIONS: Record<RetentionPeriod, number> = {
  [RetentionPeriod.THIRTY_DAYS]: 30 * 24 * 60 * 60 * 1000,
  [RetentionPeriod.NINETY_DAYS]: 90 * 24 * 60 * 60 * 1000,
  [RetentionPeriod.SIX_MONTHS]: 180 * 24 * 60 * 60 * 1000,
  [RetentionPeriod.ONE_YEAR]: 365 * 24 * 60 * 60 * 1000,
  [RetentionPeriod.TWO_YEARS]: 730 * 24 * 60 * 60 * 1000,
  [RetentionPeriod.INDEFINITE]: Number.MAX_SAFE_INTEGER,
};

/**
 * Ordered list of retention periods from shortest to longest.
 * Used to find the smallest period that satisfies a legal minimum.
 * @private
 */
const PERIOD_ORDER: RetentionPeriod[] = [
  RetentionPeriod.THIRTY_DAYS,
  RetentionPeriod.NINETY_DAYS,
  RetentionPeriod.SIX_MONTHS,
  RetentionPeriod.ONE_YEAR,
  RetentionPeriod.TWO_YEARS,
  RetentionPeriod.INDEFINITE,
];

/**
 * Legal minimum retention periods per entity type.
 *
 * These represent the shortest retention an operator may configure for
 * each entity type.  An override shorter than the legal minimum is
 * rejected at startup.
 *
 * @see {@link getLegalMinimums} for the runtime accessor.
 */
const LEGAL_MINIMUMS: Record<DataEntityType, RetentionPeriod> = {
  [DataEntityType.CONTRACT]: RetentionPeriod.ONE_YEAR,
  [DataEntityType.TRANSACTION]: RetentionPeriod.ONE_YEAR,
  [DataEntityType.AUDIT_LOG]: RetentionPeriod.TWO_YEARS,
  [DataEntityType.USER_PROFILE]: RetentionPeriod.THIRTY_DAYS,
  [DataEntityType.DOCUMENT]: RetentionPeriod.NINETY_DAYS,
  [DataEntityType.MESSAGE]: RetentionPeriod.THIRTY_DAYS,
};

/**
 * Default retention periods per entity type.
 * Used when no policy and no override is configured.
 */
const DEFAULT_PERIODS: Record<DataEntityType, RetentionPeriod> = {
  [DataEntityType.CONTRACT]: RetentionPeriod.NINETY_DAYS,
  [DataEntityType.TRANSACTION]: RetentionPeriod.NINETY_DAYS,
  [DataEntityType.AUDIT_LOG]: RetentionPeriod.NINETY_DAYS,
  [DataEntityType.USER_PROFILE]: RetentionPeriod.NINETY_DAYS,
  [DataEntityType.DOCUMENT]: RetentionPeriod.NINETY_DAYS,
  [DataEntityType.MESSAGE]: RetentionPeriod.NINETY_DAYS,
};

/**
 * Return the legal minimum retention period for each entity type.
 *
 * @returns {Readonly<Record<DataEntityType, RetentionPeriod>>} Copy of the
 *   legal-minimum map.
 */
export function getLegalMinimums(): Readonly<Record<DataEntityType, RetentionPeriod>> {
  return { ...LEGAL_MINIMUMS };
}

/**
 * Return the default retention period for each entity type.
 *
 * @returns {Readonly<Record<DataEntityType, RetentionPeriod>>} Copy of the
 *   default-period map.
 */
export function getDefaultPeriods(): Readonly<Record<DataEntityType, RetentionPeriod>> {
  return { ...DEFAULT_PERIODS };
}

/**
 * Resolve the effective retention period for an entity type, taking the
 * override (if any) and the legal minimum into account.
 *
 * @param {DataEntityType} entityType - Entity type to resolve.
 * @param {Record<string, string>} [overrides] - Operator overrides from env.
 * @returns {RetentionPeriod} The effective period.
 */
export function resolvePeriod(
  entityType: DataEntityType,
  overrides?: Record<string, string>,
): RetentionPeriod {
  const minimum = LEGAL_MINIMUMS[entityType];
  const overrideValue = overrides?.[entityType] as RetentionPeriod | undefined;

  if (overrideValue && PERIOD_ORDER.includes(overrideValue)) {
    // Enforce the legal minimum: pick the larger of the override and the minimum.
    if (PERIOD_ORDER.indexOf(overrideValue) >= PERIOD_ORDER.indexOf(minimum)) {
      return overrideValue;
    }
    // Override is below the legal minimum — clamp to the minimum.
    return minimum;
  }

  // No valid override; use the default.
  return DEFAULT_PERIODS[entityType];
}

/**
 * Policy management and enforcement engine
 * 
 * Handles creation, validation, and application of retention policies
 * to control data lifecycle management.
 * 
 * @class RetentionPolicyEngine
 */
export class RetentionPolicyEngine {
  private policies: Map<string, RetentionPolicy> = new Map();
  private entityDefaults: Map<DataEntityType, RetentionPolicy> = new Map();

  /**
   * Apply per-entity retention overrides loaded from environment
   * configuration.
   *
   * For each entity type that appears in `overrides`, the engine:
   * 1. Picks the larger of the override value and the legal minimum.
   * 2. Creates a default policy for that entity type (if one doesn't
   *    already exist) with the resolved period.
   *
   * @param {Record<string, string>} overrides - Map of
   *   `DataEntityType → RetentionPeriod` parsed from
   *   `RETENTION_OVERRIDES`.
   * @returns {RetentionPolicy[]} The policies that were created or
   *   updated as a result of applying overrides.
   */
  applyOverrides(overrides: Record<string, string>): RetentionPolicy[] {
    const applied: RetentionPolicy[] = [];

    for (const [entityTypeStr, periodStr] of Object.entries(overrides)) {
      const entityType = entityTypeStr as DataEntityType;
      if (!Object.values(DataEntityType).includes(entityType)) continue;

      const resolvedPeriod = resolvePeriod(entityType, overrides);
      const existing = this.entityDefaults.get(entityType);

      if (existing) {
        // Update the existing default policy's period if it changed.
        if (existing.period !== resolvedPeriod) {
          existing.period = resolvedPeriod;
          existing.updatedAt = new Date();
          applied.push(existing);
        }
      } else {
        // Create a new default policy for this entity type.
        const classification =
          entityType === DataEntityType.AUDIT_LOG
            ? DataClassification.RESTRICTED
            : entityType === DataEntityType.TRANSACTION
              ? DataClassification.CONFIDENTIAL
              : DataClassification.INTERNAL;

        const policy = this.createPolicy({
          name: `Default ${entityType} policy (env override)`,
          description: `Auto-generated default policy for ${entityType} from RETENTION_OVERRIDES`,
          entityType,
          period: resolvedPeriod,
          classification,
          archivalType: ArchivalStorageType.COLD_STORAGE,
          encryptArchive: classification === DataClassification.RESTRICTED || classification === DataClassification.CONFIDENTIAL,
          allowPermanentRetention: false,
          isActive: true,
        });

        this.entityDefaults.set(entityType, policy);
        applied.push(policy);
      }
    }

    return applied;
  }

  /**
   * Return the full set of effective, resolved policies — one per
   * entity type — with the period that would actually be used for
   * expiration calculations.
   *
   * This method is intended for audit and observability: operators
   * can inspect it to verify that overrides have been applied
   * correctly.
   *
   * @returns {Record<DataEntityType, { period: RetentionPeriod;
   *   source: 'override' | 'default' }>} The resolved policy map.
   */
  getResolvedPolicies(): Record<
    DataEntityType,
    { period: RetentionPeriod; source: 'override' | 'default' }
  > {
    const result = {} as Record<
      DataEntityType,
      { period: RetentionPeriod; source: 'override' | 'default' }
    >;

    for (const entityType of Object.values(DataEntityType)) {
      const defaultPolicy = this.entityDefaults.get(entityType);
      if (defaultPolicy) {
        const isOverride =
          defaultPolicy.name.includes('(env override)');
        result[entityType] = {
          period: defaultPolicy.period,
          source: isOverride ? 'override' : 'default',
        };
      } else {
        result[entityType] = {
          period: DEFAULT_PERIODS[entityType],
          source: 'default',
        };
      }
    }

    return result;
  }

  /**
   * Create and register a retention policy
   * 
   * @param {Omit<RetentionPolicy, 'id' | 'createdAt' | 'updatedAt'>} config - Policy configuration
   * @returns {RetentionPolicy} Created policy with generated metadata
   * @throws {Error} If policy configuration is invalid
   */
  createPolicy(config: Omit<RetentionPolicy, 'id' | 'createdAt' | 'updatedAt'>): RetentionPolicy {
    this.validatePolicyConfig(config);

    const policy: RetentionPolicy = {
      ...config,
      id: this.generatePolicyId(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.policies.set(policy.id, policy);
    return policy;
  }

  /**
   * Update an existing policy
   * @param {string} policyId - Policy identifier
   * @param {Partial<Omit<RetentionPolicy, 'id' | 'createdAt'>>} updates - Fields to update
   * @returns {RetentionPolicy} Updated policy
   * @throws {Error} If policy not found or update is invalid
   */
  updatePolicy(
    policyId: string,
    updates: Partial<Omit<RetentionPolicy, 'id' | 'createdAt'>>,
  ): RetentionPolicy {
    const policy = this.policies.get(policyId);
    if (!policy) {
      throw new Error(`Policy not found: ${policyId}`);
    }

    const updated: RetentionPolicy = {
      ...policy,
      ...updates,
      id: policy.id,
      createdAt: policy.createdAt,
      updatedAt: new Date(),
    };

    this.validatePolicyConfig(updated);
    this.policies.set(policyId, updated);
    return updated;
  }

  /**
   * Retrieve a policy by ID
   * @param {string} policyId - Policy identifier
   * @returns {RetentionPolicy | undefined}
   */
  getPolicy(policyId: string): RetentionPolicy | undefined {
    return this.policies.get(policyId);
  }

  /**
   * Get all active policies
   * @returns {RetentionPolicy[]}
   */
  getActivePolicies(): RetentionPolicy[] {
    return Array.from(this.policies.values()).filter(p => p.isActive);
  }

  /**
   * Get policies for specific entity type
   * @param {DataEntityType} entityType - Entity type
   * @returns {RetentionPolicy[]}
   */
  getPoliciesForEntityType(entityType: DataEntityType): RetentionPolicy[] {
    return Array.from(this.policies.values()).filter(
      p => p.entityType === entityType && p.isActive,
    );
  }

  /**
   * Set default policy for entity type
   * @param {DataEntityType} entityType - Entity type
   * @param {string} policyId - Policy identifier
   * @throws {Error} If policy not found
   */
  setDefaultPolicyForEntityType(entityType: DataEntityType, policyId: string): void {
    const policy = this.policies.get(policyId);
    if (!policy) {
      throw new Error(`Policy not found: ${policyId}`);
    }
    if (policy.entityType !== entityType) {
      throw new Error(`Policy entity type mismatch: expected ${entityType}, got ${policy.entityType}`);
    }
    this.entityDefaults.set(entityType, policy);
  }

  /**
   * Get default policy for entity type
   * @param {DataEntityType} entityType - Entity type
   * @returns {RetentionPolicy | undefined}
   */
  getDefaultPolicyForEntityType(entityType: DataEntityType): RetentionPolicy | undefined {
    return this.entityDefaults.get(entityType);
  }

  /**
   * Deactivate a policy
   * @param {string} policyId - Policy identifier
   * @returns {boolean} Success status
   */
  deactivatePolicy(policyId: string): boolean {
    const policy = this.policies.get(policyId);
    if (!policy) return false;

    policy.isActive = false;
    policy.updatedAt = new Date();
    return true;
  }

  /**
   * Delete a policy
   * @param {string} policyId - Policy identifier
   * @returns {boolean} Success status
   */
  deletePolicy(policyId: string): boolean {
    return this.policies.delete(policyId);
  }

  /**
   * Calculate expiration date for data based on applicable policy
   * @param {RetainedData} data - Data entity
   * @returns {Date} Expiration timestamp
   */
  calculateExpirationDate(data: RetainedData): Date {
    const policy = data.retentionPolicyId ? this.policies.get(data.retentionPolicyId) : null;
    const effectivePolicy = policy || this.getDefaultPolicyForEntityType(data.entityType);

    const duration = effectivePolicy
      ? PERIOD_DURATIONS[effectivePolicy.period]
      : PERIOD_DURATIONS[resolvePeriod(data.entityType)];

    const expirationTime = data.createdAt.getTime() + duration;
    return new Date(expirationTime);
  }

  /**
   * Determine retention status for data
   * 
   * @param {RetainedData} data - Data entity
   * @returns {RetentionStatus} Current retention status and actions
   */
  determineRetentionStatus(data: RetainedData): RetentionStatus {
    const expiresAt = data.expiresAt;
    const now = new Date();
    const timeUntilExpiry = expiresAt.getTime() - now.getTime();
    const daysUntilExpiry = Math.ceil(timeUntilExpiry / (24 * 60 * 60 * 1000));

    let needsAction = false;
    let actionRequired: string | undefined;

    if (data.isArchived && daysUntilExpiry < 0) {
      needsAction = true;
      actionRequired = 'Data archive has expired and should be deleted';
    } else if (!data.isArchived && daysUntilExpiry < 0) {
      needsAction = true;
      actionRequired = 'Data has expired and should be archived';
    } else if (!data.isArchived && daysUntilExpiry <= 7) {
      needsAction = true;
      actionRequired = 'Data expiration approaching (7 days or less)';
    }

    return {
      dataId: data.id,
      createdAt: data.createdAt,
      expiresAt,
      daysUntilExpiry,
      isArchived: data.isArchived,
      archivedLocation: data.archivedLocation,
      needsAction,
      actionRequired,
    };
  }

  /**
   * Check if data meets archival criteria based on policy
   * @param {RetainedData} data - Data entity
   * @returns {boolean}
   */
  shouldArchive(data: RetainedData): boolean {
    if (data.isArchived) return false;

    const expiresAt = data.expiresAt;
    const now = new Date();

    // Archive data that has expired
    return now >= expiresAt;
  }

  /**
   * Check if data should be permanently deleted
   * @param {RetainedData} data - Data entity
   * @param {number} postArchivalDays - Days to keep after archival
   * @returns {boolean}
   */
  shouldPermanentlyDelete(data: RetainedData, postArchivalDays: number): boolean {
    if (!data.isArchived || !data.archivedAt) return false;

    const deleteAt = new Date(data.archivedAt.getTime() + postArchivalDays * 24 * 60 * 60 * 1000);
    const now = new Date();

    return now >= deleteAt;
  }

  /**
   * Validate policy configuration
   * @private
   * @param {any} config - Configuration to validate
   * @throws {Error} If configuration is invalid
   */
  private validatePolicyConfig(config: any): void {
    if (!config.name || config.name.trim().length === 0) {
      throw new Error('Policy name is required and cannot be empty');
    }

    if (!config.entityType || !Object.values(DataEntityType).includes(config.entityType)) {
      throw new Error('Invalid or missing entity type');
    }

    if (!config.period || !Object.values(RetentionPeriod).includes(config.period)) {
      throw new Error('Invalid or missing retention period');
    }

    if (!config.classification || !Object.values(DataClassification).includes(config.classification)) {
      throw new Error('Invalid or missing data classification');
    }

    if (!config.archivalType || !Object.values(ArchivalStorageType).includes(config.archivalType)) {
      throw new Error('Invalid or missing archival storage type');
    }
  }

  /**
   * Generate unique policy ID
   * @private
   * @returns {string}
   */
  private generatePolicyId(): string {
    return `policy_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}
