/**
 * @file requestValidation.test.ts
 * @description Unit tests for createRequestValidationMiddleware — the custom
 *   schema-based validation middleware that validates params, query, and body
 *   segments using the internal ObjectSchema / validateSegment engine.
 *
 * @security
 *   - Verifies unknown fields are rejected (attack surface reduction)
 *   - Verifies validated values are written back to req (no raw input leaks)
 *   - Verifies non-object inputs are rejected
 *   - Verifies partial schema (only body, only query, etc.) works correctly
 */

import { Request, Response, NextFunction } from 'express';
import { createRequestValidationMiddleware } from './requestValidation';
import { RequestValidationSchema } from './requestValidation';

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

// ── Happy paths ───────────────────────────────────────────────────────────────

describe('createRequestValidationMiddleware — valid inputs', () => {
  const schema: RequestValidationSchema = {
    params: { contractId: { type: 'string', required: true, minLength: 3 } },
    query:  { status: { type: 'string', required: false, enum: ['active', 'completed'] } },
    body:   { title: { type: 'string', required: true }, budget: { type: 'number', required: false, min: 0 } },
  };

  it('calls next() and writes validated values back to req', () => {
    const { res } = makeRes();
    const next: NextFunction = jest.fn();
    const req = makeReq({
      params: { contractId: 'contract-abc' },
      query:  { status: 'active' },
      body:   { title: 'Milestone 1', budget: 500 },
    });

    createRequestValidationMiddleware(schema)(req as Request, res as Response, next);

    expect(next).toHaveBeenCalledWith();
    expect((req as Request).params.contractId).toBe('contract-abc');
    expect((req as Request).body.title).toBe('Milestone 1');
  });

  it('calls next() when optional fields are absent', () => {
    const { res } = makeRes();
    const next: NextFunction = jest.fn();
    const req = makeReq({
      params: { contractId: 'contract-abc' },
      query:  {},
      body:   { title: 'Milestone 1' },
    });

    createRequestValidationMiddleware(schema)(req as Request, res as Response, next);

    expect(next).toHaveBeenCalledWith();
  });

  it('calls next() when no schema segments are provided', () => {
    const { res } = makeRes();
    const next: NextFunction = jest.fn();
    const req = makeReq();

    createRequestValidationMiddleware({})(req as Request, res as Response, next);

    expect(next).toHaveBeenCalledWith();
  });

  it('calls next() with only body schema defined', () => {
    const { res } = makeRes();
    const next: NextFunction = jest.fn();
    const req = makeReq({ body: { title: 'Test' } });

    createRequestValidationMiddleware({
      body: { title: { type: 'string', required: true } },
    })(req as Request, res as Response, next);

    expect(next).toHaveBeenCalledWith();
  });
});

// ── Rejection: unknown fields ─────────────────────────────────────────────────

describe('createRequestValidationMiddleware — unknown field rejection', () => {
  it('rejects unknown body keys', () => {
    const { res, statusMock, jsonMock } = makeRes();
    const next: NextFunction = jest.fn();
    const req = makeReq({ body: { title: 'ok', __proto__: 'evil', injected: true } });

    createRequestValidationMiddleware({
      body: { title: { type: 'string', required: true } },
    })(req as Request, res as Response, next);

    expect(statusMock).toHaveBeenCalledWith(400);
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'Validation failed',
        details: expect.arrayContaining([expect.stringContaining('is not allowed')]),
      })
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects unknown query keys', () => {
    const { res, statusMock, jsonMock } = makeRes();
    const next: NextFunction = jest.fn();
    const req = makeReq({ query: { admin: 'true' } });

    createRequestValidationMiddleware({
      query: { status: { type: 'string', required: false } },
    })(req as Request, res as Response, next);

    expect(statusMock).toHaveBeenCalledWith(400);
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({ details: expect.arrayContaining(['query.admin is not allowed']) })
    );
  });

  it('rejects unknown param keys', () => {
    const { res, statusMock } = makeRes();
    const next: NextFunction = jest.fn();
    const req = makeReq({ params: { contractId: 'abc', extra: 'bad' } });

    createRequestValidationMiddleware({
      params: { contractId: { type: 'string', required: true } },
    })(req as Request, res as Response, next);

    expect(statusMock).toHaveBeenCalledWith(400);
  });
});

// ── Rejection: missing required fields ───────────────────────────────────────

describe('createRequestValidationMiddleware — required field enforcement', () => {
  it('rejects missing required body field', () => {
    const { res, statusMock, jsonMock } = makeRes();
    const next: NextFunction = jest.fn();
    const req = makeReq({ body: {} });

    createRequestValidationMiddleware({
      body: { title: { type: 'string', required: true } },
    })(req as Request, res as Response, next);

    expect(statusMock).toHaveBeenCalledWith(400);
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({ details: expect.arrayContaining(['body.title is required']) })
    );
  });

  it('rejects missing required param', () => {
    const { res, statusMock } = makeRes();
    const next: NextFunction = jest.fn();
    const req = makeReq({ params: {} });

    createRequestValidationMiddleware({
      params: { contractId: { type: 'string', required: true } },
    })(req as Request, res as Response, next);

    expect(statusMock).toHaveBeenCalledWith(400);
  });
});

// ── Rejection: type mismatches ────────────────────────────────────────────────

describe('createRequestValidationMiddleware — type validation', () => {
  it('rejects string-as-number (type coercion attack)', () => {
    const { res, statusMock, jsonMock } = makeRes();
    const next: NextFunction = jest.fn();
    const req = makeReq({ body: { budget: '1000' } }); // string instead of number

    createRequestValidationMiddleware({
      body: { budget: { type: 'number', required: true } },
    })(req as Request, res as Response, next);

    expect(statusMock).toHaveBeenCalledWith(400);
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({ details: expect.arrayContaining(['body.budget must be of type number']) })
    );
  });

  it('rejects number-as-string', () => {
    const { res, statusMock } = makeRes();
    const next: NextFunction = jest.fn();
    const req = makeReq({ body: { name: 42 } });

    createRequestValidationMiddleware({
      body: { name: { type: 'string', required: true } },
    })(req as Request, res as Response, next);

    expect(statusMock).toHaveBeenCalledWith(400);
  });

  it('rejects non-boolean for boolean field', () => {
    const { res, statusMock } = makeRes();
    const next: NextFunction = jest.fn();
    const req = makeReq({ body: { active: 'true' } }); // string "true" not boolean

    createRequestValidationMiddleware({
      body: { active: { type: 'boolean', required: true } },
    })(req as Request, res as Response, next);

    expect(statusMock).toHaveBeenCalledWith(400);
  });
});

// ── Rejection: constraint violations ─────────────────────────────────────────

describe('createRequestValidationMiddleware — constraint validation', () => {
  it('rejects string below minLength', () => {
    const { res, statusMock, jsonMock } = makeRes();
    const next: NextFunction = jest.fn();
    const req = makeReq({ params: { contractId: 'ab' } });

    createRequestValidationMiddleware({
      params: { contractId: { type: 'string', required: true, minLength: 3 } },
    })(req as Request, res as Response, next);

    expect(statusMock).toHaveBeenCalledWith(400);
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({ details: expect.arrayContaining(['params.contractId must have length >= 3']) })
    );
  });

  it('rejects string above maxLength', () => {
    const { res, statusMock } = makeRes();
    const next: NextFunction = jest.fn();
    const req = makeReq({ body: { tag: 'a'.repeat(51) } });

    createRequestValidationMiddleware({
      body: { tag: { type: 'string', required: true, maxLength: 50 } },
    })(req as Request, res as Response, next);

    expect(statusMock).toHaveBeenCalledWith(400);
  });

  it('rejects number below min', () => {
    const { res, statusMock } = makeRes();
    const next: NextFunction = jest.fn();
    const req = makeReq({ body: { score: -1 } });

    createRequestValidationMiddleware({
      body: { score: { type: 'number', required: true, min: 0 } },
    })(req as Request, res as Response, next);

    expect(statusMock).toHaveBeenCalledWith(400);
  });

  it('rejects number above max', () => {
    const { res, statusMock } = makeRes();
    const next: NextFunction = jest.fn();
    const req = makeReq({ body: { score: 101 } });

    createRequestValidationMiddleware({
      body: { score: { type: 'number', required: true, max: 100 } },
    })(req as Request, res as Response, next);

    expect(statusMock).toHaveBeenCalledWith(400);
  });

  it('rejects value not in enum', () => {
    const { res, statusMock, jsonMock } = makeRes();
    const next: NextFunction = jest.fn();
    const req = makeReq({ query: { status: 'pending' } });

    createRequestValidationMiddleware({
      query: { status: { type: 'string', required: false, enum: ['active', 'completed'] } },
    })(req as Request, res as Response, next);

    expect(statusMock).toHaveBeenCalledWith(400);
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.arrayContaining(['query.status must be one of: active, completed']),
      })
    );
  });

  it('rejects string not matching pattern', () => {
    const { res, statusMock } = makeRes();
    const next: NextFunction = jest.fn();
    const req = makeReq({ params: { id: 'INVALID_FORMAT' } });

    createRequestValidationMiddleware({
      params: { id: { type: 'string', required: true, pattern: /^usr_[a-z0-9]+$/ } },
    })(req as Request, res as Response, next);

    expect(statusMock).toHaveBeenCalledWith(400);
  });
});

// ── Rejection: non-object segments ───────────────────────────────────────────

describe('createRequestValidationMiddleware — non-object segment rejection', () => {
  it('rejects array body', () => {
    const { res, statusMock } = makeRes();
    const next: NextFunction = jest.fn();
    const req = makeReq({ body: ['item1', 'item2'] as unknown as Record<string, unknown> });

    createRequestValidationMiddleware({
      body: { title: { type: 'string', required: true } },
    })(req as Request, res as Response, next);

    expect(statusMock).toHaveBeenCalledWith(400);
  });

  it('rejects null body', () => {
    const { res, statusMock } = makeRes();
    const next: NextFunction = jest.fn();
    const req = makeReq({ body: null as unknown as Record<string, unknown> });

    createRequestValidationMiddleware({
      body: { title: { type: 'string', required: true } },
    })(req as Request, res as Response, next);

    expect(statusMock).toHaveBeenCalledWith(400);
  });
});

// ── Aggregated errors ─────────────────────────────────────────────────────────

describe('createRequestValidationMiddleware — aggregated multi-segment errors', () => {
  it('collects errors from params, query, and body in one response', () => {
    const { res, statusMock, jsonMock } = makeRes();
    const next: NextFunction = jest.fn();
    const req = makeReq({
      params: { contractId: 'ab' },       // too short
      query:  { status: 'pending' },       // invalid enum
      body:   { budget: '500' },           // wrong type
    });

    createRequestValidationMiddleware({
      params: { contractId: { type: 'string', required: true, minLength: 3 } },
      query:  { status: { type: 'string', required: false, enum: ['active', 'completed'] } },
      body:   { budget: { type: 'number', required: true } },
    })(req as Request, res as Response, next);

    expect(statusMock).toHaveBeenCalledWith(400);
    const body = jsonMock.mock.calls[0][0];
    expect(body.details.length).toBeGreaterThanOrEqual(3);
  });
});
