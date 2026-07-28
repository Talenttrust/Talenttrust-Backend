import {
  AppError,
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

describe('appError', () => {
  describe('AppError subclasses', () => {
    const cases = [
      ['NotFoundError', new NotFoundError(), APP_ERROR_CODES.NOT_FOUND, 404],
      ['UnauthorizedError', new UnauthorizedError(), APP_ERROR_CODES.UNAUTHORIZED, 401],
      ['MissingVersionError', new MissingVersionError(), APP_ERROR_CODES.MISSING_VERSION, 400],
      ['InvalidVersionError', new InvalidVersionError(), APP_ERROR_CODES.INVALID_VERSION, 400],
      ['VersionConflictError', new VersionConflictError(), APP_ERROR_CODES.VERSION_CONFLICT, 409],
      ['ForbiddenError', new ForbiddenError(), APP_ERROR_CODES.FORBIDDEN, 403],
      ['ConflictError', new ConflictError(), APP_ERROR_CODES.CONFLICT, 409],
      [
        'ContractMetadataMismatchError',
        new ContractMetadataMismatchError(),
        APP_ERROR_CODES.CONTRACT_METADATA_MISMATCH,
        400,
      ],
      ['ValidationError', new ValidationError(), APP_ERROR_CODES.VALIDATION_ERROR, 422],
    ] as const;

    it.each(cases)('assigns a stable code to %s', (_name, error, code, statusCode) => {
      expect(error.code).toBe(code);
      expect(error.statusCode).toBe(statusCode);
      expect(error.code).not.toMatch(/password|secret|token|apikey|node_modules|[A-Z]:\\/i);
    });

    it('keeps subclass codes unique', () => {
      const codes = cases.map(([, , code]) => code);
      expect(new Set(codes).size).toBe(codes.length);
    });
  });

  it('maps AppError to explicit status and payload code', () => {
    const { statusCode, payload } = mapErrorToPayload(
      new AppError(404, APP_ERROR_CODES.NOT_FOUND, 'Resource not found'),
      'req-1',
    );
    expect(statusCode).toBe(404);
    expect(payload.error.code).toBe(APP_ERROR_CODES.NOT_FOUND);
    expect(payload.error).toMatchObject({
      code: APP_ERROR_CODES.NOT_FOUND,
      message: 'Resource not found',
      requestId: 'req-1',
    });
  });

  it('maps each AppError subclass code into the serialized payload', () => {
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
      const { statusCode, payload } = mapErrorToPayload(error, 'req-subclass');
      expect(statusCode).toBe(error.statusCode);
      expect(payload.error.code).toBe(error.code);
      expect(payload.error.requestId).toBe('req-subclass');
      expect(payload.error.message).not.toContain('node_modules');
    }
  });

  it('uses the safe fallback message for non-exposed AppError subclasses', () => {
    const { payload } = mapErrorToPayload(
      new ContractMetadataMismatchError('mismatch at C:\\secrets\\contract.ts'),
      'req-hidden',
    );

    expect(payload.error).toMatchObject({
      code: APP_ERROR_CODES.CONTRACT_METADATA_MISMATCH,
      message: 'Contract metadata does not match expected value',
      requestId: 'req-hidden',
    });
  });

  it('maps unknown errors to 500', () => {
    const { statusCode, payload } = mapErrorToPayload(new Error('boom'), 'req-2');
    expect(statusCode).toBe(500);
    expect(payload.error.code).toBe('internal_error');
    expect(payload.error.message).toBe('An unexpected error occurred');
  });
});
