/**
 * Environment Configuration Module
 * 
 * Manages environment-specific configurations for deployment across
 * development, staging, and production environments.
 * 
 * @module config/environment
 */

import { validateEnv, EnvConfig } from './env.schema';

export type Environment = 'development' | 'staging' | 'production' | 'test';

export interface EnvironmentConfig extends EnvConfig {
  /** Current environment name (mapped from NODE_ENV for compatibility) */
  environment: Environment;
  /** Server port */
  port: number;
  /** Node environment */
  nodeEnv: string;
  /** API base URL */
  apiBaseUrl: string;
  /** Enable debug logging */
  debug: boolean;
  /** Database connection string (if applicable) */
  databaseUrl?: string;
  /** Stellar/Soroban network configuration */
  stellarNetwork: 'testnet' | 'mainnet';
  /** Maximum request body size */
  maxRequestSize: string;
  /** CORS allowed origins */
  corsOrigins: string[];
}

/**
 * Validates required environment variables using Zod schema.
 * This is now a wrapper around validateEnv.
 * @throws {Error} If required environment variables are missing or invalid
 */
export function validateEnvironment(): void {
  validateEnv(process.env);
}

/**
 * Gets the current environment from NODE_ENV
 * @returns {Environment} The current environment
 */
export function getCurrentEnvironment(): Environment {
  const env = process.env.NODE_ENV || 'development';
  
  if (env === 'production' || env === 'staging' || env === 'development' || env === 'test') {
    return env as Environment;
  }
  
  return 'development';
}

/**
 * Loads environment-specific configuration and validates it against the schema.
 * @returns {EnvironmentConfig} Configuration object for current environment
 */
export function loadEnvironmentConfig(): EnvironmentConfig {
  const validated = validateEnv(process.env);
  
  const environment = validated.NODE_ENV as Environment;
  const port = validated.PORT;
  
  const baseConfig: EnvironmentConfig = {
    ...validated,
    environment,
    port,
    nodeEnv: validated.NODE_ENV,
    apiBaseUrl: validated.API_BASE_URL || `http://localhost:${port}`,
    debug: validated.DEBUG ?? false,
    databaseUrl: validated.DATABASE_URL,
    stellarNetwork: environment === 'production' ? 'mainnet' : 'testnet',
    maxRequestSize: validated.MAX_REQUEST_SIZE,
    corsOrigins: validated.CORS_ORIGINS ?? ['http://localhost:3000'],
  };
  
  return baseConfig;
}

/**
 * Checks if the current environment is production
 * @returns {boolean} True if running in production
 */
export function isProduction(): boolean {
  return getCurrentEnvironment() === 'production';
}

/**
 * Checks if the current environment is staging
 * @returns {boolean} True if running in staging
 */
export function isStaging(): boolean {
  return getCurrentEnvironment() === 'staging';
}

/**
 * Checks if the current environment is development
 * @returns {boolean} True if running in development
 */
export function isDevelopment(): boolean {
  return getCurrentEnvironment() === 'development';
}

