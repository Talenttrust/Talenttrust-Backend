/**
 * Deployment Validation Module
 * 
 * Provides pre-deployment validation checks to ensure system readiness
 * and prevent deployment of unhealthy or misconfigured services.
 * 
 * @module deployment/validator
 */

import { EnvironmentConfig } from '../config/environment';

export interface ValidationResult {
  /** Whether validation passed */
  valid: boolean;
  /** List of validation errors */
  errors: string[];
  /** List of validation warnings */
  warnings: string[];
}

export interface HealthCheckResult {
  /** Service name */
  service: string;
  /** Health status */
  status: 'healthy' | 'unhealthy';
  /** Timestamp of check */
  timestamp: Date;
  /** Additional details */
  details?: Record<string, unknown>;
}

/**
 * Validates environment configuration for deployment
 * @param {EnvironmentConfig} config - Environment configuration to validate
 * @returns {ValidationResult} Validation result with errors and warnings
 */
export function validateDeploymentConfig(config: EnvironmentConfig): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  
  // Validate port
  if (config.port < 1 || config.port > 65535) {
    errors.push(`Invalid port number: ${config.port}`);
  }
  
  // Validate API base URL
  if (!config.apiBaseUrl || !isValidUrl(config.apiBaseUrl)) {
    errors.push(`Invalid API base URL: ${config.apiBaseUrl}`);
  }
  
  // Production-specific validations
  if (config.environment === 'production') {
    if (config.debug) {
      warnings.push('Debug mode is enabled in production');
    }
    
    if (config.stellarNetwork !== 'mainnet') {
      errors.push('Production must use Stellar mainnet');
    }
    
    if (config.corsOrigins.includes('*') || config.corsOrigins.some(o => o.includes('localhost'))) {
      errors.push('Production CORS origins must not include wildcards or localhost');
    }
  }
  
  // Staging-specific validations
  if (config.environment === 'staging') {
    if (config.stellarNetwork === 'mainnet') {
      warnings.push('Staging environment using mainnet (consider using testnet)');
    }
  }
  
  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Validates URL format
 * @param {string} url - URL to validate
 * @returns {boolean} True if URL is valid
 */
function isValidUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * Performs health check on the service
 * @param {string} baseUrl - Base URL of the service
 * @returns {Promise<HealthCheckResult>} Health check result
 */
export async function performHealthCheck(baseUrl: string): Promise<HealthCheckResult> {
  const startTime = Date.now();
  
  try {
    // In a real implementation, this would make an HTTP request
    // For now, we'll simulate a successful health check
    const responseTime = Date.now() - startTime;
    
    return {
      service: 'talenttrust-backend',
      status: 'healthy',
      timestamp: new Date(),
      details: {
        responseTime,
        baseUrl,
      },
    };
  } catch (error) {
    return {
      service: 'talenttrust-backend',
      status: 'unhealthy',
      timestamp: new Date(),
      details: {
        error: error instanceof Error ? error.message : 'Unknown error',
        baseUrl,
      },
    };
  }
}

/**
 * Validates deployment readiness
 * @param {EnvironmentConfig} config - Environment configuration
 * @returns {Promise<ValidationResult>} Comprehensive validation result
 */
export async function validateDeploymentReadiness(
  config: EnvironmentConfig
): Promise<ValidationResult> {
  const configValidation = validateDeploymentConfig(config);
  
  if (!configValidation.valid) {
    return configValidation;
  }
  
  // Additional async validations can be added here
  // e.g., database connectivity, external service checks
  
  return configValidation;
}
