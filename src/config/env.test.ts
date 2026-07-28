import { validateEnv } from './env.schema';

describe('Environment validation', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('should throw when COMPLIANCE_AUDIT_SECRET is missing', () => {
    delete process.env.COMPLIANCE_AUDIT_SECRET;
    expect(() => validateEnv()).toThrow(/COMPLIANCE_AUDIT_SECRET/);
  });

  it('should pass when COMPLIANCE_AUDIT_SECRET is provided', () => {
    process.env.NODE_ENV = 'test';
    process.env.COMPLIANCE_AUDIT_SECRET = 'a'.repeat(32);
    expect(() => validateEnv()).not.toThrow();
  });

  it('should default WEBHOOK_DELIVERY_TIMEOUT_MS to 10000', () => {
    process.env.NODE_ENV = 'test';
    process.env.COMPLIANCE_AUDIT_SECRET = 'a'.repeat(32);
    delete process.env.WEBHOOK_DELIVERY_TIMEOUT_MS;

    expect(validateEnv().WEBHOOK_DELIVERY_TIMEOUT_MS).toBe(10_000);
  });

  it('should parse WEBHOOK_DELIVERY_TIMEOUT_MS from env', () => {
    process.env.NODE_ENV = 'test';
    process.env.COMPLIANCE_AUDIT_SECRET = 'a'.repeat(32);
    process.env.WEBHOOK_DELIVERY_TIMEOUT_MS = '2500';

    expect(validateEnv().WEBHOOK_DELIVERY_TIMEOUT_MS).toBe(2_500);
  });

  it('should reject invalid WEBHOOK_DELIVERY_TIMEOUT_MS values', () => {
    process.env.NODE_ENV = 'test';
    process.env.COMPLIANCE_AUDIT_SECRET = 'a'.repeat(32);
    process.env.WEBHOOK_DELIVERY_TIMEOUT_MS = '0';

    expect(() => validateEnv()).toThrow(/WEBHOOK_DELIVERY_TIMEOUT_MS/);
  });

  describe('AUDIT_ENABLED feature flag', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'test';
      process.env.COMPLIANCE_AUDIT_SECRET = 'a'.repeat(32);
    });

    it('defaults to true when AUDIT_ENABLED is not set', () => {
      delete process.env.AUDIT_ENABLED;
      expect(validateEnv().AUDIT_ENABLED).toBe(true);
    });

    it('is true when AUDIT_ENABLED=true', () => {
      process.env.AUDIT_ENABLED = 'true';
      expect(validateEnv().AUDIT_ENABLED).toBe(true);
    });

    it('is false when AUDIT_ENABLED=false', () => {
      process.env.AUDIT_ENABLED = 'false';
      expect(validateEnv().AUDIT_ENABLED).toBe(false);
    });

    it('treats non-"false" strings as true', () => {
      process.env.AUDIT_ENABLED = '1';
      expect(validateEnv().AUDIT_ENABLED).toBe(true);
    });

    it('treats empty string as true (safe default)', () => {
      process.env.AUDIT_ENABLED = '';
      expect(validateEnv().AUDIT_ENABLED).toBe(true);
    });
  });
});
