import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { validateSchema, validateRequest, validateParams, validateQuery } from './validate.middleware';

function createMocks(body: unknown = {}, query: unknown = {}, params: unknown = {}) {
  const req = { body, query, params } as Request;
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
    locals: { requestId: 'test-req-id' },
  } as unknown as Response;
  const next = jest.fn() as NextFunction;
  return { req, res, next };
}

describe('Validate Middleware', () => {
  describe('validateSchema', () => {
    it('should validate successfully', async () => {
      const schema = z.object({
        body: z.object({ name: z.string() }),
      });
      const { req, res, next } = createMocks({ name: 'Test' });

      await validateSchema(schema)(req, res, next);

      expect(next).toHaveBeenCalledWith();
    });

    it('should replace req properties with validated data', async () => {
      const schema = z.object({
        body: z.object({ name: z.string() }).transform((d) => ({ name: d.name.toUpperCase() })),
      });
      const { req, res, next } = createMocks({ name: 'test' });

      await validateSchema(schema)(req, res, next);

      expect(next).toHaveBeenCalledWith();
      expect(req.body).toEqual({ name: 'TEST' });
    });

    it('should handle ZodError and return 400', async () => {
      const schema = z.object({
        body: z.object({ name: z.string() }),
      });
      const { req, res, next } = createMocks({});

      await validateSchema(schema)(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            code: 'validation_error',
            message: 'Request validation failed',
            requestId: 'test-req-id',
            details: expect.arrayContaining([
              expect.objectContaining({
                path: expect.any(Array),
                message: expect.any(String),
                code: expect.any(String),
              }),
            ]),
          }),
        }),
      );
    });

    it('should use "unknown" requestId when res.locals.requestId is missing', async () => {
      const schema = z.object({
        body: z.object({ name: z.string() }),
      });
      const req = { body: {}, query: {}, params: {} } as Request;
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
        locals: {},
      } as unknown as Response;
      const next = jest.fn() as NextFunction;

      await validateSchema(schema)(req, res, next);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({ requestId: 'unknown' }),
        }),
      );
    });

    it('should pass non-Zod errors to next()', async () => {
      const errorSchema = {
        parseAsync: jest.fn().mockRejectedValue(new Error('Generic Error')),
      } as any;
      const { req, res, next } = createMocks();

      await validateSchema(errorSchema)(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });

    it('should error shape have path as string array', async () => {
      const schema = z.object({
        body: z.object({ age: z.number() }),
      });
      const { req, res, next } = createMocks({ age: 'not-a-number' });

      await validateSchema(schema)(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      const callArg = (res.json as jest.Mock).mock.calls[0][0];
      expect(callArg.error.details[0].path).toEqual(expect.any(Array));
      expect(typeof callArg.error.details[0].path[0]).toBe('string');
    });
  });

  describe('validateRequest', () => {
    it('should validate body only', async () => {
      const schema = z.object({ email: z.string().email() });
      const { req, res, next } = createMocks({ email: 'user@example.com' });

      await validateRequest(schema)(req, res, next);

      expect(next).toHaveBeenCalledWith();
    });

    it('should reject invalid body', async () => {
      const schema = z.object({ email: z.string().email() });
      const { req, res, next } = createMocks({ email: 'not-an-email' });

      await validateRequest(schema)(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({ code: 'validation_error' }),
        }),
      );
    });

    it('should replace req.body with validated data', async () => {
      const schema = z.object({ value: z.string().transform((s) => s.trim()) });
      const { req, res, next } = createMocks({ value: '  hello  ' });

      await validateRequest(schema)(req, res, next);

      expect(next).toHaveBeenCalledWith();
      expect(req.body).toEqual({ value: 'hello' });
    });
  });

  describe('validateParams', () => {
    it('should validate params only', async () => {
      const schema = z.object({ id: z.string().uuid() });
      const { req, res, next } = createMocks({}, {}, { id: '550e8400-e29b-41d4-a716-446655440000' });

      await validateParams(schema)(req, res, next);

      expect(next).toHaveBeenCalledWith();
    });

    it('should reject invalid params', async () => {
      const schema = z.object({ id: z.string().uuid() });
      const { req, res, next } = createMocks({}, {}, { id: 'not-a-uuid' });

      await validateParams(schema)(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('should replace req.params with validated data', async () => {
      const schema = z.object({ id: z.string() });
      const { req, res, next } = createMocks({}, {}, { id: 'abc-123' });

      await validateParams(schema)(req, res, next);

      expect(next).toHaveBeenCalledWith();
      expect(req.params).toEqual({ id: 'abc-123' });
    });
  });

  describe('validateQuery', () => {
    it('should validate query only', async () => {
      const schema = z.object({ page: z.coerce.number().int().min(1) });
      const { req, res, next } = createMocks({}, { page: '2' });

      await validateQuery(schema)(req, res, next);

      expect(next).toHaveBeenCalledWith();
    });

    it('should reject invalid query params', async () => {
      const schema = z.object({ page: z.coerce.number().int().min(1) });
      const { req, res, next } = createMocks({}, { page: '-1' });

      await validateQuery(schema)(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('should replace req.query with validated data', async () => {
      const schema = z.object({ verbose: z.enum(['true', 'false']) });
      const { req, res, next } = createMocks({}, { verbose: 'true' });

      await validateQuery(schema)(req, res, next);

      expect(next).toHaveBeenCalledWith();
      expect(req.query).toEqual({ verbose: 'true' });
    });
  });
});
