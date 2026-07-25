/**
 * @file errorHandlers.test.ts
 * @description Isolated unit tests for the terminal Express error-handling
 * middleware defined in `src/middleware/errorHandlers.ts`.
 *
 * Coverage goals
 * ──────────────
 * • AppError  → status from the error, safe message via safeErrors policy
 * • ZodError  → 400 validation_error with field-level details, no internals
 * • Body-parser SyntaxError (status on object) → 400 invalid_json
 * • Unknown / generic Error → 500 internal_error, no stack / message leak
 * • Correlation-id echoing in the response body
 * • Logger is always called (redacted) and never receives raw stack/secret text
 * • `res.headersSent` guard – handler is a no-op after headers are sent
 * • `res.locals.log` override – per-request child logger is preferred
 * • `req.streamError` injection path
 * • `notFoundHandler` creates a 404 AppError and calls `next`
 *
 * Security notes
 * ──────────────
 * Every assertion checks that `res.json` is NEVER called with:
 *   – a `stack` property
 *   – any internal message text that is not in the SAFE_ERROR_MESSAGES registry
 * These checks mirror OWASP A01:2021 / CWE-209 (information-disclosure via
 * verbose error responses).
 *
 * No live server is used; req/res/next are lightweight in-memory mocks.
 */

import { ZodError, z } from 'zod';
import { AppError } from '../errors/appError';
import { SAFE_ERROR_MESSAGES } from '../errors/safeErrors';
import { logger } from '../logger';
import { errorHandler, notFoundHandler } from './errorHandlers';

// ── Shared mock factories ────────────────────────────────────────────────────

/**
 * Creates a minimal mock Express Request with optional overrides.
 *
 * @param overrides - Partial properties merged onto the base mock.
 * @returns A jest-mocked Request-like object.
 */
function makeMockReq(overrides: Record<string, unknown> = {}): any {
  return {
    method: 'GET',
    path: '/test',
    ...overrides,
  };
}

/**
 * Creates a minimal mock Express Response that captures status / json calls.
 *
 * @param locals - Optional `res.locals` values (e.g. requestId, correlationId).
 * @param headersSent - Whether to simulate headers-already-sent state.
 * @returns A jest-mocked Response-like object with spies.
 */
function makeMockRes(
  locals: Record<string, unknown> = {},
  headersSent = false,
): any {
  const res: any = {
    headersSent,
    locals: { requestId: 'req-123', ...locals },
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  return res;
}

/**
 * Creates a jest.fn() that stands in for Express's `next` callback.
 */
function makeMockNext(): jest.Mock {
  return jest.fn();
}

// ── Silence the module-level logger so test output stays clean ───────────────
let loggerErrorSpy: jest.SpyInstance;

beforeEach(() => {
  loggerErrorSpy = jest.spyOn(logger, 'error').mockImplementation(() => logger);
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ── Helper ───────────────────────────────────────────────────────────────────

/**
 * Invoke `errorHandler` and return the first argument passed to `res.json`.
 * Throws if `res.json` was never called (indicates an unexpected guard path).
 */
function invokeAndCaptureJson(
  error: unknown,
  req: any = makeMockReq(),
  res: any = makeMockRes(),
): any {
  errorHandler(error, req, res, makeMockNext());
  expect(res.json).toHaveBeenCalledTimes(1);
  return (res.json as jest.Mock).mock.calls[0][0];
}

// ════════════════════════════════════════════════════════════════════════════
// 1. AppError mapping
// ════════════════════════════════════════════════════════════════════════════

describe('errorHandler – AppError', () => {
  it('returns the AppError status code', () => {
    const err = new AppError(404, 'not_found', 'The requested resource was not found');
    const res = makeMockRes();
    invokeAndCaptureJson(err, makeMockReq(), res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('returns the safe message from the safeErrors registry', () => {
    const err = new AppError(404, 'not_found', 'The requested resource was not found');
    const body = invokeAndCaptureJson(err);
    expect(body.error.message).toBe(SAFE_ERROR_MESSAGES['not_found']);
  });

  it('returns the machine-readable error code', () => {
    const err = new AppError(401, 'unauthorized', 'Unauthorized');
    const body = invokeAndCaptureJson(err);
    expect(body.error.code).toBe('unauthorized');
  });

  it('includes requestId in the response', () => {
    const err = new AppError(403, 'forbidden', 'Forbidden');
    const res = makeMockRes({ requestId: 'abc-789' });
    const body = invokeAndCaptureJson(err, makeMockReq(), res);
    expect(body.error.requestId).toBe('abc-789');
  });

  it('does not expose stack trace in response body', () => {
    const err = new AppError(500, 'internal_error', 'An unexpected error occurred');
    const body = invokeAndCaptureJson(err);
    expect(JSON.stringify(body)).not.toContain('stack');
  });

  it('sanitizes an AppError whose message contains a file path', () => {
    // expose=true but the message triggers the unsafe-content guard
    const err = new AppError(400, 'bad_request', '/src/controllers/foo.ts:42 failed', true);
    const body = invokeAndCaptureJson(err);
    // Must fall back to the safe message for the code, not the raw message
    expect(body.error.message).not.toContain('/src/');
  });

  it('uses safeMessageForCode when expose=false', () => {
    const err = new AppError(400, 'contract_metadata_mismatch', 'secret internal detail', false);
    const body = invokeAndCaptureJson(err);
    expect(body.error.message).toBe(SAFE_ERROR_MESSAGES['contract_metadata_mismatch']);
    expect(body.error.message).not.toContain('secret internal detail');
  });

  it('maps a 409 ConflictError correctly', () => {
    const err = new AppError(409, 'conflict', 'Conflict');
    const res = makeMockRes();
    const body = invokeAndCaptureJson(err, makeMockReq(), res);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(body.error.code).toBe('conflict');
  });

  it('clamps an out-of-range AppError statusCode to 500', () => {
    // statusCode 999 is outside 400-599, so mapErrorToPayload returns 500
    const err = new AppError(999, 'internal_error', 'weird status');
    const res = makeMockRes();
    invokeAndCaptureJson(err, makeMockReq(), res);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. ZodError (validation error) mapping
// ════════════════════════════════════════════════════════════════════════════

describe('errorHandler – ZodError (validation error)', () => {
  /** Produce a real ZodError by parsing bad data through a schema. */
  function makeZodError(): ZodError {
    const schema = z.object({ age: z.number(), name: z.string() });
    const result = schema.safeParse({ age: 'not-a-number', name: 42 });
    if (result.success) throw new Error('Expected parse failure');
    return result.error;
  }

  it('returns status 400', () => {
    const res = makeMockRes();
    invokeAndCaptureJson(makeZodError(), makeMockReq(), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns code validation_error', () => {
    const body = invokeAndCaptureJson(makeZodError());
    expect(body.error.code).toBe('validation_error');
  });

  it('returns the canonical safe message', () => {
    const body = invokeAndCaptureJson(makeZodError());
    expect(body.error.message).toBe(SAFE_ERROR_MESSAGES['validation_error']);
  });

  it('includes field-level details array', () => {
    const body = invokeAndCaptureJson(makeZodError());
    expect(Array.isArray(body.error.details)).toBe(true);
    expect(body.error.details.length).toBeGreaterThan(0);
  });

  it('each detail has path, message, and code', () => {
    const body = invokeAndCaptureJson(makeZodError());
    for (const detail of body.error.details) {
      expect(Array.isArray(detail.path)).toBe(true);
      expect(typeof detail.message).toBe('string');
      expect(typeof detail.code).toBe('string');
    }
  });

  it('does not leak raw Zod internal text in the top-level message', () => {
    const body = invokeAndCaptureJson(makeZodError());
    // The top-level message must be the canonical safe message, not Zod internals
    expect(body.error.message).toBe(SAFE_ERROR_MESSAGES['validation_error']);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. Body-parser SyntaxError (malformed JSON)
// ════════════════════════════════════════════════════════════════════════════

describe('errorHandler – body-parser SyntaxError', () => {
  function makeBodyParserError(): SyntaxError & { status: number } {
    const err = new SyntaxError('Unexpected token } in JSON') as SyntaxError & { status: number };
    err.status = 400;
    return err;
  }

  it('returns status 400', () => {
    const res = makeMockRes();
    invokeAndCaptureJson(makeBodyParserError(), makeMockReq(), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns code invalid_json', () => {
    const body = invokeAndCaptureJson(makeBodyParserError());
    expect(body.error.code).toBe('invalid_json');
  });

  it('does not expose the raw SyntaxError message', () => {
    const body = invokeAndCaptureJson(makeBodyParserError());
    expect(JSON.stringify(body)).not.toContain('Unexpected token');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. Unknown / generic Error mapping
// ════════════════════════════════════════════════════════════════════════════

describe('errorHandler – unknown error', () => {
  it('returns status 500', () => {
    const res = makeMockRes();
    invokeAndCaptureJson(new Error('database connection refused'), makeMockReq(), res);
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('returns code internal_error', () => {
    const body = invokeAndCaptureJson(new Error('something blew up'));
    expect(body.error.code).toBe('internal_error');
  });

  it('returns the canonical safe message – no internal detail', () => {
    const body = invokeAndCaptureJson(new Error('ECONNREFUSED 127.0.0.1:5432'));
    expect(body.error.message).toBe(SAFE_ERROR_MESSAGES['internal_error']);
    expect(body.error.message).not.toContain('ECONNREFUSED');
  });

  it('does not include a stack property in the response', () => {
    const err = new Error('unexpected');
    // Ensure there IS a stack to potentially leak
    expect(err.stack).toBeDefined();
    const body = invokeAndCaptureJson(err);
    expect(JSON.stringify(body)).not.toContain('stack');
  });

  it('handles a thrown string gracefully', () => {
    const res = makeMockRes();
    invokeAndCaptureJson('some string error', makeMockReq(), res);
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('handles a thrown object gracefully', () => {
    const res = makeMockRes();
    invokeAndCaptureJson({ weird: true }, makeMockReq(), res);
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('handles null thrown value gracefully', () => {
    const res = makeMockRes();
    invokeAndCaptureJson(null, makeMockReq(), res);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 5. Correlation ID echoing in the response
// ════════════════════════════════════════════════════════════════════════════

describe('errorHandler – correlation ID', () => {
  it('includes correlationId in the log when present on res.locals', () => {
    const res = makeMockRes({ correlationId: 'corr-abc-123' });
    errorHandler(new Error('boom'), makeMockReq(), res, makeMockNext());

    expect(loggerErrorSpy).toHaveBeenCalledWith(
      'API request failed',
      expect.objectContaining({ correlationId: 'corr-abc-123' }),
    );
  });

  it('does NOT include correlationId in the log when absent from res.locals', () => {
    const res = makeMockRes({}); // no correlationId
    errorHandler(new Error('boom'), makeMockReq(), res, makeMockNext());

    const logCall = loggerErrorSpy.mock.calls[0][1] as Record<string, unknown>;
    expect(logCall).not.toHaveProperty('correlationId');
  });

  it('the response body requestId matches res.locals.requestId', () => {
    const res = makeMockRes({ requestId: 'req-xyz' });
    const body = invokeAndCaptureJson(new AppError(404, 'not_found', 'Not found'), makeMockReq(), res);
    expect(body.error.requestId).toBe('req-xyz');
  });

  it('falls back to "unknown" requestId when res.locals.requestId is missing', () => {
    const res = makeMockRes({ requestId: undefined });
    const body = invokeAndCaptureJson(new Error('err'), makeMockReq(), res);
    expect(body.error.requestId).toBe('unknown');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 6. Logger is always called with redacted content
// ════════════════════════════════════════════════════════════════════════════

describe('errorHandler – logging', () => {
  it('always calls logger.error exactly once', () => {
    errorHandler(new Error('oops'), makeMockReq(), makeMockRes(), makeMockNext());
    expect(loggerErrorSpy).toHaveBeenCalledTimes(1);
  });

  it('logs "API request failed" as the message', () => {
    errorHandler(new AppError(403, 'forbidden', 'Forbidden'), makeMockReq(), makeMockRes(), makeMockNext());
    expect(loggerErrorSpy).toHaveBeenCalledWith('API request failed', expect.any(Object));
  });

  it('redacts unsafe content in the logged error message', () => {
    // A message containing a syscall error string must be redacted in the log
    const err = new Error('ECONNREFUSED 127.0.0.1:5432');
    errorHandler(err, makeMockReq(), makeMockRes(), makeMockNext());

    const logArg = loggerErrorSpy.mock.calls[0][1] as Record<string, unknown>;
    const loggedErrMsg = (logArg['err'] as Record<string, unknown>)['message'];
    expect(loggedErrMsg).toBe('[REDACTED]');
  });

  it('logs the http method and path', () => {
    const req = makeMockReq({ method: 'POST', path: '/api/events' });
    errorHandler(new Error('err'), req, makeMockRes(), makeMockNext());

    expect(loggerErrorSpy).toHaveBeenCalledWith(
      'API request failed',
      expect.objectContaining({ method: 'POST', path: '/api/events' }),
    );
  });

  it('logs the resolved statusCode and errorCode', () => {
    const err = new AppError(422, 'validation_error', 'Validation error');
    errorHandler(err, makeMockReq(), makeMockRes(), makeMockNext());

    expect(loggerErrorSpy).toHaveBeenCalledWith(
      'API request failed',
      expect.objectContaining({ statusCode: 422, errorCode: 'validation_error' }),
    );
  });

  it('uses res.locals.log when available, not the module logger', () => {
    const childLogError = jest.fn();
    const childLog = { error: childLogError };
    const res = makeMockRes({ log: childLog });

    errorHandler(new Error('test'), makeMockReq(), res, makeMockNext());

    // Child logger should have been called; module-level logger should NOT
    expect(childLogError).toHaveBeenCalledTimes(1);
    expect(loggerErrorSpy).not.toHaveBeenCalled();
  });

  it('falls back to module logger when res.locals.log is not a valid logger', () => {
    const res = makeMockRes({ log: 'not-a-logger' });
    errorHandler(new Error('test'), makeMockReq(), res, makeMockNext());
    expect(loggerErrorSpy).toHaveBeenCalledTimes(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 7. Security: no stack / internal detail in any response body
// ════════════════════════════════════════════════════════════════════════════

describe('errorHandler – security: no stack or internal details in responses', () => {
  const scenarios: Array<[string, unknown]> = [
    ['AppError', new AppError(500, 'internal_error', 'An unexpected error occurred')],
    ['generic Error', new Error('SELECT * FROM users WHERE id=1')],
    ['ZodError', (() => {
      const r = z.object({ x: z.number() }).safeParse({ x: 'bad' });
      return (r as any).error;
    })()],
    ['SyntaxError from body-parser', Object.assign(new SyntaxError('bad json'), { status: 400 })],
    ['thrown string', 'raw string error'],
    ['thrown null', null],
  ];

  it.each(scenarios)('response body has no stack for: %s', (_label, error) => {
    const body = invokeAndCaptureJson(error);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toMatch(/\bstack\b/);
  });

  it.each(scenarios)('response body has no raw error message for: %s', (_label, error) => {
    const body = invokeAndCaptureJson(error);
    // Every top-level message must be a known safe message
    expect(Object.values(SAFE_ERROR_MESSAGES)).toContain(body.error.message);
  });

  it('does not expose SQL fragments in the response', () => {
    const body = invokeAndCaptureJson(new Error('SELECT * FROM users WHERE id=1'));
    expect(JSON.stringify(body)).not.toContain('SELECT');
  });

  it('does not expose file paths in the response', () => {
    const body = invokeAndCaptureJson(new Error('/app/src/repositories/userRepo.ts:55 failed'));
    expect(JSON.stringify(body)).not.toContain('/app/src');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 8. res.headersSent guard
// ════════════════════════════════════════════════════════════════════════════

describe('errorHandler – headers already sent', () => {
  it('does nothing when res.headersSent is true', () => {
    const res = makeMockRes({}, /* headersSent */ true);
    errorHandler(new Error('late error'), makeMockReq(), res, makeMockNext());

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
    // Logger is also not called in this guard path
    expect(loggerErrorSpy).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 9. req.streamError injection path
// ════════════════════════════════════════════════════════════════════════════

describe('errorHandler – req.streamError override', () => {
  it('uses req.streamError instead of the passed error argument', () => {
    const streamErr = new AppError(503, 'dependency_unavailable', 'A required service is temporarily unavailable');
    const req = makeMockReq({ streamError: streamErr });
    const res = makeMockRes();

    // Pass a generic error as the argument; handler should prefer streamError
    errorHandler(new Error('original'), req, res, makeMockNext());

    expect(res.status).toHaveBeenCalledWith(503);
    const body = (res.json as jest.Mock).mock.calls[0][0];
    expect(body.error.code).toBe('dependency_unavailable');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 10. notFoundHandler
// ════════════════════════════════════════════════════════════════════════════

describe('notFoundHandler', () => {
  it('calls next() with an AppError', () => {
    const next = makeMockNext();
    notFoundHandler(makeMockReq(), makeMockRes(), next);

    expect(next).toHaveBeenCalledTimes(1);
    const passedError = next.mock.calls[0][0];
    expect(passedError).toBeInstanceOf(AppError);
  });

  it('passes a 404 AppError to next', () => {
    const next = makeMockNext();
    notFoundHandler(makeMockReq(), makeMockRes(), next);

    const passedError: AppError = next.mock.calls[0][0];
    expect(passedError.statusCode).toBe(404);
  });

  it('passes the not_found error code', () => {
    const next = makeMockNext();
    notFoundHandler(makeMockReq(), makeMockRes(), next);

    const passedError: AppError = next.mock.calls[0][0];
    expect(passedError.code).toBe('not_found');
  });

  it('does not call res.json directly', () => {
    const res = makeMockRes();
    const next = makeMockNext();
    notFoundHandler(makeMockReq(), res, next);
    expect(res.json).not.toHaveBeenCalled();
  });
});
