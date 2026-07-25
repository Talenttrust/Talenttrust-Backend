import { isSafeUrl, isPrivateHost } from './ssrf';

describe('SSRF Protection Utility', () => {
  describe('isPrivateHost', () => {
    it('should identify localhost as private', () => {
      expect(isPrivateHost('localhost')).toBe(true);
      expect(isPrivateHost('LOCALHOST')).toBe(true);
      expect(isPrivateHost('127.0.0.1')).toBe(true);
      expect(isPrivateHost('0.0.0.0')).toBe(true);
    });

    it('should identify private IP ranges as private', () => {
      expect(isPrivateHost('10.0.0.1')).toBe(true);
      expect(isPrivateHost('172.16.0.1')).toBe(true);
      expect(isPrivateHost('172.31.255.255')).toBe(true);
      expect(isPrivateHost('192.168.1.1')).toBe(true);
    });

    it('should identify metadata endpoints as private', () => {
      expect(isPrivateHost('169.254.169.254')).toBe(true);
    });

    it('should identify public hosts as safe', () => {
      expect(isPrivateHost('google.com')).toBe(false);
      expect(isPrivateHost('8.8.8.8')).toBe(false);
      expect(isPrivateHost('horizon-testnet.stellar.org')).toBe(false);
    });

    it('should identify IPv6 loopback as private', () => {
      expect(isPrivateHost('::1')).toBe(true);
      expect(isPrivateHost('[::1]')).toBe(true);
    });

    it('should identify IPv6 ULA as private', () => {
      expect(isPrivateHost('fc00::1')).toBe(true);
      expect(isPrivateHost('fd12:3456:789a::1')).toBe(true);
      expect(isPrivateHost('[fd00::')).toBe(true);
    });

    it('should identify IPv6 link-local as private', () => {
      expect(isPrivateHost('fe80::1')).toBe(true);
      expect(isPrivateHost('[fe80::1%eth0')).toBe(true);
    });

    it('should identify IPv4-mapped IPv6 as private', () => {
      expect(isPrivateHost('::ffff:127.0.0.1')).toBe(true);
      expect(isPrivateHost('[::ffff:127.0.0.1]')).toBe(true);
      expect(isPrivateHost('[::ffff:10.0.0.1]')).toBe(true);
    });

    it('should identify decimal-encoded IPv4 as private', () => {
      expect(isPrivateHost('2130706433')).toBe(true); // 127.0.0.1
      expect(isPrivateHost('167772161')).toBe(true); // 10.0.0.1
    });

    it('should identify octal-encoded IPv4 as private', () => {
      expect(isPrivateHost('0177.0.0.1')).toBe(true);
      expect(isPrivateHost('012.0.0.1')).toBe(true);
    });

    it('should identify hex-encoded IPv4 as private', () => {
      expect(isPrivateHost('0x7f.0.0.1')).toBe(true);
      expect(isPrivateHost('0x0a.0.0.1')).toBe(true);
    });
  });

  describe('isSafeUrl', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      jest.resetModules();
      process.env = { ...originalEnv };
      // The global test setup enables SSRF_ALLOW_PRIVATE_HOSTS so unrelated
      // suites can deliver to loopback. These cases assert the fail-closed
      // default, so clear it and let each test opt in explicitly.
      delete process.env.SSRF_ALLOW_PRIVATE_HOSTS;
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    describe('in production mode', () => {
      it('should block URLs with private hostnames', () => {
        process.env.NODE_ENV = 'production';
        expect(isSafeUrl('http://localhost:3000')).toBe(false);
        expect(isSafeUrl('https://127.0.0.1/admin')).toBe(false);
        expect(isSafeUrl('http://10.0.0.5/api')).toBe(false);
        expect(isSafeUrl('http://169.254.169.254/latest/meta-data/')).toBe(false);
      });

      it('should block URLs with IPv6 private hosts', () => {
        process.env.NODE_ENV = 'production';
        expect(isSafeUrl('http://[::1]:3000')).toBe(false);
        expect(isSafeUrl('https://[::ffff:127.0.0.1]:8080')).toBe(false);
        expect(isSafeUrl('http://[fc00::1]:3000')).toBe(false);
      });

      it('should ignore SSRF_ALLOW_PRIVATE_HOSTS flag', () => {
        process.env.NODE_ENV = 'production';
        process.env.SSRF_ALLOW_PRIVATE_HOSTS = 'true';
        expect(isSafeUrl('http://localhost:3000')).toBe(false);
      });

      it('should allow URLs with public hostnames', () => {
        process.env.NODE_ENV = 'production';
        expect(isSafeUrl('https://google.com')).toBe(true);
        expect(isSafeUrl('https://horizon.stellar.org/accounts')).toBe(true);
        expect(isSafeUrl('http://example.com/foo?bar=baz')).toBe(true);
      });

      it('should return false for invalid URLs', () => {
        process.env.NODE_ENV = 'production';
        expect(isSafeUrl('not-a-url')).toBe(false);
        expect(isSafeUrl('')).toBe(false);
      });
    });

    describe('in development mode', () => {
      it('should block private hosts by default', () => {
        process.env.NODE_ENV = 'development';
        expect(isSafeUrl('http://localhost:3000')).toBe(false);
        expect(isSafeUrl('http://127.0.0.1')).toBe(false);
      });

      it('should allow private hosts when SSRF_ALLOW_PRIVATE_HOSTS is true', () => {
        process.env.NODE_ENV = 'development';
        process.env.SSRF_ALLOW_PRIVATE_HOSTS = 'true';
        expect(isSafeUrl('http://localhost:3000')).toBe(true);
      });

      it('should allow public hosts', () => {
        process.env.NODE_ENV = 'development';
        expect(isSafeUrl('https://google.com')).toBe(true);
      });
    });

    describe('in test mode', () => {
      it('should block private hosts by default', () => {
        process.env.NODE_ENV = 'test';
        expect(isSafeUrl('http://localhost:3000')).toBe(false);
      });

      it('should allow private hosts when SSRF_ALLOW_PRIVATE_HOSTS is true', () => {
        process.env.NODE_ENV = 'test';
        process.env.SSRF_ALLOW_PRIVATE_HOSTS = 'true';
        expect(isSafeUrl('http://localhost:3000')).toBe(true);
      });
    });

    describe('with unset NODE_ENV', () => {
      it('should block private hosts by default', () => {
        delete process.env.NODE_ENV;
        expect(isSafeUrl('http://localhost:3000')).toBe(false);
      });

      it('should allow private hosts when SSRF_ALLOW_PRIVATE_HOSTS is true', () => {
        delete process.env.NODE_ENV;
        process.env.SSRF_ALLOW_PRIVATE_HOSTS = 'true';
        expect(isSafeUrl('http://localhost:3000')).toBe(true);
      });
    });
  });
});
