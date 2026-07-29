import { ZodError } from 'zod';
import { sanitizeErrorMessage, safeMessageForCode } from './safeErrors';

/**
 * Stable machine-readable error codes emitted by AppError subclasses.
 *
 * @remarks Treat these values as append-only API contract strings. Rename or
 * removal would break clients that branch on `error.code`.
 */
export const APP_ERROR_CODES = {
  NOT_FOUND: 'not_found',
  UNAUTHORIZED: 'unauthorized',
  MISSING_VERSION: 'ERR_MISSING_VERSION',
  INVALID_VERSION: 'ERR_INVALID_VERSION',
  VERSION_CONFLICT: 'ERR_CONFLICT',
  FORBIDDEN: 'forbidden',
  CONFLICT: 'conflict',
  CONTRACT_METADATA_MISMATCH: 'contract_metadata_mismatch',
  VALIDATION_ERROR: 'validation_error',
  RESPONSE_CONTRACT_ERROR: 'response_contract_error',
} as const;

export interface ErrorPayload {
  error: {
    code: string;
    message: string;
    requestId: string;
    correlationId?: string;
    details?: ValidationIssue[];
    correlationId?: string;
  };
}

export interface ValidationIssue {
  path: string[];
  message: string;
  code: string;
}

/**
 * Application-level error with explicit status and machine-readable code.
 */
export class AppError extends Error {
  public readonly statusCode: number;

  /**
   * Stable machine-readable API error code safe for clients to branch on.
   *
   * @remarks Codes must not contain internal implementation details and should
   * be treated as append-only public API values.
   */
  public readonly code: string;

  public readonly expose: boolean;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    expose: boolean = true,
  ) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.expose = expose;
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Not found') {
    super(404, APP_ERROR_CODES.NOT_FOUND, message);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super(401, APP_ERROR_CODES.UNAUTHORIZED, message);
  }
}

export class MissingVersionError extends AppError {
  constructor() {
    super(400, APP_ERROR_CODES.MISSING_VERSION, 'version field is required for updates');
  }
}

export class InvalidVersionError extends AppError {
  constructor() {
    super(400, APP_ERROR_CODES.INVALID_VERSION, 'version must be a non-negative integer');
  }
}

export class VersionConflictError extends AppError {
  constructor() {
    super(409, APP_ERROR_CODES.VERSION_CONFLICT, 'Version conflict');
  }
}

/**
 * Forbidden error - user lacks permission or violates business rules.
 */
export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super(403, APP_ERROR_CODES.FORBIDDEN, message);
  }
}

/**
 * Conflict error - resource state conflict (e.g., duplicate entry).
 */
export class ConflictError extends AppError {
  constructor(message = 'Conflict') {
    super(409, APP_ERROR_CODES.CONFLICT, message);
  }
}

/**
 * Error thrown when fetched on-chain contract metadata does not match
 * the pinned/expected value configured for the environment.
 */
export class ContractMetadataMismatchError extends AppError {
  constructor(message = 'Contract metadata mismatch') {
    super(400, APP_ERROR_CODES.CONTRACT_METADATA_MISMATCH, message, false);
  }
}

/**
 * Thrown when an outgoing response payload fails its declared schema.
 *
 * @remarks Indicates a server-side bug (e.g. a persisted record drifting
 * from the public contract) rather than a client mistake, so it maps to a
 * 500 and `expose: false` keeps the raw Zod detail out of the client
 * response — it is still logged server-side by the global error handler.
 */
export class ResponseContractError extends AppError {
  constructor(message = 'Response failed schema validation') {
    super(500, APP_ERROR_CODES.RESPONSE_CONTRACT_ERROR, message, false);
  }
}

/**
 * Validation error - business rule validation failure.
 */
export class ValidationError extends AppError {
  constructor(message = 'Validation error') {
    super(422, APP_ERROR_CODES.VALIDATION_ERROR, message);
  }
}

function statusCodeFor(error: AppError): number {
  if (Number.isInteger(error.statusCode) && error.statusCode >= 400 && error.statusCode <= 599) {
    return error.statusCode;
  }

  return 500;
}

function mapZodErrorToDetails(error: ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map((part) => String(part)),
    message: sanitizeErrorMessage(issue.message, 'validation_error'),
    code: issue.code,
  }));
}

/**
 * Normalizes thrown errors into a safe and consistent API response payload.
 *
 * @remarks This function is the single serialization boundary for terminal API
 * error responses. Internal exception text is never returned for unknown errors,
 * and AppError messages are filtered through the safe message policy before
 * they are exposed.
 */
export function mapErrorToPayload(
  error: unknown,
  requestId: string,
  correlationId?: string,
): { statusCode: number; payload: ErrorPayload } {
  if (error instanceof AppError) {
    const message = error.expose
      ? sanitizeErrorMessage(error.message, error.code)
      : safeMessageForCode(error.code);

    return {
      statusCode: statusCodeFor(error),
      payload: {
        error: {
          code: error.code,
          message,
          requestId,
          ...(correlationId !== undefined && { correlationId }),
        },
      },
    };
  }

  if (error instanceof ZodError) {
    return {
      statusCode: 400,
      payload: {
        error: {
          code: 'validation_error',
          message: safeMessageForCode('validation_error'),
          requestId,
          ...(correlationId !== undefined && { correlationId }),
          details: mapZodErrorToDetails(error),
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
        ...(correlationId !== undefined && { correlationId }),
      },
    },
  };
}
