import {
  containsUnsafeContent,
  safeMessageForCode,
  sanitizeErrorMessage,
  SAFE_ERROR_MESSAGES,
} from './safeErrors';
import {
  APP_ERROR_CODES,
  ConflictError,
  ContractMetadataMismatchError,
  ForbiddenError,
  InvalidVersionError,
  mapErrorToPayload,
  MissingVersionError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
  VersionConflictError,
} from './appError';

describe('safeErrors', () => {
  describe('SAFE_ERROR_MESSAGES', () => {
    it('provides a stable set of known error codes', () => {
      const expectedCodes = [
        'internal_error',
        'invalid_json',
        APP_ERROR_CODES.VALIDATION_ERROR,
        APP_ERROR_CODES.NOT_FOUND,
        APP_ERROR_CODES.UNAUTHORIZED,
        APP_ERROR_CODES.FORBIDDEN,
        'forbidden',
        'dependency_unavailable',
        'rate_limited',
        APP_ERROR_CODES.CONFLICT,
        APP_ERROR_CODES.VERSION_CONFLICT,
        'bad_request',
        APP_ERROR_CODES.MISSING_VERSION,
        APP_ERROR_CODES.INVALID_VERSION,
        APP_ERROR_CODES.CONTRACT_METADATA_MISMATCH,
      ];
      for (const code of expectedCodes) {
        expect(SAFE_ERROR_MESSAGES).toHaveProperty(code);
        expect(typeof SAFE_ERROR_MESSAGES[code]).toBe('string');
      }
    });

    it('messages contain no stack-trace-like content', () => {
      for (const msg of Object.values(SAFE_ERROR_MESSAGES)) {
        expect(containsUnsafeContent(msg)).toBe(false);
      }
    });

    it('codes contain no internal details', () => {
      for (const code of Object.keys(SAFE_ERROR_MESSAGES)) {
        expect(containsUnsafeContent(code)).toBe(false);
        expect(code).not.toMatch(/password|secret|token|apikey|node_modules|[A-Z]:\\/i);
      }
    });
  });

  describe('containsUnsafeContent', () => {
    it('detects V8 stack frames', () => {
      expect(containsUnsafeContent('at Module._compile (/src/app.ts:12:5)')).toBe(true);
    });

    it('detects anonymous stack frames', () => {
      expect(containsUnsafeContent('at Object.<anonymous>')).toBe(true);
    });

    it('detects absolute file paths', () => {
      expect(containsUnsafeContent('failed at /home/deploy/app.ts:42')).toBe(true);
    });

    it('detects Windows file paths', () => {
      expect(containsUnsafeContent('C:\\Users\\dev\\project\\index.js')).toBe(true);
    });

    it('detects node_modules references', () => {
      expect(containsUnsafeContent('node_modules/express/lib/router.js')).toBe(true);
    });

    it('detects raw syscall errors', () => {
      expect(containsUnsafeContent('connect ECONNREFUSED 127.0.0.1:5432')).toBe(true);
      expect(containsUnsafeContent('getaddrinfo ENOTFOUND db.internal')).toBe(true);
    });

    it('detects SQL fragments', () => {
      expect(containsUnsafeContent('SELECT * FROM users WHERE id = 1')).toBe(true);
      expect(containsUnsafeContent('INSERT INTO sessions VALUES')).toBe(true);
    });

    it('detects credential field names', () => {
      expect(containsUnsafeContent('invalid password for user admin')).toBe(true);
      expect(containsUnsafeContent('missing apikey in request')).toBe(true);
    });

    it('returns false for safe messages', () => {
      expect(containsUnsafeContent('An unexpected error occurred')).toBe(false);
      expect(containsUnsafeContent('The requested resource was not found')).toBe(false);
      expect(containsUnsafeContent('Validation failed')).toBe(false);
      expect(containsUnsafeContent('')).toBe(false);
    });
  });

  describe('safeMessageForCode', () => {
    it('returns the mapped message for known codes', () => {
      expect(safeMessageForCode(APP_ERROR_CODES.NOT_FOUND)).toBe(
        'The requested resource was not found',
      );
      expect(safeMessageForCode('internal_error')).toBe('An unexpected error occurred');
      expect(safeMessageForCode('invalid_json')).toBe('Malformed JSON payload');
      expect(safeMessageForCode(APP_ERROR_CODES.VERSION_CONFLICT)).toBe(
        'The request conflicts with the current state',
      );
    });

    it('falls back to internal_error for unknown codes', () => {
      expect(safeMessageForCode('some_unknown_code')).toBe('An unexpected error occurred');
      expect(safeMessageForCode('')).toBe('An unexpected error occurred');
    });
  });

  describe('sanitizeErrorMessage', () => {
    it('passes through safe messages unchanged', () => {
      expect(sanitizeErrorMessage('Resource not found', APP_ERROR_CODES.NOT_FOUND)).toBe(
        'Resource not found',
      );
    });

    it('replaces messages containing stack traces', () => {
      const unsafe = 'Error at Module._compile (/src/index.ts:10:3)';
      expect(sanitizeErrorMessage(unsafe, 'internal_error')).toBe('An unexpected error occurred');
    });

    it('replaces messages containing file paths', () => {
      const unsafe = 'Cannot read file /etc/secrets/db.conf:1';
      expect(sanitizeErrorMessage(unsafe, 'internal_error')).toBe('An unexpected error occurred');
    });

    it('replaces messages containing SQL', () => {
      const unsafe = 'error in SELECT id FROM contracts WHERE status = active';
      expect(sanitizeErrorMessage(unsafe, 'internal_error')).toBe('An unexpected error occurred');
    });

    it('replaces messages containing credential references', () => {
      const unsafe = 'token expired for session xyz-123';
      expect(sanitizeErrorMessage(unsafe, 'unauthorized')).toBe('Authentication is required');
    });

    it('uses the correct fallback per error code', () => {
      const unsafe = 'ECONNREFUSED 10.0.0.5:6379';
      expect(sanitizeErrorMessage(unsafe, 'dependency_unavailable')).toBe(
        'A required service is temporarily unavailable',
      );
    });
  });

  describe('safe serialized AppError responses', () => {
    it('includes each subclass code in the safe response body', () => {
      const errors = [
        new NotFoundError(),
        new UnauthorizedError(),
        new MissingVersionError(),
        new InvalidVersionError(),
        new VersionConflictError(),
        new ForbiddenError(),
        new ConflictError(),
        new ContractMetadataMismatchError(),
        new ValidationError(),
      ];

      for (const error of errors) {
        const { payload } = mapErrorToPayload(error, 'req-safe');
        expect(payload.error.code).toBe(error.code);
        expect(payload.error.requestId).toBe('req-safe');
        expect(containsUnsafeContent(payload.error.message)).toBe(false);
      }
    });

    it('falls through non-AppError values without exposing internals', () => {
      const { statusCode, payload } = mapErrorToPayload('token leaked in thrown string', 'req-raw');

      expect(statusCode).toBe(500);
      expect(payload.error).toEqual({
        code: 'internal_error',
        message: 'An unexpected error occurred',
        requestId: 'req-raw',
      });
    });
  });
});
