/**
 * Unit tests for src/middleware/requestId.ts
 *
 * Coverage targets:
 *   - validateExternalId – valid / invalid inputs
 *   - requestIdMiddleware – ID generation, propagation, header injection,
 *     res.locals population, child logger attachment, security edge cases
 */

import { Request, Response, NextFunction } from 'express';
import {
  validateExternalId,
  requestIdMiddleware,
  REQUEST_ID_HEADER,
  CORRELATION_ID_HEADER,
} from './requestId';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeReqRes(headers: Record<string, string> = {}): {
  req: Partial<Request>;
  res: {
    locals: Record<string, unknown>;
    setHeader: jest.Mock;
  };
  next: jest.Mock;
} {
  return {
    req: { headers } as Partial<Request>,
    res: {
      locals: {},
      setHeader: jest.fn(),
    },
    next: jest.fn(),
  };
}

// ── validateExternalId ────────────────────────────────────────────────────────

describe('validateExternalId', () => {
  it('accepts a valid UUID v4', () => {
    const id = '550e8400-e29b-41d4-a716-446655440000';
    expect(validateExternalId(id)).toBe(id);
  });

  it('accepts alphanumeric-hyphen strings up to 128 chars', () => {
    const id = 'trace-abc123_XYZ';
    expect(validateExternalId(id)).toBe(id);
  });

  it('accepts a single character', () => {
    expect(validateExternalId('a')).toBe('a');
  });

  it('rejects strings longer than 128 chars', () => {
    expect(validateExternalId('a'.repeat(129))).toBeUndefined();
  });

  it('rejects strings with special characters', () => {
    expect(validateExternalId('bad<script>')).toBeUndefined();
    expect(validateExternalId('id with space')).toBeUndefined();
    expect(validateExternalId('id\nnewline')).toBeUndefined();
  });

  it('rejects empty string', () => {
    expect(validateExternalId('')).toBeUndefined();
  });

  it('rejects non-string types', () => {
    expect(validateExternalId(123)).toBeUndefined();
    expect(validateExternalId(null)).toBeUndefined();
    expect(validateExternalId(undefined)).toBeUndefined();
    expect(validateExternalId({})).toBeUndefined();
  });
});

// ── requestIdMiddleware ───────────────────────────────────────────────────────

describe('requestIdMiddleware', () => {
  it('calls next()', () => {
    const { req, res, next } = makeReqRes();
    requestIdMiddleware(req as Request, res as unknown as Response, next as NextFunction);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('generates a UUID when no X-Request-Id header is present', () => {
    const { req, res, next } = makeReqRes();
    requestIdMiddleware(req as Request, res as unknown as Response, next as NextFunction);
    const id = res.locals['requestId'] as string;
    expect(typeof id).toBe('string');
    // UUID v4 pattern
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('reuses a valid incoming X-Request-Id', () => {
    const incomingId = 'my-trace-id-123';
    const { req, res, next } = makeReqRes({ [REQUEST_ID_HEADER]: incomingId });
    requestIdMiddleware(req as Request, res as unknown as Response, next as NextFunction);
    expect(res.locals['requestId']).toBe(incomingId);
  });

  it('generates a new ID when incoming X-Request-Id is invalid', () => {
    const { req, res, next } = makeReqRes({
      [REQUEST_ID_HEADER]: 'bad id with spaces!',
    });
    requestIdMiddleware(req as Request, res as unknown as Response, next as NextFunction);
    const id = res.locals['requestId'] as string;
    expect(id).not.toBe('bad id with spaces!');
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('sets X-Request-Id response header', () => {
    const { req, res, next } = makeReqRes();
    requestIdMiddleware(req as Request, res as unknown as Response, next as NextFunction);
    expect(res.setHeader).toHaveBeenCalledWith(
      REQUEST_ID_HEADER,
      res.locals['requestId'],
    );
  });

  it('attaches correlationId from valid X-Correlation-Id header', () => {
    const corrId = 'corr-abc-456';
    const { req, res, next } = makeReqRes({ [CORRELATION_ID_HEADER]: corrId });
    requestIdMiddleware(req as Request, res as unknown as Response, next as NextFunction);
    expect(res.locals['correlationId']).toBe(corrId);
  });

  it('sets X-Correlation-Id response header when present', () => {
    const corrId = 'corr-xyz';
    const { req, res, next } = makeReqRes({ [CORRELATION_ID_HEADER]: corrId });
    requestIdMiddleware(req as Request, res as unknown as Response, next as NextFunction);
    expect(res.setHeader).toHaveBeenCalledWith(CORRELATION_ID_HEADER, corrId);
  });

  it('does not set X-Correlation-Id header when absent', () => {
    const { req, res, next } = makeReqRes();
    requestIdMiddleware(req as Request, res as unknown as Response, next as NextFunction);
    const calls = (res.setHeader as jest.Mock).mock.calls.map(
      (c: unknown[]) => c[0],
    );
    expect(calls).not.toContain(CORRELATION_ID_HEADER);
  });

  it('sets correlationId to undefined when header is invalid', () => {
    const { req, res, next } = makeReqRes({
      [CORRELATION_ID_HEADER]: 'bad value!',
    });
    requestIdMiddleware(req as Request, res as unknown as Response, next as NextFunction);
    expect(res.locals['correlationId']).toBeUndefined();
  });

  it('attaches a child logger to res.locals.log', () => {
    const { req, res, next } = makeReqRes();
    requestIdMiddleware(req as Request, res as unknown as Response, next as NextFunction);
    expect(res.locals['log']).toBeDefined();
    expect(typeof (res.locals['log'] as { info: unknown }).info).toBe('function');
  });

  it('each request gets a unique requestId', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const { req, res, next } = makeReqRes();
      requestIdMiddleware(req as Request, res as unknown as Response, next as NextFunction);
      ids.add(res.locals['requestId'] as string);
    }
    expect(ids.size).toBe(50);
  });

  it('rejects header injection attempt in X-Request-Id', () => {
    const malicious = 'id\r\nX-Injected: evil';
    const { req, res, next } = makeReqRes({ [REQUEST_ID_HEADER]: malicious });
    requestIdMiddleware(req as Request, res as unknown as Response, next as NextFunction);
    expect(res.locals['requestId']).not.toBe(malicious);
  });
});
