/**
 * @file validation.test.ts
 * @description Unit tests for Zod-based validation middleware:
 *   - validateRequest (body)
 *   - validateParams (route params)
 *   - validateQuery  (query string)
 *
 * @security
 *   - Verifies unknown/extra fields are rejected when schema uses .strict()
 *   - Verifies type coercion attacks (e.g. number-as-string) are caught
 *   - Verifies non-Zod errors propagate without leaking internals
 */

import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { validateRequest, validateParams, validateQuery } from './validation';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRes(): { res: Partial<Response>; statusMock: jest.Mock; jsonMock: jest.Mock } {
  const jsonMock = jest.fn();
  const statusMock = jest.fn().mockReturnValue({ json: jsonMock });
  const res = { status: statusMock, json: jsonMock } as unknown as Partial<Response>;
  return { res, statusMock, jsonMock };
}

function makeReq(overrides: Partial<Request> = {}): Partial<Request> {
  return { body: {}, params: {}, query: {}, ...overrides };
}

// ── validateRequest ───────────────────────────────────────────────────────────

describe('validateRequest', () => {
  const schema = z.object({
    title: z.string().min(3),
    budget: z.number().positive(),
  });

  it('calls next() when body is valid', () => {
    const { res } = makeRes();
    const next: NextFunction = jest.fn();
    const req = makeReq({ body: { title: 'abc', budget: 100 } });

    validateRequest(schema)(req as Request, res as Response, next);

    expect(next).toHaveBeenCalledWith();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('returns 400 with field-level details on ZodError', () => {
    const { res, statusMock, jsonMock } = makeRes();
    const next: NextFunction = jest.fn();
    const req = makeReq({ body: { title: 'ab', budget: -5 } });

    validateRequest(schema)(req as Request, res as Response, next);

    expect(statusMock).toHaveBeenCalledWith(400);
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'Validation failed',
        details: expect.arrayContaining([
          expect.objectContaining({ field: 'title' }),
          expect.objectContaining({ field: 'budget' }),
        ]),
      })
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 400 when required field is missing', () => {
    const { res, statusMock } = makeRes();
    const next: NextFunction = jest.fn();
    const req = makeReq({ body: { title: 'valid-title' } }); // missing budget

    validateRequest(schema)(req as Request, res as Response, next);

    expect(statusMock).toHaveBeenCalledWith(400);
  });

  it('returns 400 with generic message on non-Zod parse error', () => {
    const { res, statusMock, jsonMock } = makeRes();
    const next: NextFunction = jest.fn();
    const badSchema = { parse: () => { throw new Error('unexpected'); } } as unknown as z.ZodSchema;
    const req = makeReq({ body: {} });

    validateRequest(badSchema)(req as Request, res as Response, next);

    expect(statusMock).toHaveBeenCalledWith(400);
    expect(jsonMock).toHaveBeenCalledWith({ error: 'Invalid request data' });
  });

  it('rejects type coercion — string where number expected', () => {
    const { res, statusMock } = makeRes();
    const next: NextFunction = jest.fn();
    const req = makeReq({ body: { title: 'valid', budget: '100' } }); // budget as string

    validateRequest(schema)(req as Request, res as Response, next);

    expect(statusMock).toHaveBeenCalledWith(400);
  });

  it('rejects extra fields when schema uses .strict()', () => {
    const strictSchema = z.object({ name: z.string() }).strict();
    const { res, statusMock } = makeRes();
    const next: NextFunction = jest.fn();
    const req = makeReq({ body: { name: 'Alice', injected: 'evil' } });

    validateRequest(strictSchema)(req as Request, res as Response, next);

    expect(statusMock).toHaveBeenCalledWith(400);
  });
});

// ── validateParams ────────────────────────────────────────────────────────────

describe('validateParams', () => {
  const schema = z.object({ contractId: z.string().uuid() });

  it('calls next() when params are valid', () => {
    const { res } = makeRes();
    const next: NextFunction = jest.fn();
    const req = makeReq({ params: { contractId: '550e8400-e29b-41d4-a716-446655440000' } });

    validateParams(schema)(req as Request, res as Response, next);

    expect(next).toHaveBeenCalledWith();
  });

  it('returns 400 with field details on invalid param', () => {
    const { res, statusMock, jsonMock } = makeRes();
    const next: NextFunction = jest.fn();
    const req = makeReq({ params: { contractId: 'not-a-uuid' } });

    validateParams(schema)(req as Request, res as Response, next);

    expect(statusMock).toHaveBeenCalledWith(400);
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'Invalid parameters',
        details: expect.arrayContaining([
          expect.objectContaining({ field: 'contractId' }),
        ]),
      })
    );
  });

  it('returns 400 with generic message on non-Zod error', () => {
    const { res, statusMock, jsonMock } = makeRes();
    const next: NextFunction = jest.fn();
    const badSchema = { parse: () => { throw new Error('boom'); } } as unknown as z.ZodSchema;
    const req = makeReq({ params: {} });

    validateParams(badSchema)(req as Request, res as Response, next);

    expect(statusMock).toHaveBeenCalledWith(400);
    expect(jsonMock).toHaveBeenCalledWith({ error: 'Invalid parameters' });
  });

  it('rejects missing required param', () => {
    const { res, statusMock } = makeRes();
    const next: NextFunction = jest.fn();
    const req = makeReq({ params: {} });

    validateParams(schema)(req as Request, res as Response, next);

    expect(statusMock).toHaveBeenCalledWith(400);
  });
});

// ── validateQuery ─────────────────────────────────────────────────────────────

describe('validateQuery', () => {
  const schema = z.object({
    status: z.enum(['active', 'completed', 'disputed']).optional(),
    page: z.string().regex(/^\d+$/).optional(),
  });

  it('calls next() when query is valid', () => {
    const { res } = makeRes();
    const next: NextFunction = jest.fn();
    const req = makeReq({ query: { status: 'active', page: '1' } });

    validateQuery(schema)(req as Request, res as Response, next);

    expect(next).toHaveBeenCalledWith();
  });

  it('calls next() when optional query params are absent', () => {
    const { res } = makeRes();
    const next: NextFunction = jest.fn();
    const req = makeReq({ query: {} });

    validateQuery(schema)(req as Request, res as Response, next);

    expect(next).toHaveBeenCalledWith();
  });

  it('returns 400 with field details on invalid enum value', () => {
    const { res, statusMock, jsonMock } = makeRes();
    const next: NextFunction = jest.fn();
    const req = makeReq({ query: { status: 'pending' } });

    validateQuery(schema)(req as Request, res as Response, next);

    expect(statusMock).toHaveBeenCalledWith(400);
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'Invalid query parameters',
        details: expect.arrayContaining([
          expect.objectContaining({ field: 'status' }),
        ]),
      })
    );
  });

  it('rejects extra query keys when schema uses .strict()', () => {
    const strictSchema = z.object({ status: z.string() }).strict();
    const { res, statusMock } = makeRes();
    const next: NextFunction = jest.fn();
    const req = makeReq({ query: { status: 'active', admin: 'true' } });

    validateQuery(strictSchema)(req as Request, res as Response, next);

    expect(statusMock).toHaveBeenCalledWith(400);
  });

  it('returns 400 with generic message on non-Zod error', () => {
    const { res, statusMock, jsonMock } = makeRes();
    const next: NextFunction = jest.fn();
    const badSchema = { parse: () => { throw new Error('boom'); } } as unknown as z.ZodSchema;
    const req = makeReq({ query: {} });

    validateQuery(badSchema)(req as Request, res as Response, next);

    expect(statusMock).toHaveBeenCalledWith(400);
    expect(jsonMock).toHaveBeenCalledWith({ error: 'Invalid query parameters' });
  });
});
