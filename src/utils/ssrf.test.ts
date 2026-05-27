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
  });

  describe('isSafeUrl', () => {
    it('should block URLs with private hostnames', () => {
      expect(isSafeUrl('http://localhost:3000')).toBe(false);
      expect(isSafeUrl('https://127.0.0.1/admin')).toBe(false);
      expect(isSafeUrl('http://10.0.0.5/api')).toBe(false);
      expect(isSafeUrl('http://169.254.169.254/latest/meta-data/')).toBe(false);
    });

    it('should allow URLs with public hostnames', () => {
      expect(isSafeUrl('https://google.com')).toBe(true);
      expect(isSafeUrl('https://horizon.stellar.org/accounts')).toBe(true);
      expect(isSafeUrl('http://example.com/foo?bar=baz')).toBe(true);
    });

    it('should return false for invalid URLs', () => {
      expect(isSafeUrl('not-a-url')).toBe(false);
      expect(isSafeUrl('')).toBe(false);
    });
  });
});
