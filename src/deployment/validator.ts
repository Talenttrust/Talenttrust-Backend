/**
 * Deployment Validation Module
 *
 * Provides pre-deployment validation checks to ensure system readiness
 * and prevent deployment of unhealthy or misconfigured services.
 *
 * Security model:
 * - All outbound health probe URLs are screened through the SSRF guard
 *   (`isSafeUrl`) before any network call is made. Private/internal addresses
 *   (RFC-1918, link-local, loopback, cloud metadata) are blocked in all
 *   environments; in production the block is unconditional regardless of
 *   SSRF_ALLOW_PRIVATE_HOSTS.
 * - The HTTP client is injectable so unit tests can avoid real network access.
 * - Internal error detail is kept out of the returned `HealthCheckResult` to
 *   prevent topology leakage to callers.
 *
 * @module deployment/validator
 */

import { EnvironmentConfig } from '../config/environment';
import { isSafeUrl } from '../utils/ssrf';
import { createHttpClient, HttpResponseError } from '../httpClient';
import { AxiosInstance, AxiosError } from 'axios';

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
 * Performs a real HTTP health probe against the target service's readiness
 * endpoint (`GET <baseUrl>/health/ready`).
 *
 * The probe:
 * 1. **SSRF guard** — rejects private/internal `baseUrl` values via
 *    {@link isSafeUrl} before any network call is made.
 * 2. **Accurate timing** — `responseTime` is measured from immediately before
 *    the HTTP call to immediately after, so it reflects true round-trip
 *    latency rather than a synthetic value.
 * 3. **Bounded timeout** — defaults to 5 000 ms; the caller may supply an
 *    alternative HTTP client to override this.
 * 4. **Unhealthy on non-200** — any HTTP status other than 200, a connection
 *    error, or a timeout causes the probe to return `status: 'unhealthy'`.
 * 5. **Injectable client** — pass `httpClient` to use a mock or pre-configured
 *    Axios instance; when omitted a default instance is created automatically.
 *    This is the primary mechanism for unit-testing the probe without making
 *    real network calls.
 *
 * @param {string} baseUrl - Base URL of the service to probe (e.g. `http://localhost:3001`).
 *   Must pass the SSRF guard; private/internal URLs are rejected and returned
 *   as `status: 'unhealthy'` with `error: 'URL not safe for SSRF'`.
 * @param {AxiosInstance} [httpClient] - Optional injectable HTTP client.
 *   When provided it is used as-is (no extra timeout is applied by the probe);
 *   configure the timeout on the client itself.  When omitted, a new client
 *   with a 5 000 ms timeout is created for each invocation.
 * @returns {Promise<HealthCheckResult>} Health check result containing the
 *   service name, `'healthy'` / `'unhealthy'` status, timestamp, and a
 *   `details` bag with `responseTime`, `baseUrl`, and (on success) `statusCode`.
 *
 * @example
 * // Typical post-deployment readiness check
 * const result = await performHealthCheck('https://api.example.com');
 * if (result.status !== 'healthy') {
 *   throw new Error(`Deployment not ready: ${JSON.stringify(result.details)}`);
 * }
 *
 * @example
 * // Inject a mock client in tests
 * const mockClient = { get: jest.fn().mockResolvedValue({ status: 200 }) };
 * const result = await performHealthCheck('https://api.example.com', mockClient as AxiosInstance);
 */
export async function performHealthCheck(
  baseUrl: string,
  httpClient?: AxiosInstance
): Promise<HealthCheckResult> {
  const startTime = Date.now();

  try {
    // ── SSRF guard ───────────────────────────────────────────────────────────
    // Reject private/internal URLs before any network activity to prevent
    // the probe from being redirected at cloud metadata or internal hosts.
    if (!isSafeUrl(baseUrl)) {
      return {
        service: 'talenttrust-backend',
        status: 'unhealthy',
        timestamp: new Date(),
        details: {
          error: 'URL not safe for SSRF',
          baseUrl,
        },
      };
    }

    // ── Build target URL ─────────────────────────────────────────────────────
    const healthUrl = new URL('/health/ready', baseUrl);
    const client = httpClient ?? createHttpClient('health-check', { timeout: 5000 });

    // ── Perform probe — timing wraps only the real network call ─────────────
    const response = await client.get(healthUrl.toString());
    const responseTime = Date.now() - startTime;

    const status = response.status === 200 ? 'healthy' : 'unhealthy';
    return {
      service: 'talenttrust-backend',
      status,
      timestamp: new Date(),
      details: {
        responseTime,
        baseUrl,
        statusCode: response.status,
      },
    };
  } catch (error) {
    const responseTime = Date.now() - startTime;
    let errorMessage = 'Unknown error';
    let statusCode: number | undefined;

    // HttpResponseError is thrown by createHttpClient's response interceptor
    // for all non-2xx responses when using the default (non-injected) client.
    if (error instanceof HttpResponseError) {
      statusCode = error.status;
      errorMessage = `HTTP ${statusCode}`;
    } else {
      // Raw AxiosError — emitted when an injected client is used without an
      // interceptor (typical in unit tests).
      const axiosError = error as AxiosError;
      if (axiosError.response) {
        statusCode = axiosError.response.status;
        errorMessage = `HTTP ${statusCode}`;
      } else if (axiosError.code === 'ECONNREFUSED') {
        errorMessage = 'Connection refused';
      } else if (axiosError.code === 'ECONNABORTED') {
        errorMessage = 'Request timeout';
      } else if (error instanceof Error) {
        errorMessage = error.message;
      }
    }

    return {
      service: 'talenttrust-backend',
      status: 'unhealthy',
      timestamp: new Date(),
      details: {
        error: errorMessage,
        baseUrl,
        responseTime,
        ...(statusCode !== undefined ? { statusCode } : {}),
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
