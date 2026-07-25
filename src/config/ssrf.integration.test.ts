import { envSchema } from './env.schema';

describe('envSchema SSRF Protection', () => {
  const dummySecret = 'a'.repeat(32);
  const originalAllowFlag = process.env.SSRF_ALLOW_PRIVATE_HOSTS;

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
});

