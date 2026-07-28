import { envSchema } from './env.schema';

describe('envSchema SSRF Protection', () => {
  const dummySecret = 'a'.repeat(32);
  const productionSecret = 'a'.repeat(32);
  const originalAllowFlag = process.env.SSRF_ALLOW_PRIVATE_HOSTS;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    // The global test setup enables SSRF_ALLOW_PRIVATE_HOSTS; these tests assert
    // the SSRF refinements reject private URLs, so clear the bypass flag.
    delete process.env.SSRF_ALLOW_PRIVATE_HOSTS;
  });

  afterEach(() => {
    if (originalAllowFlag === undefined) {
      delete process.env.SSRF_ALLOW_PRIVATE_HOSTS;
    } else {
      process.env.SSRF_ALLOW_PRIVATE_HOSTS = originalAllowFlag;
    }
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it('should reject private URLs in API_BASE_URL', () => {
    const result = envSchema.safeParse({
      API_BASE_URL: 'http://localhost:3000',
      COMPLIANCE_AUDIT_SECRET: dummySecret
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.errors[0].message).toContain('SSRF protection');
    }
  });

  it('should reject private URLs in STELLAR_HORIZON_URL', () => {
    const result = envSchema.safeParse({
      STELLAR_HORIZON_URL: 'http://127.0.0.1:8000',
      COMPLIANCE_AUDIT_SECRET: dummySecret
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.errors[0].message).toContain('SSRF protection');
    }
  });

  it('should reject private URLs in STELLAR_RPC_URL', () => {
    const result = envSchema.safeParse({
      STELLAR_RPC_URL: 'http://169.254.169.254/latest/meta-data/',
      COMPLIANCE_AUDIT_SECRET: dummySecret
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.errors[0].message).toContain('SSRF protection');
    }
  });

  it('should allow public URLs', () => {
    const result = envSchema.safeParse({
      API_BASE_URL: 'https://api.talenttrust.io',
      STELLAR_HORIZON_URL: 'https://horizon-testnet.stellar.org',
      SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
      STELLAR_RPC_URL: 'https://rpc-testnet.stellar.org',
      COMPLIANCE_AUDIT_SECRET: dummySecret
    });
    expect(result.success).toBe(true);
  });

  it('should reject SSRF_ALLOW_PRIVATE_HOSTS outright in production', () => {
    process.env.NODE_ENV = 'production';
    const result = envSchema.safeParse({
      NODE_ENV: 'production',
      JWT_SECRET: productionSecret,
      SSRF_ALLOW_PRIVATE_HOSTS: 'true',
      API_BASE_URL: 'https://api.talenttrust.io',
      COMPLIANCE_AUDIT_SECRET: dummySecret,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.errors.map((e) => e.message).join(' ');
      expect(messages).toContain('SSRF_ALLOW_PRIVATE_HOSTS must not be enabled in production');
    }
  });

  it('should reject private URLs in production even when the allow flag is set', () => {
    // Schema refinements must call isSafeUrl (no short-circuit). isSafeUrl
    // ignores the flag in production, so private URLs fail SSRF checks.
    // Production also rejects the flag itself via superRefine.
    process.env.NODE_ENV = 'production';
    process.env.SSRF_ALLOW_PRIVATE_HOSTS = 'true';
    const result = envSchema.safeParse({
      NODE_ENV: 'production',
      JWT_SECRET: productionSecret,
      SSRF_ALLOW_PRIVATE_HOSTS: 'true',
      API_BASE_URL: 'http://127.0.0.1:3000',
      COMPLIANCE_AUDIT_SECRET: dummySecret,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.errors.map((e) => e.message).join(' ');
      expect(messages).toMatch(/SSRF protection|SSRF_ALLOW_PRIVATE_HOSTS/);
    }
  });

  it('should allow private URLs in non-production when SSRF_ALLOW_PRIVATE_HOSTS is true', () => {
    process.env.NODE_ENV = 'development';
    process.env.SSRF_ALLOW_PRIVATE_HOSTS = 'true';
    const result = envSchema.safeParse({
      NODE_ENV: 'development',
      SSRF_ALLOW_PRIVATE_HOSTS: 'true',
      API_BASE_URL: 'http://127.0.0.1:3000',
      COMPLIANCE_AUDIT_SECRET: dummySecret,
    });
    expect(result.success).toBe(true);
  });

  it('should reject private URLs in non-production when the allow flag is off', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.SSRF_ALLOW_PRIVATE_HOSTS;
    const result = envSchema.safeParse({
      NODE_ENV: 'development',
      API_BASE_URL: 'http://10.0.0.5/api',
      COMPLIANCE_AUDIT_SECRET: dummySecret,
    });
    expect(result.success).toBe(false);
  });
});
