/**
 * Server Startup Tests
 * Tests for server initialization logic
 */

import { startServer } from './index';

describe('Server Startup', () => {
  const originalEnv = process.env.NODE_ENV;
  let consoleLogSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    process.env.NODE_ENV = originalEnv;
  });

  it('should export startServer function', () => {
    expect(startServer).toBeDefined();
    expect(typeof startServer).toBe('function');
  });

  it('should not start server in test environment', () => {
    process.env.NODE_ENV = 'test';
    
    // Re-import to trigger the conditional
    jest.isolateModules(() => {
      require('./index');
    });

    // Server should not log startup messages in test mode
    expect(consoleLogSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('TalentTrust API listening')
    );
  });

  it('should export app for testing', () => {
    const app = require('./index').default;
    expect(app).toBeDefined();
    expect(typeof app).toBe('function');
  });
});

