import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { validateSchema } from './validate.middleware';

describe('Validate Middleware', () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let mockNext: NextFunction;

  beforeEach(() => {
    mockRequest = {
      body: {},
      query: {},
      params: {}
    };
    mockResponse = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    mockNext = jest.fn();
  });

  it('should validate successfully', async () => {
    const schema = z.object({
      body: z.object({
        name: z.string(),
      })
    });

    mockRequest.body = { name: 'Test' };
    const middleware = validateSchema(schema);
    await middleware(mockRequest as Request, mockResponse as Response, mockNext);

    expect(mockNext).toHaveBeenCalledWith();
  });

  it('should handle ZodError and return 400', async () => {
    const schema = z.object({
      body: z.object({
        name: z.string(),
      })
    });

    const middleware = validateSchema(schema);
    await middleware(mockRequest as Request, mockResponse as Response, mockNext);

    expect(mockResponse.status).toHaveBeenCalledWith(400);
    expect(mockResponse.json).toHaveBeenCalledWith(expect.objectContaining({
      status: 'error',
      message: 'Validation failed',
    }));
  });

  it('should pass non-Zod errors to next()', async () => {
    const errorSchema = {
      parseAsync: jest.fn().mockRejectedValue(new Error('Generic Error'))
    } as any;

    const middleware = validateSchema(errorSchema);
    await middleware(mockRequest as Request, mockResponse as Response, mockNext);

    expect(mockNext).toHaveBeenCalledWith(expect.any(Error));
  });
});
