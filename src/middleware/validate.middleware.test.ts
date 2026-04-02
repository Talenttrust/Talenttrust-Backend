/**
 * @file validate.middleware.test.ts
 * @description Unit tests for validateSchema — the async Zod middleware that
 *   validates body, query, and params together via a single schema object.
 *
 * @security
 *   - Verifies ZodErrors are caught and returned as 400 (no stack leaks)
 *   - Verifies non-Zod errors are forwarded to next() for global handling
 *   - Verifies strict schemas reject extra fields
 */

import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { validateSchema } from './validate.middleware';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRes(): { res: Partial<Response>; statusMock: jest.Mock; jsonMock: jest.Mock } {
  const jsonMock = jest.fn();
  const statusMock = jest.fn().mockReturnValue({ json: jsonMock });
  const res = { status: statusMock, json: jsonMock } as unknown as Partial<Response>;
  return { res, statusMock, jsonMock };
}

function makeReq(overrides: Partial<Request> = {}): Partial<Request> {
  return { body: {}, query: {}, params: {}, ...overrides };
}

// ── Happy paths ───────────────────────────────────────────────────────────────

describe('validateSchema — valid inputs', () => {
  const schema = z.object({
    body: z.object({ name: z.string() }),
  });

  it('calls next() with no arguments on valid input', async () => {
    const { res } = makeRes();
    const next: NextFunction = jest.fn();
    const req = makeReq({ body: { name: 'Alice' } });

    await validateSchema(schema)(req as Request, res as Response, next);

    expect(next).toHaveBeenCalledWith();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('validates body, query, and params together', async () => {
    const fullSchema = z.object({
      body:   z.object({ title: z.string() }),
      query:  z.object({ page: z.string().optional() }),
      params: z.object({ id: z.string().uuid() }),
    });
    const { res } = makeRes();
    const next: NextFunction = jest.fn();
    const req = makeReq({
      body:   { title: 'Test' },
      query:  { page: '1' },
      params: { id: '550e8400-e29b-41d4-a716-446655440000' },
    });

    await validateSchema(fullSchema)(req as Request, res as Response, next);

    expect(next).toHaveBeenCalledWith();
  });
});

// ── ZodError handling ─────────────────────────────────────────────────────────

describe('validateSchema — ZodError handling', () => {
  const schema = z.object({
    body: z.object({ name: z.string() }),
  });

  it('returns 400 with status/message/errors on ZodError', async () => {
    const { res, statusMock, jsonMock } = makeRes();
    const next: NextFunction = jest.fn();
    const req = makeReq({ body: {} }); // missing name

    await validateSchema(schema)(req as Request, res as Response, next);

    expect(statusMock).toHaveBeenCalledWith(400);
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'error',
        message: 'Validation failed',
        errors: expect.any(Array),
      })
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('includes Zod issue details in errors array', async () => {
    const { res, jsonMock } = makeRes();
    const next: NextFunction = jest.fn();
    const req = makeReq({ body: { name: 123 } }); // wrong type

    await validateSchema(schema)(req as Request, res as Response, next);

    const body = jsonMock.mock.calls[0][0];
    expect(body.errors.length).toBeGreaterThan(0);
    expect(body.errors[0]).toHaveProperty('message');
  });

  it('rejects extra fields when schema uses .strict()', async () => {
    const strictSchema = z.object({
      body: z.object({ name: z.string() }).strict(),
    });
    const { res, statusMock } = makeRes();
    const next: NextFunction = jest.fn();
    const req = makeReq({ body: { name: 'Alice', injected: 'evil' } });

    await validateSchema(strictSchema)(req as Request, res as Response, next);

    expect(statusMock).toHaveBeenCalledWith(400);
  });

  it('rejects missing required body field', async () => {
    const { res, statusMock } = makeRes();
    const next: NextFunction = jest.fn();
    const req = makeReq({ body: {} });

    await validateSchema(schema)(req as Request, res as Response, next);

    expect(statusMock).toHaveBeenCalledWith(400);
  });

  it('rejects invalid UUID in params', async () => {
    const paramSchema = z.object({
      params: z.object({ id: z.string().uuid() }),
    });
    const { res, statusMock } = makeRes();
    const next: NextFunction = jest.fn();
    const req = makeReq({ params: { id: 'not-a-uuid' } });

    await validateSchema(paramSchema)(req as Request, res as Response, next);

    expect(statusMock).toHaveBeenCalledWith(400);
  });
});

// ── Non-Zod error forwarding ──────────────────────────────────────────────────

describe('validateSchema — non-Zod error forwarding', () => {
  it('forwards non-Zod errors to next()', async () => {
    const { res } = makeRes();
    const next: NextFunction = jest.fn();
    const badSchema = {
      parseAsync: jest.fn().mockRejectedValue(new Error('Unexpected internal error')),
    } as unknown as z.ZodTypeAny;
    const req = makeReq();

    await validateSchema(badSchema)(req as Request, res as Response, next);

    expect(next).toHaveBeenCalledWith(expect.any(Error));
    expect(res.status).not.toHaveBeenCalled();
  });

  it('does not expose error message to client for non-Zod errors', async () => {
    const { res, jsonMock } = makeRes();
    const next: NextFunction = jest.fn();
    const badSchema = {
      parseAsync: jest.fn().mockRejectedValue(new Error('DB connection failed')),
    } as unknown as z.ZodTypeAny;
    const req = makeReq();

    await validateSchema(badSchema)(req as Request, res as Response, next);

    expect(jsonMock).not.toHaveBeenCalled();
  });
});
