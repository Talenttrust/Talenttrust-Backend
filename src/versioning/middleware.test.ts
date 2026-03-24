/**
 * Versioning Middleware Tests
 * Test suite for version extraction and enforcement middleware
 */

import { Response, NextFunction } from 'express';
import { VersionedRequest } from './types';
import { versionMiddleware, requireMinVersion } from './middleware';
import { registerDeprecation, clearDeprecationRegistry } from './deprecation';

describe('Versioning Middleware', () => {
  beforeEach(() => {
    clearDeprecationRegistry();
  });

  describe('versionMiddleware', () => {
    let mockRequest: Partial<VersionedRequest>;
    let mockResponse: Partial<Response>;
    let mockNext: NextFunction;
    let headers: Record<string, string>;

    beforeEach(() => {
      headers = {};
      mockRequest = {
        path: '/api/v1/test',
        method: 'GET',
        get: () => undefined,
        query: {},
      } as any;
      mockResponse = {
        setHeader: jest.fn((name: string, value: string) => {
          headers[name] = value;
          return mockResponse as Response;
        }),
      } as any;
      mockNext = jest.fn();
    });

    it('should extract and attach version to request', () => {
      versionMiddleware(
        mockRequest as VersionedRequest,
        mockResponse as Response,
        mockNext
      );

      expect(mockRequest.apiVersion).toBe('v1');
      expect(mockNext).toHaveBeenCalled();
    });

    it('should call next without adding headers for non-deprecated endpoint', () => {
      versionMiddleware(
        mockRequest as VersionedRequest,
        mockResponse as Response,
        mockNext
      );

      expect(headers['Deprecation']).toBeUndefined();
      expect(mockNext).toHaveBeenCalled();
    });

    it('should add deprecation headers for deprecated endpoint', () => {
      registerDeprecation('GET', '/api/v1/test', {
        deprecatedIn: 'v1',
        deprecatedAt: new Date('2024-01-01'),
        sunsetDate: new Date('2024-12-31'),
        replacement: '/api/v2/test',
      });

      versionMiddleware(
        mockRequest as VersionedRequest,
        mockResponse as Response,
        mockNext
      );

      expect(headers['Deprecation']).toBe('true');
      expect(headers['Sunset']).toBeDefined();
      expect(mockNext).toHaveBeenCalled();
    });

    it('should handle different HTTP methods correctly', () => {
      mockRequest = {
        ...mockRequest,
        method: 'POST',
        path: '/api/v1/create',
      } as any;

      registerDeprecation('POST', '/api/v1/create', {
        deprecatedIn: 'v1',
        deprecatedAt: new Date('2024-01-01'),
        sunsetDate: new Date('2024-12-31'),
      });

      versionMiddleware(
        mockRequest as VersionedRequest,
        mockResponse as Response,
        mockNext
      );

      expect(headers['Deprecation']).toBe('true');
    });
  });

  describe('requireMinVersion', () => {
    let mockRequest: Partial<VersionedRequest>;
    let mockResponse: Partial<Response>;
    let mockNext: NextFunction;
    let responseData: any;

    beforeEach(() => {
      responseData = null;
      mockRequest = {
        apiVersion: 'v1',
      } as any;
      mockResponse = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn((data) => {
          responseData = data;
          return mockResponse as Response;
        }),
      } as any;
      mockNext = jest.fn();
    });

    it('should allow request when version meets minimum', () => {
      mockRequest.apiVersion = 'v2';
      const middleware = requireMinVersion('v2');

      middleware(
        mockRequest as VersionedRequest,
        mockResponse as Response,
        mockNext
      );

      expect(mockNext).toHaveBeenCalled();
      expect(mockResponse.status).not.toHaveBeenCalled();
    });

    it('should allow request when version exceeds minimum', () => {
      mockRequest.apiVersion = 'v2';
      const middleware = requireMinVersion('v1');

      middleware(
        mockRequest as VersionedRequest,
        mockResponse as Response,
        mockNext
      );

      expect(mockNext).toHaveBeenCalled();
      expect(mockResponse.status).not.toHaveBeenCalled();
    });

    it('should reject request when version is below minimum', () => {
      mockRequest.apiVersion = 'v1';
      const middleware = requireMinVersion('v2');

      middleware(
        mockRequest as VersionedRequest,
        mockResponse as Response,
        mockNext
      );

      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(responseData).toEqual({
        error: 'Version not supported',
        message: 'This endpoint requires API version v2 or higher',
        requestedVersion: 'v1',
        minimumVersion: 'v2',
      });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should default to v1 when no version specified', () => {
      mockRequest.apiVersion = undefined;
      const middleware = requireMinVersion('v2');

      middleware(
        mockRequest as VersionedRequest,
        mockResponse as Response,
        mockNext
      );

      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(responseData.requestedVersion).toBe('v1');
    });

    it('should handle v1 minimum requirement', () => {
      mockRequest.apiVersion = 'v1';
      const middleware = requireMinVersion('v1');

      middleware(
        mockRequest as VersionedRequest,
        mockResponse as Response,
        mockNext
      );

      expect(mockNext).toHaveBeenCalled();
      expect(mockResponse.status).not.toHaveBeenCalled();
    });
  });
});
