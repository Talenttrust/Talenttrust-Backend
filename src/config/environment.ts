/**
 * Environment configuration module
 * Centralizes environment variables and application settings
 */

export interface EnvironmentConfig {
  port: number;
  nodeEnv: string;
  apiVersion: string;
  deprecationWarningDays: number;
}

/**
 * Load and validate environment configuration
 * @returns {EnvironmentConfig} Validated configuration object
 */
export function loadEnvironmentConfig(): EnvironmentConfig {
  return {
    port: parseInt(process.env.PORT || '3001', 10),
    nodeEnv: process.env.NODE_ENV || 'development',
    apiVersion: process.env.API_VERSION || 'v1',
    deprecationWarningDays: parseInt(process.env.DEPRECATION_WARNING_DAYS || '90', 10),
  };
}

export const config = loadEnvironmentConfig();
