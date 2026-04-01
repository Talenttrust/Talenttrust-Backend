import { Request, Response, NextFunction } from 'express';
import { idempotencyMiddleware, clearIdempotencyStore } from './idempotency';

describe('idempotencyMiddleware', () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let nextFunction: NextFunction;

  beforeEach(() => {
    mockRequest = {
      headers: {},
    };
    mockResponse = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
      send: jest.fn() as any,
    };
    nextFunction = jest.fn();
    clearIdempotencyStore();
  });

  it('should return 400 if Idempotency-Key header is missing', () => {
    idempotencyMiddleware(mockRequest as Request, mockResponse as Response, nextFunction);
    expect(mockResponse.status).toHaveBeenCalledWith(400);
    expect(mockResponse.json).toHaveBeenCalledWith({ error: 'Idempotency-Key header is required' });
  });

  it('should allow operation with new Idempotency-Key', () => {
    mockRequest.headers!['idempotency-key'] = 'unique-key-1';
    idempotencyMiddleware(mockRequest as Request, mockResponse as Response, nextFunction);
    expect(nextFunction).toHaveBeenCalled();
  });

  it('should return 409 if Idempotency-Key is still in processing status', () => {
    mockRequest.headers!['idempotency-key'] = 'processing-key';
    
    // First call sets it to processing
    idempotencyMiddleware(mockRequest as Request, mockResponse as Response, nextFunction);
    
    // Second call with same key
    idempotencyMiddleware(mockRequest as Request, mockResponse as Response, nextFunction);
    expect(mockResponse.status).toHaveBeenCalledWith(409);
    expect(mockResponse.json).toHaveBeenCalledWith({ error: 'Request is already being processed' });
  });

  it('should return cached response for completed Idempotency-Key', () => {
    mockRequest.headers!['idempotency-key'] = 'completed-key';
    
    // First call sets it to processing
    idempotencyMiddleware(mockRequest as Request, mockResponse as Response, nextFunction);
    
    const originalBody = { status: 'success', data: { id: 123 } };
    // Simulate completion
    (mockResponse.send as any)(JSON.stringify(originalBody));

    // Reset mock response to track new call
    mockResponse.status = jest.fn().mockReturnThis();
    mockResponse.json = jest.fn();

    // Replay request
    idempotencyMiddleware(mockRequest as Request, mockResponse as Response, nextFunction);
    expect(mockResponse.status).toHaveBeenCalledWith(200);
    expect(mockResponse.json).toHaveBeenCalledWith({
      ...originalBody,
      idempotencyHeader: 'replay-detected'
    });
  });
});
