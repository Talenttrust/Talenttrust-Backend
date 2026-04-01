/**
 * Environment Configuration Module
 * 
 * Manages environment-specific configurations for deployment across
 * development, staging, and production environments.
 * 
 * @module config/environment
 */

export type Environment = 'development' | 'staging' | 'production';

export interface EnvironmentConfig {
  /** Current environment name */
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
 * Validates required environment variables
 * @throws {Error} If required environment variables are missing
 */
function validateEnvironment(): void {
  const required = ['NODE_ENV'];
  const missing = required.filter(key => !process.env[key]);
  
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

/**
 * Gets the current environment from NODE_ENV
 * @returns {Environment} The current environment
 */
export function getCurrentEnvironment(): Environment {
  const env = process.env.NODE_ENV || 'development';
  
  if (env === 'production' || env === 'staging' || env === 'development') {
    return env as Environment;
  }
  
  return 'development';
}

/**
 * Loads environment-specific configuration
 * @returns {EnvironmentConfig} Configuration object for current environment
 */
export function loadEnvironmentConfig(): EnvironmentConfig {
  validateEnvironment();
  
  const environment = getCurrentEnvironment();
  const port = parseInt(process.env.PORT || '3001', 10);
  
  const baseConfig: EnvironmentConfig = {
    environment,
    port,
    nodeEnv: process.env.NODE_ENV || 'development',
    apiBaseUrl: process.env.API_BASE_URL || `http://localhost:${port}`,
    debug: process.env.DEBUG === 'true',
    databaseUrl: process.env.DATABASE_URL,
    stellarNetwork: environment === 'production' ? 'mainnet' : 'testnet',
    maxRequestSize: process.env.MAX_REQUEST_SIZE || '10mb',
    corsOrigins: process.env.CORS_ORIGINS?.split(',') || ['http://localhost:3000'],
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
