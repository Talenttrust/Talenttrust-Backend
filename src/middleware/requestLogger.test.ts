/**
 * Unit tests for src/middleware/requestLogger.ts
 *
 * Coverage targets:
 *   - Request ID generation and extraction
 *   - Correlation ID handling
 *   - Logger attachment to request object
 *   - Header sanitization
 *   - Request/response logging
 *   - Custom middleware factory
 */

import { Request, Response, NextFunction } from 'express';
import { requestLoggerMiddleware, createRequestLoggerMiddleware } from './requestLogger';

// Mock UUID
jest.mock('uuid', () => ({
  v4: () => 'mock-uuid-1234'
}));

// Mock logger
jest.mock('../logger', () => ({
  createRequestLogger: jest.fn().mockReturnValue({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  })
}));

describe('requestLoggerMiddleware', () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let mockNext: NextFunction;

  beforeEach(() => {
    mockRequest = {
      method: 'GET',
      url: '/test',
      header: jest.fn(),
      ip: '127.0.0.1',
      connection: { remoteAddress: '127.0.0.1' }
    };

    mockResponse = {
      setHeader: jest.fn(),
      getHeaders: jest.fn().mockReturnValue({}),
      statusCode: 200,
      end: jest.fn()
    };

    mockNext = jest.fn();
  });

  it('generates request ID when not provided in headers', () => {
    mockRequest.header = jest.fn().mockReturnValue(undefined);
    
    requestLoggerMiddleware(
      mockRequest as Request,
      mockResponse as Response,
      mockNext
    );

    expect(mockRequest.requestId).toBe('mock-uuid-1234');
    expect(mockResponse.setHeader).toHaveBeenCalledWith('x-request-id', 'mock-uuid-1234');
  });

  it('uses request ID from headers when provided', () => {
    mockRequest.header = jest.fn()
      .mockImplementation((header: string) => {
        if (header === 'x-request-id') return 'provided-req-id';
        return undefined;
      });

    requestLoggerMiddleware(
      mockRequest as Request,
      mockResponse as Response,
      mockNext
    );

    expect(mockRequest.requestId).toBe('provided-req-id');
    expect(mockResponse.setHeader).toHaveBeenCalledWith('x-request-id', 'provided-req-id');
  });

  it('generates correlation ID when not provided', () => {
    mockRequest.header = jest.fn().mockReturnValue(undefined);
    
    requestLoggerMiddleware(
      mockRequest as Request,
      mockResponse as Response,
      mockNext
    );

    expect(mockRequest.correlationId).toBe('mock-uuid-1234');
    expect(mockResponse.setHeader).toHaveBeenCalledWith('x-correlation-id', 'mock-uuid-1234');
  });

  it('uses correlation ID from headers when provided', () => {
    mockRequest.header = jest.fn()
      .mockImplementation((header: string) => {
        if (header === 'x-correlation-id') return 'provided-corr-id';
        return undefined;
      });

    requestLoggerMiddleware(
      mockRequest as Request,
      mockResponse as Response,
      mockNext
    );

    expect(mockRequest.correlationId).toBe('provided-corr-id');
    expect(mockResponse.setHeader).toHaveBeenCalledWith('x-correlation-id', 'provided-corr-id');
  });

  it('extracts correlation ID from alternative headers', () => {
    mockRequest.header = jest.fn()
      .mockImplementation((header: string) => {
        if (header === 'x-trace-id') return 'trace-123';
        return undefined;
      });

    requestLoggerMiddleware(
      mockRequest as Request,
      mockResponse as Response,
      mockNext
    );

    expect(mockRequest.correlationId).toBe('trace-123');
  });

  it('attaches logger to request object', () => {
    const { createRequestLogger } = require('../logger');
    
    requestLoggerMiddleware(
      mockRequest as Request,
      mockResponse as Response,
      mockNext
    );

    expect(createRequestLogger).toHaveBeenCalledWith('mock-uuid-1234', 'mock-uuid-1234');
    expect(mockRequest.logger).toBeDefined();
  });

  it('calls next function', () => {
    requestLoggerMiddleware(
      mockRequest as Request,
      mockResponse as Response,
      mockNext
    );

    expect(mockNext).toHaveBeenCalled();
  });
});

describe('createRequestLoggerMiddleware', () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let mockNext: NextFunction;

  beforeEach(() => {
    mockRequest = {
      method: 'POST',
      url: '/api/test',
      header: jest.fn(),
      ip: '127.0.0.1',
      connection: { remoteAddress: '127.0.0.1' },
      body: { data: 'test' }
    };

    mockResponse = {
      setHeader: jest.fn(),
      getHeaders: jest.fn().mockReturnValue({}),
      statusCode: 201,
      end: jest.fn()
    };

    mockNext = jest.fn();
  });

  it('creates middleware with custom header names', () => {
    const customMiddleware = createRequestLoggerMiddleware({
      correlationIdHeader: 'x-custom-corr',
      requestIdHeader: 'x-custom-req'
    });

    mockRequest.header = jest.fn().mockReturnValue(undefined);
    
    customMiddleware(
      mockRequest as Request,
      mockResponse as Response,
      mockNext
    );

    expect(mockResponse.setHeader).toHaveBeenCalledWith('x-custom-req', 'mock-uuid-1234');
    expect(mockResponse.setHeader).toHaveBeenCalledWith('x-custom-corr', 'mock-uuid-1234');
  });

  it('respects logBody option', () => {
    const customMiddleware = createRequestLoggerMiddleware({ logBody: true });
    const { createRequestLogger } = require('../logger');
    const mockLogger = { info: jest.fn() };
    createRequestLogger.mockReturnValue(mockLogger);

    mockRequest.header = jest.fn().mockReturnValue(undefined);
    
    customMiddleware(
      mockRequest as Request,
      mockResponse as Response,
      mockNext
    );

    // Verify that the logger was called with body included
    expect(mockLogger.info).toHaveBeenCalledWith(
      'Request started',
      expect.objectContaining({
        method: 'POST',
        url: '/api/test',
        body: { data: 'test' }
      })
    );
  });

  it('respects logResponseBody option', () => {
    const customMiddleware = createRequestLoggerMiddleware({ logResponseBody: true });
    const { createRequestLogger } = require('../logger');
    const mockLogger = { info: jest.fn() };
    createRequestLogger.mockReturnValue(mockLogger);

    mockRequest.header = jest.fn().mockReturnValue(undefined);
    
    customMiddleware(
      mockRequest as Request,
      mockResponse as Response,
      mockNext
    );

    // Simulate response end
    const endCall = mockResponse.end.mock.calls[0];
    if (endCall && endCall[0]) {
      // Call the end function with response data
      endCall[0]('response data');
    }

    // Verify that response body was logged
    expect(mockLogger.info).toHaveBeenCalledWith(
      'Request completed',
      expect.objectContaining({
        responseBody: 'response data'
      })
    );
  });
});
