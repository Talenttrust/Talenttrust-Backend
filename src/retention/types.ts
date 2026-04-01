/**
 * Data Retention Control Types and Interfaces
 * 
 * Provides type definitions for configurable data retention and archival
 * policies to support compliance and data governance requirements.
 * 
 * @module retention/types
 */

/**
 * Supported data retention periods
 * @enum {string}
 */
export enum RetentionPeriod {
  THIRTY_DAYS = '30d',
  NINETY_DAYS = '90d',
  SIX_MONTHS = '6m',
  ONE_YEAR = '1y',
  TWO_YEARS = '2y',
  INDEFINITE = 'indefinite',
}

/**
 * Data classification levels for compliance
 * @enum {string}
 */
export enum DataClassification {
  PUBLIC = 'public',
  INTERNAL = 'internal',
  CONFIDENTIAL = 'confidential',
  RESTRICTED = 'restricted',
}

/**
 * Archival storage types
 * @enum {string}
 */
export enum ArchivalStorageType {
  LOCAL = 'local',
  CLOUD = 'cloud',
  COLD_STORAGE = 'cold_storage',
  ENCRYPTED_ARCHIVE = 'encrypted_archive',
}

/**
 * Retention action types for audit logging
 * @enum {string}
 */
export enum RetentionAction {
  CREATE = 'create',
  UPDATE = 'update',
  ARCHIVE = 'archive',
  DELETE = 'delete',
  RESTORE = 'restore',
  POLICY_APPLIED = 'policy_applied',
  RETENTION_EXPIRED = 'retention_expired',
}

/**
 * Data entity types that can be retained
 * @enum {string}
 */
export enum DataEntityType {
  CONTRACT = 'contract',
  USER_PROFILE = 'user_profile',
  TRANSACTION = 'transaction',
  AUDIT_LOG = 'audit_log',
  DOCUMENT = 'document',
  MESSAGE = 'message',
}

/**
 * Configuration for a data retention policy
 * 
 * @interface RetentionPolicy
 * @property {string} id - Unique policy identifier
 * @property {string} name - Human-readable policy name
 * @property {string} description - Policy description for compliance documentation
 * @property {DataEntityType} entityType - Type of data this policy applies to
 * @property {RetentionPeriod} period - How long data should be retained
 * @property {DataClassification} classification - Data classification level
 * @property {ArchivalStorageType} archivalType - Where to archive expired data
 * @property {boolean} encryptArchive - Whether to encrypt archived data
 * @property {boolean} allowPermanentRetention - Allow override for indefinite retention
 * @property {boolean} isActive - Whether this policy is currently enforced
 * @property {Date} createdAt - Policy creation timestamp
 * @property {Date} updatedAt - Last policy update timestamp
 */
export interface RetentionPolicy {
  id: string;
  name: string;
  description: string;
  entityType: DataEntityType;
  period: RetentionPeriod;
  classification: DataClassification;
  archivalType: ArchivalStorageType;
  encryptArchive: boolean;
  allowPermanentRetention: boolean;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Data entity with retention metadata
 * 
 * @interface RetainedData
 * @property {string} id - Unique data identifier
 * @property {DataEntityType} entityType - Type of data entity
 * @property {unknown} data - The actual data payload
 * @property {DataClassification} classification - Data sensitivity level
 * @property {Date} createdAt - When data was created
 * @property {Date} expiresAt - When data retention expires
 * @property {Date} [archivedAt] - When data was archived (if applicable)
 * @property {string} [archivedLocation] - Where archived data is stored
 * @property {boolean} isArchived - Whether data is archived
 * @property {string} [retentionPolicyId] - Associated policy identifier
 * @property {string} [metadata] - Additional metadata for tracking
 */
export interface RetainedData {
  id: string;
  entityType: DataEntityType;
  data: unknown;
  classification: DataClassification;
  createdAt: Date;
  expiresAt: Date;
  archivedAt?: Date;
  archivedLocation?: string;
  isArchived: boolean;
  retentionPolicyId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Audit log entry for retention and archival actions
 * 
 * @interface ComplianceAuditLog
 * @property {string} id - Unique audit log identifier
 * @property {string} entityId - ID of the retained data entity
 * @property {DataEntityType} entityType - Type of entity being audited
 * @property {RetentionAction} action - Action performed
 * @property {string} actor - User or system that performed the action
 * @property {Date} timestamp - When action occurred
 * @property {Record<string, unknown>} details - Action-specific details
 * @property {string} compliance - Applicable compliance standard (e.g., GDPR, CCPA)
 * @property {string} [notes] - Additional notes for compliance review
 */
export interface ComplianceAuditLog {
  id: string;
  entityId: string;
  entityType: DataEntityType;
  action: RetentionAction;
  actor: string;
  timestamp: Date;
  details: Record<string, unknown>;
  compliance: string;
  notes?: string;
}

/**
 * Retention status and metadata
 * 
 * @interface RetentionStatus
 * @property {string} dataId - ID of the retained data
 * @property {Date} createdAt - When data was created
 * @property {Date} expiresAt - When retention expires
 * @property {number} daysUntilExpiry - Days remaining before expiration
 * @property {boolean} isArchived - Archival status
 * @property {string} [archivedLocation] - Archive location if applicable
 * @property {boolean} needsAction - Whether manual action is required
 * @property {string} [actionRequired] - Description of required action
 */
export interface RetentionStatus {
  dataId: string;
  createdAt: Date;
  expiresAt: Date;
  daysUntilExpiry: number;
  isArchived: boolean;
  archivedLocation?: string;
  needsAction: boolean;
  actionRequired?: string;
}

/**
 * Retention system configuration
 * 
 * @interface RetentionConfig
 * @property {boolean} enabled - Enable retention controls
 * @property {string} storageBasePath - Base path for storage operations
 * @property {string} archiveBasePath - Base path for archived data
 * @property {number} checksIntervalMs - Interval for running retention checks (milliseconds)
 * @property {number} batchSize - Number of records to process per batch
 * @property {boolean} automaticArchival - Automatically archive expired data
 * @property {boolean} automaticDeletion - Automatically delete archived data
 * @property {number} postArchivalRetentionDays - Days to keep data after archival before deletion
 * @property {string} complianceStandard - Primary compliance standard (e.g., GDPR)
 * @property {boolean} encryptionEnabled - Enable encryption for sensitive data
 */
export interface RetentionConfig {
  enabled: boolean;
  storageBasePath: string;
  archiveBasePath: string;
  checksIntervalMs: number;
  batchSize: number;
  automaticArchival: boolean;
  automaticDeletion: boolean;
  postArchivalRetentionDays: number;
  complianceStandard: string;
  encryptionEnabled: boolean;
}
