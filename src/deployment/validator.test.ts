/**
 * Deployment Validator Tests
 *
 * Comprehensive test suite for deployment validation module covering:
 * - Configuration validation (all environments, edge cases)
 * - Real HTTP probe: healthy 200, 503 unhealthy, connection refused,
 *   timeout, SSRF rejection, HttpResponseError path, invalid URL
 * - Deployment readiness orchestration
 */

import {
  validateDeploymentConfig,
  performHealthCheck,
  validateDeploymentReadiness,
} from './validator';
import { EnvironmentConfig } from '../config/environment';
import { AxiosInstance } from 'axios';
import { HttpResponseError } from '../httpClient';

describe('Deployment Validator', () => {
  const createMockConfig = (overrides?: Partial<EnvironmentConfig>): EnvironmentConfig => ({
    environment: 'development',
    port: 3001,
    nodeEnv: 'development',
    apiBaseUrl: 'http://localhost:3001',
    debug: false,
    stellarNetwork: 'testnet',
    maxRequestSize: '10mb',
    corsOrigins: ['http://localhost:3000'],
    NODE_ENV: 'development',
    PORT: 3001,
    STELLAR_HORIZON_URL: 'https://horizon-testnet.stellar.org',
    STELLAR_NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
    SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
    ...overrides,
  } as EnvironmentConfig);

  describe('validateDeploymentConfig', () => {
    it('should validate a correct development configuration', () => {
      const config = createMockConfig();
      const result = validateDeploymentConfig(config);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should validate a correct staging configuration', () => {
      const config = createMockConfig({
        environment: 'staging',
        nodeEnv: 'staging',
        apiBaseUrl: 'https://staging-api.example.com',
        corsOrigins: ['https://staging.example.com'],
      });
      const result = validateDeploymentConfig(config);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should validate a correct production configuration', () => {
      const config = createMockConfig({
        environment: 'production',
        nodeEnv: 'production',
        apiBaseUrl: 'https://api.example.com',
        stellarNetwork: 'mainnet',
        debug: false,
        corsOrigins: ['https://app.example.com'],
      });
      const result = validateDeploymentConfig(config);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject invalid port numbers', () => {
      const config = createMockConfig({ port: 0 });
      const result = validateDeploymentConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Invalid port number: 0');
    });

    it('should reject port numbers above 65535', () => {
      const config = createMockConfig({ port: 70000 });
      const result = validateDeploymentConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Invalid port number: 70000');
    });

    it('should reject invalid API base URL', () => {
      const config = createMockConfig({ apiBaseUrl: 'not-a-url' });
      const result = validateDeploymentConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Invalid API base URL: not-a-url');
    });

    it('should reject empty API base URL', () => {
      const config = createMockConfig({ apiBaseUrl: '' });
      const result = validateDeploymentConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Invalid API base URL: ');
    });

    it('should warn when debug is enabled in production', () => {
      const config = createMockConfig({
        environment: 'production',
        stellarNetwork: 'mainnet',
        debug: true,
        corsOrigins: ['https://app.example.com'],
      });
      const result = validateDeploymentConfig(config);

      expect(result.valid).toBe(true);
      expect(result.warnings).toContain('Debug mode is enabled in production');
    });

    it('should reject production with testnet', () => {
      const config = createMockConfig({
        environment: 'production',
        stellarNetwork: 'testnet',
        corsOrigins: ['https://app.example.com'],
      });
      const result = validateDeploymentConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Production must use Stellar mainnet');
    });

    it('should reject production with wildcard CORS', () => {
      const config = createMockConfig({
        environment: 'production',
        stellarNetwork: 'mainnet',
        corsOrigins: ['*'],
      });
      const result = validateDeploymentConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Production CORS origins must not include wildcards or localhost');
    });

    it('should reject production with localhost CORS', () => {
      const config = createMockConfig({
        environment: 'production',
        stellarNetwork: 'mainnet',
        corsOrigins: ['http://localhost:3000', 'https://app.example.com'],
      });
      const result = validateDeploymentConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Production CORS origins must not include wildcards or localhost');
    });

    it('should warn when staging uses mainnet', () => {
      const config = createMockConfig({
        environment: 'staging',
        stellarNetwork: 'mainnet',
      });
      const result = validateDeploymentConfig(config);

      expect(result.valid).toBe(true);
      expect(result.warnings).toContain('Staging environment using mainnet (consider using testnet)');
    });

    it('should handle multiple validation errors', () => {
      const config = createMockConfig({
        environment: 'production',
        port: -1,
        apiBaseUrl: 'invalid',
        stellarNetwork: 'testnet',
        corsOrigins: ['*'],
      });
      const result = validateDeploymentConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(1);
    });
  });

  // ---------------------------------------------------------------------------
  // performHealthCheck
  // ---------------------------------------------------------------------------
  describe('performHealthCheck', () => {
    let mockHttpClient: jest.Mocked<Pick<AxiosInstance, 'get'>>;

    beforeEach(() => {
      mockHttpClient = {
        get: jest.fn(),
      };
    });

    afterEach(() => {
      jest.clearAllMocks();
    });

    // ── Happy path ─────────────────────────────────────────────────────────
    it('returns healthy status for a 200 OK response', async () => {
      mockHttpClient.get.mockResolvedValue({ status: 200 });

      const result = await performHealthCheck(
        'https://api.example.com',
        mockHttpClient as unknown as AxiosInstance
      );

      expect(result.service).toBe('talenttrust-backend');
      expect(result.status).toBe('healthy');
      expect(result.timestamp).toBeInstanceOf(Date);
      expect(result.details).toBeDefined();
      expect(result.details?.baseUrl).toBe('https://api.example.com');
      expect(result.details?.statusCode).toBe(200);
      expect(typeof result.details?.responseTime).toBe('number');
    });

    it('probes the /health/ready path specifically', async () => {
      mockHttpClient.get.mockResolvedValue({ status: 200 });

      await performHealthCheck(
        'https://api.example.com',
        mockHttpClient as unknown as AxiosInstance
      );

      expect(mockHttpClient.get).toHaveBeenCalledWith(
        'https://api.example.com/health/ready'
      );
    });

    it('correctly constructs /health/ready even when baseUrl has a trailing slash', async () => {
      mockHttpClient.get.mockResolvedValue({ status: 200 });

      await performHealthCheck(
        'https://api.example.com/',
        mockHttpClient as unknown as AxiosInstance
      );

      // new URL('/health/ready', 'https://api.example.com/') → correct path
      expect(mockHttpClient.get).toHaveBeenCalledWith(
        'https://api.example.com/health/ready'
      );
    });

    it('includes an accurate responseTime in details', async () => {
      mockHttpClient.get.mockResolvedValue({ status: 200 });

      const before = Date.now();
      const result = await performHealthCheck(
        'https://api.example.com',
        mockHttpClient as unknown as AxiosInstance
      );
      const after = Date.now();

      const rt = result.details?.responseTime as number;
      expect(rt).toBeGreaterThanOrEqual(0);
      expect(rt).toBeLessThanOrEqual(after - before + 5); // allow tiny skew
    });

    // ── Unhealthy paths ────────────────────────────────────────────────────
    it('returns unhealthy status for a 503 response (raw Axios error shape)', async () => {
      mockHttpClient.get.mockRejectedValue({
        response: { status: 503 },
        code: undefined,
      });

      const result = await performHealthCheck(
        'https://api.example.com',
        mockHttpClient as unknown as AxiosInstance
      );

      expect(result.status).toBe('unhealthy');
      expect(result.details?.error).toBe('HTTP 503');
      expect(result.details?.statusCode).toBe(503);
    });

    it('returns unhealthy for a 503 response via HttpResponseError (real client path)', async () => {
      mockHttpClient.get.mockRejectedValue(
        new HttpResponseError(503, 'Service Unavailable', null, 'HTTP 503 Service Unavailable')
      );

      const result = await performHealthCheck(
        'https://api.example.com',
        mockHttpClient as unknown as AxiosInstance
      );

      expect(result.status).toBe('unhealthy');
      expect(result.details?.error).toBe('HTTP 503');
      expect(result.details?.statusCode).toBe(503);
    });

    it('returns unhealthy for a 404 via HttpResponseError', async () => {
      mockHttpClient.get.mockRejectedValue(
        new HttpResponseError(404, 'Not Found', null, 'HTTP 404 Not Found')
      );

      const result = await performHealthCheck(
        'https://api.example.com',
        mockHttpClient as unknown as AxiosInstance
      );

      expect(result.status).toBe('unhealthy');
      expect(result.details?.error).toBe('HTTP 404');
      expect(result.details?.statusCode).toBe(404);
    });

    it('returns unhealthy for connection refused (ECONNREFUSED)', async () => {
      mockHttpClient.get.mockRejectedValue({
        code: 'ECONNREFUSED',
      });

      const result = await performHealthCheck(
        'https://api.example.com',
        mockHttpClient as unknown as AxiosInstance
      );

      expect(result.status).toBe('unhealthy');
      expect(result.details?.error).toBe('Connection refused');
    });

    it('returns unhealthy for request timeout (ECONNABORTED)', async () => {
      mockHttpClient.get.mockRejectedValue({
        code: 'ECONNABORTED',
      });

      const result = await performHealthCheck(
        'https://api.example.com',
        mockHttpClient as unknown as AxiosInstance
      );

      expect(result.status).toBe('unhealthy');
      expect(result.details?.error).toBe('Request timeout');
    });

    it('returns unhealthy for a generic Error (unknown network failure)', async () => {
      mockHttpClient.get.mockRejectedValue(new Error('Network socket destroyed'));

      const result = await performHealthCheck(
        'https://api.example.com',
        mockHttpClient as unknown as AxiosInstance
      );

      expect(result.status).toBe('unhealthy');
      expect(result.details?.error).toBe('Network socket destroyed');
    });

    it('includes responseTime in the details even when the request fails', async () => {
      mockHttpClient.get.mockRejectedValue({ code: 'ECONNREFUSED' });

      const result = await performHealthCheck(
        'https://api.example.com',
        mockHttpClient as unknown as AxiosInstance
      );

      expect(typeof result.details?.responseTime).toBe('number');
      expect((result.details?.responseTime as number)).toBeGreaterThanOrEqual(0);
    });

    it('preserves baseUrl in details for all error cases', async () => {
      mockHttpClient.get.mockRejectedValue({ code: 'ECONNREFUSED' });

      const result = await performHealthCheck(
        'https://api.example.com',
        mockHttpClient as unknown as AxiosInstance
      );

      expect(result.details?.baseUrl).toBe('https://api.example.com');
    });

    // ── SSRF rejection ─────────────────────────────────────────────────────
    it('rejects private loopback address (127.0.0.1) in production', async () => {
      const saved = process.env['NODE_ENV'];
      process.env['NODE_ENV'] = 'production';
      try {
        const result = await performHealthCheck(
          'http://127.0.0.1:3001',
          mockHttpClient as unknown as AxiosInstance
        );

        expect(result.status).toBe('unhealthy');
        expect(result.details?.error).toBe('URL not safe for SSRF');
        // The HTTP client must NOT have been called
        expect(mockHttpClient.get).not.toHaveBeenCalled();
      } finally {
        process.env['NODE_ENV'] = saved;
      }
    });

    it('rejects RFC-1918 address (10.0.0.1) in production', async () => {
      const saved = process.env['NODE_ENV'];
      process.env['NODE_ENV'] = 'production';
      try {
        const result = await performHealthCheck(
          'http://10.0.0.1:3001',
          mockHttpClient as unknown as AxiosInstance
        );

        expect(result.status).toBe('unhealthy');
        expect(result.details?.error).toBe('URL not safe for SSRF');
        expect(mockHttpClient.get).not.toHaveBeenCalled();
      } finally {
        process.env['NODE_ENV'] = saved;
      }
    });

    it('rejects cloud metadata address (169.254.169.254) in production', async () => {
      const saved = process.env['NODE_ENV'];
      process.env['NODE_ENV'] = 'production';
      try {
        const result = await performHealthCheck(
          'http://169.254.169.254/latest/meta-data',
          mockHttpClient as unknown as AxiosInstance
        );

        expect(result.status).toBe('unhealthy');
        expect(result.details?.error).toBe('URL not safe for SSRF');
        expect(mockHttpClient.get).not.toHaveBeenCalled();
      } finally {
        process.env['NODE_ENV'] = saved;
      }
    });

    it('rejects private hostname in production even when SSRF_ALLOW_PRIVATE_HOSTS is set', async () => {
      const savedEnv = process.env['NODE_ENV'];
      const savedAllow = process.env['SSRF_ALLOW_PRIVATE_HOSTS'];
      process.env['NODE_ENV'] = 'production';
      process.env['SSRF_ALLOW_PRIVATE_HOSTS'] = 'true';
      try {
        const result = await performHealthCheck(
          'http://192.168.1.100:3001',
          mockHttpClient as unknown as AxiosInstance
        );

        expect(result.status).toBe('unhealthy');
        expect(result.details?.error).toBe('URL not safe for SSRF');
        expect(mockHttpClient.get).not.toHaveBeenCalled();
      } finally {
        process.env['NODE_ENV'] = savedEnv;
        if (savedAllow === undefined) {
          delete process.env['SSRF_ALLOW_PRIVATE_HOSTS'];
        } else {
          process.env['SSRF_ALLOW_PRIVATE_HOSTS'] = savedAllow;
        }
      }
    });

    it('allows a public URL in test environment', async () => {
      mockHttpClient.get.mockResolvedValue({ status: 200 });

      // NODE_ENV=test + SSRF_ALLOW_PRIVATE_HOSTS not set → blocks private,
      // but a real public host must pass through.
      const result = await performHealthCheck(
        'https://api.example.com',
        mockHttpClient as unknown as AxiosInstance
      );

      expect(result.status).toBe('healthy');
      expect(mockHttpClient.get).toHaveBeenCalled();
    });

    it('handles different public base URLs correctly', async () => {
      mockHttpClient.get.mockResolvedValue({ status: 200 });

      const result = await performHealthCheck(
        'https://staging-api.example.com',
        mockHttpClient as unknown as AxiosInstance
      );

      expect(result.details?.baseUrl).toBe('https://staging-api.example.com');
      expect(mockHttpClient.get).toHaveBeenCalledWith(
        'https://staging-api.example.com/health/ready'
      );
    });
  });

  // ---------------------------------------------------------------------------
  // validateDeploymentReadiness
  // ---------------------------------------------------------------------------
  describe('validateDeploymentReadiness', () => {
    it('should validate deployment readiness for valid config', async () => {
      const config = createMockConfig();
      const result = await validateDeploymentReadiness(config);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should fail readiness check for invalid config', async () => {
      const config = createMockConfig({
        port: -1,
        apiBaseUrl: 'invalid',
      });
      const result = await validateDeploymentReadiness(config);

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should return early if config validation fails', async () => {
      const config = createMockConfig({
        environment: 'production',
        stellarNetwork: 'testnet',
        corsOrigins: ['https://app.example.com'],
      });
      const result = await validateDeploymentReadiness(config);

      expect(result.valid).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Edge Cases
  // ---------------------------------------------------------------------------
  describe('Edge Cases', () => {
    it('should handle config with all optional fields undefined', () => {
      const config = createMockConfig({
        databaseUrl: undefined,
      });
      const result = validateDeploymentConfig(config);

      expect(result.valid).toBe(true);
    });

    it('should validate port at boundary values', () => {
      const config1 = createMockConfig({ port: 1 });
      const result1 = validateDeploymentConfig(config1);
      expect(result1.valid).toBe(true);

      const config2 = createMockConfig({ port: 65535 });
      const result2 = validateDeploymentConfig(config2);
      expect(result2.valid).toBe(true);
    });

    it('should handle empty CORS origins array', () => {
      const config = createMockConfig({
        environment: 'development',
        corsOrigins: [],
      });
      const result = validateDeploymentConfig(config);

      expect(result.valid).toBe(true);
    });
  });
});
