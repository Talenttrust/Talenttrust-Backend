/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  transform: {
    '^.+\\.ts$': 'ts-jest',
  },
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.test.ts'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/index.ts', // entry point — not unit-testable (binds port)
  ],
  coverageThresholds: {
    global: {
      lines: 95,
      functions: 95,
      branches: 80,
      statements: 95,
    },
  },
  coverageReporters: ['text', 'lcov', 'json-summary'],
};
