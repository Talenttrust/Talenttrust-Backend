import { sanitizeErrorMessage, safeMessageForCode } from './safeErrors';

export interface ErrorPayload {
  error: {
    code: string;
    message: string;
    requestId: string;
  };
}

/**
 * Application-level error with explicit status and machine-readable code.
 */
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly expose: boolean = true,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Not found') {
    super(404, 'not_found', message);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super(401, 'unauthorized', message);
  }
}

export class MissingVersionError extends AppError {
  constructor() {
    super(400, 'ERR_MISSING_VERSION', 'version field is required for updates');
  }
}

export class InvalidVersionError extends AppError {
  constructor() {
    super(400, 'ERR_INVALID_VERSION', 'version must be a non-negative integer');
  }
}

export class VersionConflictError extends AppError {
  constructor() {
    super(409, 'ERR_CONFLICT', 'Version conflict');
  }
}

/**
 * Forbidden error - user lacks permission or violates business rules.
 */
export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super(403, 'forbidden', message);
  }
}

/**
 * Conflict error - resource state conflict (e.g., duplicate entry).
 */
export class ConflictError extends AppError {
  constructor(message = 'Conflict') {
    super(409, 'conflict', message);
  }
}

/**
 * Validation error - business rule validation failure.
 */
export class ValidationError extends AppError {
  constructor(message = 'Validation error') {
    super(422, 'validation_error', message);
  }
}

/**
 * Normalizes thrown errors into a safe and consistent API response payload.
 */
export function mapErrorToPayload(
  error: unknown,
  requestId: string,
): { statusCode: number; payload: ErrorPayload } {
  if (error instanceof AppError) {
    const message = error.expose
      ? sanitizeErrorMessage(error.message, error.code)
      : safeMessageForCode(error.code);

    return {
      statusCode: error.statusCode,
      payload: {
        error: {
          code: error.code,
          message,
          requestId,
        },
      },
    };
  }

  return {
    statusCode: 500,
    payload: {
      error: {
        code: 'internal_error',
        message: safeMessageForCode('internal_error'),
        requestId,
      },
    },
  };
}
