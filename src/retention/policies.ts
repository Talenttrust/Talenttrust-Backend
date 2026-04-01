/**
 * Data Retention Policies Engine
 * 
 * Manages retention policies and determines when data should be archived
 * or deleted based on configured retention periods and compliance rules.
 * 
 * @module retention/policies
 */

import {
  RetentionPolicy,
  RetentionPeriod,
  DataEntityType,
  DataClassification,
  ArchivalStorageType,
  RetainedData,
  RetentionStatus,
} from './types';

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
      : PERIOD_DURATIONS[RetentionPeriod.NINETY_DAYS];

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
