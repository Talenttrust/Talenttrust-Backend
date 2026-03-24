/**
 * Version Extractor Tests
 * Comprehensive test suite for API version extraction logic
 */

import { Request } from 'express';
import { extractVersion, isValidVersion } from './extractor';

describe('Version Extractor', () => {
  describe('extractVersion', () => {
    it('should extract version from URL path', () => {
      const req = {
        path: '/api/v1/contracts',
        get: () => undefined,
        query: {},
      } as unknown as Request;

      expect(extractVersion(req)).toBe('v1');
    });

    it('should extract v2 from URL path', () => {
      const req = {
        path: '/api/v2/users',
        get: () => undefined,
        query: {},
      } as unknown as Request;

      expect(extractVersion(req)).toBe('v2');
    });

    it('should extract version from Accept header', () => {
      const req = {
        path: '/api/contracts',
        get: (header: string) => 
          header === 'Accept' ? 'application/vnd.talenttrust.v2+json' : undefined,
        query: {},
      } as unknown as Request;

      expect(extractVersion(req)).toBe('v2');
    });

    it('should extract version from query parameter', () => {
      const req = {
        path: '/api/contracts',
        get: () => undefined,
        query: { version: 'v2' },
      } as unknown as Request;

      expect(extractVersion(req)).toBe('v2');
    });

    it('should prioritize URL path over header', () => {
      const req = {
        path: '/api/v1/contracts',
        get: (header: string) => 
          header === 'Accept' ? 'application/vnd.talenttrust.v2+json' : undefined,
        query: {},
      } as unknown as Request;

      expect(extractVersion(req)).toBe('v1');
    });

    it('should prioritize header over query parameter', () => {
      const req = {
        path: '/api/contracts',
        get: (header: string) => 
          header === 'Accept' ? 'application/vnd.talenttrust.v2+json' : undefined,
        query: { version: 'v1' },
      } as unknown as Request;

      expect(extractVersion(req)).toBe('v2');
    });

    it('should default to v1 when no version specified', () => {
      const req = {
        path: '/api/contracts',
        get: () => undefined,
        query: {},
      } as unknown as Request;

      expect(extractVersion(req)).toBe('v1');
    });

    it('should default to v1 for invalid version in URL', () => {
      const req = {
        path: '/api/v99/contracts',
        get: () => undefined,
        query: {},
      } as unknown as Request;

      expect(extractVersion(req)).toBe('v1');
    });

    it('should handle malformed Accept header gracefully', () => {
      const req = {
        path: '/api/contracts',
        get: (header: string) => 
          header === 'Accept' ? 'application/json' : undefined,
        query: {},
      } as unknown as Request;

      expect(extractVersion(req)).toBe('v1');
    });
  });

  describe('isValidVersion', () => {
    it('should return true for v1', () => {
      expect(isValidVersion('v1')).toBe(true);
    });

    it('should return true for v2', () => {
      expect(isValidVersion('v2')).toBe(true);
    });

    it('should return false for v3', () => {
      expect(isValidVersion('v3')).toBe(false);
    });

    it('should return false for invalid format', () => {
      expect(isValidVersion('1')).toBe(false);
      expect(isValidVersion('version1')).toBe(false);
      expect(isValidVersion('')).toBe(false);
    });
  });
});
