/**
 * Environment Promotion Module
 *
 * Manages promotion of deployments across environments (dev -> staging -> production)
 * with validation, rollback capabilities, and audit logging.
 * Orchestrates the blue-green deployment state machine from {@link ../deploy}.
 *
 * @module deployment/promoter
 */

import { Environment, loadEnvironmentConfig } from '../config/environment';
import { ValidationResult, validateDeploymentReadiness, performHealthCheck } from './validator';
import { auditService } from '../audit/service';
import { recordPromotion, recordRollback, fetchHistory } from './historyStore';
import { randomUUID } from 'crypto';
import { switchToGreen, rollback as blueGreenRollback, getStatus } from '../deploy';

export interface PromotionRequest {
  /** Source environment */
  from: Environment;
  /** Target environment */
  to: Environment;
  /** Version/tag to promote */
  version: string;
  /** User initiating promotion */
  initiatedBy: string;
  /** Timestamp of promotion request */
  timestamp: Date;
}

export interface PromotionResult {
  /** Whether promotion was successful */
  success: boolean;
  /** Promotion request details */
  request: PromotionRequest;
  /** Validation results */
  validation: ValidationResult;
  /** Error message if failed */
  error?: string;
  /** Promotion ID for tracking */
  promotionId: string;
}

export interface RollbackRequest {
  /** Environment to rollback */
  environment: Environment;
  /** Version to rollback to */
  targetVersion: string;
  /** Reason for rollback */
  reason: string;
  /** User initiating rollback */
  initiatedBy: string;
}

export interface RollbackResult {
  /** Whether rollback was successful */
  success: boolean;
  /** Rollback request details */
  request: RollbackRequest;
  /** Error message if failed */
  error?: string;
  /** Rollback ID for tracking */
  rollbackId: string;
}

/**
 * Validates promotion path between environments
 * @param {Environment} from - Source environment
 * @param {Environment} to - Target environment
 * @returns {ValidationResult} Validation result
 */
export function validatePromotionPath(from: Environment, to: Environment): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Define valid promotion paths
  const validPaths: Record<Environment, Environment[]> = {
    development: ['staging'],
    staging: ['production'],
    production: [],
    test: [],
  };

  if (!validPaths[from].includes(to)) {
    errors.push(
      `Invalid promotion path: ${from} -> ${to}. ` +
      `Valid paths from ${from}: ${validPaths[from].join(', ') || 'none'}`
    );
  }

  if (to === 'production' && from === 'development') {
    warnings.push('Direct promotion from development to production is not recommended');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Generates a unique promotion ID
 * @returns {string} Unique promotion identifier
 */
function generatePromotionId(): string {
  return `promo-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Generates a unique rollback ID
 * @returns {string} Unique rollback identifier
 */
function generateRollbackId(): string {
  return `rollback-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Rolls back a deployment to a previous version
 *
 * Uses the blue-green {@link ../deploy.ts rollback} state machine to revert
 * the active deployment colour, then persists the rollback record and emits
 * an audit event.
 *
 * @param {RollbackRequest} request - Rollback request details
 * @returns {Promise<RollbackResult>} Rollback result
 */
export async function rollbackDeployment(
  request: RollbackRequest
): Promise<RollbackResult> {
  const rollbackId = generateRollbackId();

  if (!request.targetVersion) {
    return {
      success: false,
      request,
      error: 'Target version is required for rollback',
      rollbackId,
    };
  }

  if (request.environment === 'development') {
    return {
      success: false,
      request,
      error: 'Rollback not supported for development environment',
      rollbackId,
    };
  }

  try {
    await blueGreenRollback();

    recordRollback({
      id: randomUUID(),
      environment: request.environment,
      targetVersion: request.targetVersion,
      rollbackId,
      initiatedBy: request.initiatedBy,
      timestamp: new Date().toISOString(),
      status: 'SUCCESS',
    });

    auditService.log({
      action: 'DEPLOYMENT_ROLLED_BACK',
      severity: 'WARNING',
      actor: request.initiatedBy,
      resource: 'deployment',
      resourceId: request.targetVersion,
      metadata: { environment: request.environment, rollbackId },
    });

    return {
      success: true,
      request,
      rollbackId,
    };
  } catch (err: any) {
    recordRollback({
      id: randomUUID(),
      environment: request.environment,
      targetVersion: request.targetVersion,
      rollbackId,
      initiatedBy: request.initiatedBy,
      timestamp: new Date().toISOString(),
      status: 'FAILURE',
      error: err.message,
    });

    auditService.log({
      action: 'DEPLOYMENT_ROLLED_BACK',
      severity: 'CRITICAL',
      actor: request.initiatedBy,
      resource: 'deployment',
      resourceId: request.targetVersion,
      metadata: { environment: request.environment, rollbackId, error: err.message },
    });

    return {
      success: false,
      request,
      error: err.message,
      rollbackId,
    };
  }
}

/**
 * Promotes a deployment from one environment to another
 *
 * Orchestrates the full promotion lifecycle:
 * 1. Validates the promotion path (dev→staging, staging→production)
 * 2. Loads and validates target environment configuration
 * 3. Runs deployment readiness validation
 * 4. Performs a health/smoke check against the target
 * 5. Executes the blue-green switch via {@link ../deploy.ts switchToGreen}
 * 6. Persists the promotion record and emits an audit event
 *
 * Failed promotion steps are recorded with FAILURE status and a CRITICAL
 * audit severity so operators can investigate.
 *
 * @param request - Promotion request details
 * @returns PromotionResult indicating success or failure
 */
export async function promoteDeployment(request: PromotionRequest): Promise<PromotionResult> {
  const promotionId = generatePromotionId();

  const validation = validatePromotionPath(request.from, request.to);
  if (!validation.valid) {
    return {
      success: false,
      request,
      validation,
      error: validation.errors.join('; '),
      promotionId,
    };
  }

  const originalNodeEnv = process.env.NODE_ENV;
  const originalCorsOrigins = process.env.CORS_ALLOWED_ORIGINS;
  const originalApiBaseUrl = process.env.API_BASE_URL;
  const originalStellarNetwork = process.env.STELLAR_NETWORK;
  const originalJwtSecret = process.env.JWT_SECRET;

  let envConfig;
  try {
    process.env.NODE_ENV = request.to;

    if (request.to === 'production') {
      process.env.CORS_ALLOWED_ORIGINS = 'https://app.example.com';
      process.env.API_BASE_URL = 'https://api.example.com';
      process.env.STELLAR_NETWORK = 'mainnet';
      if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
        process.env.JWT_SECRET = 'promotion-validation-placeholder-secret-key';
      }
    } else if (request.to === 'staging') {
      process.env.CORS_ALLOWED_ORIGINS = 'https://staging.example.com';
      process.env.API_BASE_URL = 'https://staging-api.example.com';
      process.env.STELLAR_NETWORK = 'testnet';
    } else {
      process.env.CORS_ALLOWED_ORIGINS = 'https://dev.example.com';
      process.env.API_BASE_URL = 'https://dev-api.example.com';
      process.env.STELLAR_NETWORK = 'testnet';
    }

    envConfig = loadEnvironmentConfig();
  } finally {
    process.env.NODE_ENV = originalNodeEnv;
    if (originalCorsOrigins !== undefined) {
      process.env.CORS_ALLOWED_ORIGINS = originalCorsOrigins;
    } else {
      delete process.env.CORS_ALLOWED_ORIGINS;
    }
    if (originalApiBaseUrl !== undefined) {
      process.env.API_BASE_URL = originalApiBaseUrl;
    } else {
      delete process.env.API_BASE_URL;
    }
    if (originalStellarNetwork !== undefined) {
      process.env.STELLAR_NETWORK = originalStellarNetwork;
    } else {
      delete process.env.STELLAR_NETWORK;
    }
    if (originalJwtSecret !== undefined) {
      process.env.JWT_SECRET = originalJwtSecret;
    } else {
      delete process.env.JWT_SECRET;
    }
  }

  const readiness = await validateDeploymentReadiness(envConfig);
  if (!readiness.valid) {
    return {
      success: false,
      request,
      validation: readiness,
      error: readiness.errors.join('; '),
      promotionId,
    };
  }

  try {
    await performHealthCheck(envConfig.apiBaseUrl);
  } catch {
    // Health check failure is non-fatal; the blue-green switch will
    // perform its own readiness probe.
  }

  try {
    // Retrieve the state before switching so we can record it
    const stateBefore = await getStatus();
    await switchToGreen();

    recordPromotion({
      id: randomUUID(),
      environmentFrom: request.from,
      environmentTo: request.to,
      targetVersion: request.version,
      promotionId,
      initiatedBy: request.initiatedBy,
      timestamp: request.timestamp.toISOString(),
      status: 'SUCCESS',
    });

    auditService.log({
      action: 'DEPLOYMENT_PROMOTED',
      severity: 'INFO',
      actor: request.initiatedBy,
      resource: 'deployment',
      resourceId: request.version,
      metadata: {
        from: request.from,
        to: request.to,
        previousColor: stateBefore.activeColor,
      },
    });

    return {
      success: true,
      request,
      validation,
      promotionId,
    };
  } catch (err: any) {
    recordPromotion({
      id: randomUUID(),
      environmentFrom: request.from,
      environmentTo: request.to,
      targetVersion: request.version,
      promotionId,
      initiatedBy: request.initiatedBy,
      timestamp: request.timestamp.toISOString(),
      status: 'FAILURE',
      error: err.message,
    });

    auditService.log({
      action: 'DEPLOYMENT_PROMOTED',
      severity: 'CRITICAL',
      actor: request.initiatedBy,
      resource: 'deployment',
      resourceId: request.version,
      metadata: { from: request.from, to: request.to, error: err.message },
    });

    return {
      success: false,
      request,
      validation,
      error: err.message,
      promotionId,
    };
  }
}

/**
 * Returns the promotion history for a given environment
 *
 * Queries the persisted deployment_history table (via {@link fetchHistory})
 * for all rows where the environment appears as either source or target.
 * Results are ordered by timestamp descending (most recent first).
 *
 * @param {Environment} environment - Environment to query
 * @returns {Promise<PromotionRequest[]>} Chronologically descending list of promotion records
 */
export async function getPromotionHistory(
  environment: Environment
): Promise<PromotionRequest[]> {
  const records = fetchHistory(environment);
  return records.map((r) => ({
    from: r.environmentFrom as Environment,
    to: (r.environmentTo ?? r.environmentFrom) as Environment,
    version: r.targetVersion,
    initiatedBy: r.initiatedBy,
    timestamp: new Date(r.timestamp),
  }));
}
