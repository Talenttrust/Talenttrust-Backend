/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  setupFiles: ['<rootDir>/src/test-setup.ts'],
  testPathIgnorePatterns: [
    '/node_modules/',
    'queue-manager.test.ts',
    'queue-manager.dedupe.test.ts',
    // 'reputation-recompute-processor.test.ts', — re-enabled: real paginated query
    'retry-manager.test.ts',
    'api/jobs.test',
    // Requires real BullMQ job-failure semantics that global test-setup mocks
    // away (same rationale as queue-manager.test / retry-manager.test), and
    // mocks a non-existent module path. Kept for reference; not runnable here.
    'api/jobs.dlq.test',
    'tests/load',
    'tests/stress',
    // 'webhookDelivery.test.ts',
    'reputation-scheduler.service.test.ts',
    'occ.integration.test.ts',
    'deployment/integration.test.ts',
    'retention/integration.test.ts',
    'requestLogger.test.ts',
    // 'reputation.controller.test.ts', — re-enabled: rating range validation tests
    'src/auth/__tests__/roles.test.ts',
    'src/config/config.test.ts',
    'src/httpClient.test.ts',
    'src/index.test.ts',
    'src/logger.test.ts',
    'src/middleware/__tests__/authorization.test.ts',
    'src/middleware/__tests__/rateLimiter.test.ts',
    'src/middleware/auth.test.ts',
    'src/rateLimit.integration.test.ts',
    // 'src/routes/reputation.api.test.ts', — re-enabled: schema validation tests
    // 'src/services/reputation.service.test.ts', — re-enabled: anti-abuse guard tests
    // 'src/shutdown.test.ts', — re-enabled: drain phase tests are now stable
  ],
  transform: {
    '^.+\\.[jt]s$': ['ts-jest', {
      diagnostics: false,
    }],
  },
  moduleNameMapper: {
    '^uuid$': require.resolve('uuid'),
  },
  transformIgnorePatterns: [
    'node_modules/(?!(uuid)/)',
  ],
  testEnvironment: 'node',
  testTimeout: 15000,
  roots: ['<rootDir>/src', '<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/**/*.test.ts',
    '!src/**/__tests__/**',
    '!src/index.ts',
    '!src/tests/load/**',
    '!src/tests/stress/**',
    '!src/server.ts',
    '!src/queue/index.ts',
    '!src/services/soroban/index.ts',
    '!src/observability/index.ts',
  ],
  coverageThreshold: {
    global: {
      lines: 0,
      statements: 0,
      functions: 0,
      branches: 0,
    },
    './src/observability/metrics-service.ts': {
      lines: 95,
      branches: 95,
      functions: 95,
      statements: 95,
    },
    './src/observability/reputation-observability.ts': {
      lines: 95,
      branches: 95,
      functions: 95,
      statements: 95,
    },
    './src/observability/health-service.ts': {
      lines: 95,
      branches: 94,
      functions: 95,
      statements: 95,
    },
    './src/middleware/metricsAuth.ts': {
      lines: 95,
      branches: 95,
      functions: 95,
      statements: 95,
    },
    './src/utils/webhookMetrics.ts': {
      lines: 95,
      branches: 95,
      functions: 95,
      statements: 95,
    },
    './src/utils/softDelete.ts': {
      lines: 95,
      branches: 95,
      functions: 95,
      statements: 95,
    },
    './src/services/disputes.service.ts': {
      lines: 90,
      branches: 80,
      functions: 90,
      statements: 90,
    },
  },
  coverageReporters: ['text', 'lcov', 'json-summary'],
};
