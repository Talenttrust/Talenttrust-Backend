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

  it('should sanitize deeply nested objects and arrays', () => {
    mockRequest.body = {
      user: { bio: '  <b>hi</b>  ', tags: ['<i>a</i>', { note: '<script>x</script>z' }] },
    };

    sanitize(mockRequest as Request, mockResponse as Response, nextFunction);

    expect(mockRequest.body.user.bio).toBe('hi');
    expect(mockRequest.body.user.tags[0]).toBe('a');
    expect(mockRequest.body.user.tags[1].note).toBe('z');
  });

  it('should reject prototype-pollution keys without polluting Object.prototype', () => {
    mockRequest.body = JSON.parse('{"__proto__": {"polluted": true}, "safe": "ok"}');

    sanitize(mockRequest as Request, mockResponse as Response, nextFunction);

    expect(mockRequest.body.safe).toBe('ok');
    expect(Object.prototype.hasOwnProperty.call(mockRequest.body, '__proto__')).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('should drop constructor and prototype keys during recursion', () => {
    mockRequest.body = {
      nested: JSON.parse('{"constructor": "bad", "prototype": "bad", "keep": "good"}'),
    };

    sanitize(mockRequest as Request, mockResponse as Response, nextFunction);

    expect(mockRequest.body.nested.keep).toBe('good');
    expect(Object.prototype.hasOwnProperty.call(mockRequest.body.nested, 'constructor')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(mockRequest.body.nested, 'prototype')).toBe(false);
  });

  it('should be idempotent: running twice yields the same result', () => {
    mockRequest.body = { msg: '<script>alert(1)</script>clean', list: ['<b>x</b>'] };

    sanitize(mockRequest as Request, mockResponse as Response, nextFunction);
    const afterOnce = JSON.parse(JSON.stringify(mockRequest.body));

    const second: Partial<Request> = { body: afterOnce };
    sanitize(second as Request, mockResponse as Response, nextFunction);
    expect(second.body).toEqual(afterOnce);
  });

  it('should not mutate the original input object', () => {
    const original = { name: '<b>v</b>' };
    mockRequest.body = original;

    sanitize(mockRequest as Request, mockResponse as Response, nextFunction);

    expect(original.name).toBe('<b>v</b>');
    expect(mockRequest.body.name).toBe('v');
    expect(mockRequest.body).not.toBe(original);
  });

  it('should preserve array shapes for query params (e.g. ?tag=a&tag=b)', () => {
    mockRequest.query = { tag: ['<i>a</i>', 'b'], q: 'hi' } as never;

    sanitize(mockRequest as Request, mockResponse as Response, nextFunction);

    const query = mockRequest.query as Record<string, unknown>;
    expect(Array.isArray(query.tag)).toBe(true);
    expect(query.tag).toEqual(['a', 'b']);
    expect(query.q).toBe('hi');
  });

  it('should preserve params shapes', () => {
    mockRequest.params = { id: '123', slug: '<x>name</x>' } as never;

    sanitize(mockRequest as Request, mockResponse as Response, nextFunction);

    const params = mockRequest.params as Record<string, string>;
    expect(params.id).toBe('123');
    expect(params.slug).toBe('name');
  });
});
