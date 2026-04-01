import { Request, Response, NextFunction } from 'express';
import { sanitize } from './sanitize';

describe('Sanitize Middleware', () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let nextFunction: NextFunction = jest.fn();

  beforeEach(() => {
    mockRequest = {};
    mockResponse = {
      json: jest.fn(),
      status: jest.fn().mockReturnThis(),
    };
    nextFunction = jest.fn();
  });

  it('should sanitize xss in req.body', () => {
    mockRequest.body = {
      name: '<script>alert("xss")</script>John',
      details: {
        bio: 'Hello <img src="x" onerror="alert(1)"> World'
      }
    };

    sanitize(mockRequest as Request, mockResponse as Response, nextFunction);

    expect(mockRequest.body.name).toBe('John'); // <script> is stripped entirely by stripIgnoreTagBody
    expect(mockRequest.body.details.bio).toBe('Hello  World'); // <img> tag is stripped by stripIgnoreTag
    expect(nextFunction).toHaveBeenCalled();
  });

  it('should ignore non-string values', () => {
    mockRequest.body = {
      age: 25,
      isActive: true,
      data: null
    };

    sanitize(mockRequest as Request, mockResponse as Response, nextFunction);

    expect(mockRequest.body.age).toBe(25);
    expect(mockRequest.body.isActive).toBe(true);
    expect(mockRequest.body.data).toBeNull();
  });

  it('should handle arrays', () => {
    mockRequest.body = {
      tags: ['<script>bad</script>tag1', 'tag2', 123]
    };

    sanitize(mockRequest as Request, mockResponse as Response, nextFunction);

    expect(mockRequest.body.tags[0]).toBe('tag1');
    expect(mockRequest.body.tags[1]).toBe('tag2');
    expect(mockRequest.body.tags[2]).toBe(123);
  });

  it('should not mutate Date or Buffer objects', () => {
    const date = new Date('2024-01-01');
    const buffer = Buffer.from('test');

    mockRequest.body = {
      createdAt: date,
      fileData: buffer
    };

    sanitize(mockRequest as Request, mockResponse as Response, nextFunction);

    expect(mockRequest.body.createdAt).toBe(date);
    expect(mockRequest.body.fileData).toBe(buffer);
  });
});
