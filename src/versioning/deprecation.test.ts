/**
 * Deprecation Management Tests
 * Test suite for endpoint deprecation tracking and warning headers
 */

import { Response } from 'express';
import {
  registerDeprecation,
  getDeprecationInfo,
  addDeprecationHeaders,
  clearDeprecationRegistry,
  getAllDeprecations,
} from './deprecation';
import { DeprecationInfo } from './types';

describe('Deprecation Management', () => {
  beforeEach(() => {
    clearDeprecationRegistry();
  });

  describe('registerDeprecation', () => {
    it('should register a deprecated endpoint', () => {
      const info: DeprecationInfo = {
        deprecatedIn: 'v1',
        deprecatedAt: new Date('2024-01-01'),
        sunsetDate: new Date('2024-12-31'),
        replacement: '/api/v2/test',
      };

      registerDeprecation('GET', '/api/v1/test', info);
      const retrieved = getDeprecationInfo('GET', '/api/v1/test');

      expect(retrieved).toEqual(info);
    });

    it('should handle case-insensitive HTTP methods', () => {
      const info: DeprecationInfo = {
        deprecatedIn: 'v1',
        deprecatedAt: new Date('2024-01-01'),
        sunsetDate: new Date('2024-12-31'),
      };

      registerDeprecation('get', '/api/v1/test', info);
      const retrieved = getDeprecationInfo('GET', '/api/v1/test');

      expect(retrieved).toEqual(info);
    });

    it('should allow multiple endpoints to be registered', () => {
      const info1: DeprecationInfo = {
        deprecatedIn: 'v1',
        deprecatedAt: new Date('2024-01-01'),
        sunsetDate: new Date('2024-12-31'),
      };

      const info2: DeprecationInfo = {
        deprecatedIn: 'v1',
        deprecatedAt: new Date('2024-02-01'),
        sunsetDate: new Date('2025-01-31'),
      };

      registerDeprecation('GET', '/api/v1/endpoint1', info1);
      registerDeprecation('POST', '/api/v1/endpoint2', info2);

      expect(getDeprecationInfo('GET', '/api/v1/endpoint1')).toEqual(info1);
      expect(getDeprecationInfo('POST', '/api/v1/endpoint2')).toEqual(info2);
    });
  });

  describe('getDeprecationInfo', () => {
    it('should return undefined for non-deprecated endpoint', () => {
      const result = getDeprecationInfo('GET', '/api/v1/active');
      expect(result).toBeUndefined();
    });

    it('should distinguish between different HTTP methods', () => {
      const info: DeprecationInfo = {
        deprecatedIn: 'v1',
        deprecatedAt: new Date('2024-01-01'),
        sunsetDate: new Date('2024-12-31'),
      };

      registerDeprecation('GET', '/api/v1/test', info);

      expect(getDeprecationInfo('GET', '/api/v1/test')).toEqual(info);
      expect(getDeprecationInfo('POST', '/api/v1/test')).toBeUndefined();
    });
  });

  describe('addDeprecationHeaders', () => {
    let mockResponse: Partial<Response>;
    let headers: Record<string, string>;

    beforeEach(() => {
      headers = {};
      mockResponse = {
        setHeader: jest.fn((name: string, value: string) => {
          headers[name] = value;
          return mockResponse as Response;
        }),
      } as any;
    });

    it('should add Deprecation header', () => {
      const info: DeprecationInfo = {
        deprecatedIn: 'v1',
        deprecatedAt: new Date('2024-01-01'),
        sunsetDate: new Date('2024-12-31'),
      };

      addDeprecationHeaders(mockResponse as Response, info);

      expect(headers['Deprecation']).toBe('true');
    });

    it('should add Sunset header with RFC 8594 format', () => {
      const sunsetDate = new Date('2024-12-31T23:59:59Z');
      const info: DeprecationInfo = {
        deprecatedIn: 'v1',
        deprecatedAt: new Date('2024-01-01'),
        sunsetDate,
      };

      addDeprecationHeaders(mockResponse as Response, info);

      expect(headers['Sunset']).toBe(sunsetDate.toUTCString());
    });

    it('should add Link header when replacement is provided', () => {
      const info: DeprecationInfo = {
        deprecatedIn: 'v1',
        deprecatedAt: new Date('2024-01-01'),
        sunsetDate: new Date('2024-12-31'),
        replacement: '/api/v2/new-endpoint',
      };

      addDeprecationHeaders(mockResponse as Response, info);

      expect(headers['Link']).toBe('</api/v2/new-endpoint>; rel="successor-version"');
    });

    it('should not add Link header when no replacement provided', () => {
      const info: DeprecationInfo = {
        deprecatedIn: 'v1',
        deprecatedAt: new Date('2024-01-01'),
        sunsetDate: new Date('2024-12-31'),
      };

      addDeprecationHeaders(mockResponse as Response, info);

      expect(headers['Link']).toBeUndefined();
    });

    it('should add custom warning header with details', () => {
      const info: DeprecationInfo = {
        deprecatedIn: 'v1',
        deprecatedAt: new Date('2024-01-01'),
        sunsetDate: new Date('2024-12-31'),
        replacement: '/api/v2/test',
        notes: 'Use new API for better performance',
      };

      addDeprecationHeaders(mockResponse as Response, info);

      const warning = headers['X-API-Deprecation-Warning'];
      expect(warning).toContain('2024-01-01');
      expect(warning).toContain('2024-12-31');
      expect(warning).toContain('/api/v2/test');
      expect(warning).toContain('Use new API for better performance');
    });
  });

  describe('clearDeprecationRegistry', () => {
    it('should clear all registered deprecations', () => {
      const info: DeprecationInfo = {
        deprecatedIn: 'v1',
        deprecatedAt: new Date('2024-01-01'),
        sunsetDate: new Date('2024-12-31'),
      };

      registerDeprecation('GET', '/api/v1/test', info);
      expect(getDeprecationInfo('GET', '/api/v1/test')).toBeDefined();

      clearDeprecationRegistry();
      expect(getDeprecationInfo('GET', '/api/v1/test')).toBeUndefined();
    });
  });

  describe('getAllDeprecations', () => {
    it('should return all registered deprecations', () => {
      const info1: DeprecationInfo = {
        deprecatedIn: 'v1',
        deprecatedAt: new Date('2024-01-01'),
        sunsetDate: new Date('2024-12-31'),
      };

      const info2: DeprecationInfo = {
        deprecatedIn: 'v1',
        deprecatedAt: new Date('2024-02-01'),
        sunsetDate: new Date('2025-01-31'),
      };

      registerDeprecation('GET', '/api/v1/endpoint1', info1);
      registerDeprecation('POST', '/api/v1/endpoint2', info2);

      const all = getAllDeprecations();
      expect(all.size).toBe(2);
      expect(all.get('GET /api/v1/endpoint1')).toEqual(info1);
      expect(all.get('POST /api/v1/endpoint2')).toEqual(info2);
    });

    it('should return empty map when no deprecations registered', () => {
      const all = getAllDeprecations();
      expect(all.size).toBe(0);
    });
  });
});
