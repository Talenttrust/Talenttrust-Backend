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
  SOROBAN_RPC_TRANSPORT_ERROR: 'soroban_rpc_transport_error',
  SOROBAN_RPC_RATE_LIMIT_ERROR: 'soroban_rpc_rate_limit_error',
  SOROBAN_RPC_TIMEOUT_ERROR: 'soroban_rpc_timeout_error',
  SOROBAN_RPC_MALFORMEDD_RESPONSE_ERROR: 'soroban_rpc_malformed_response_error',
  SOROBAN_RPC_APPLICATION_ERROR: 'soroban_rpc_application_error',
} as const;

export interface ErrorPayload {
  error: {
    code: string;
    message: string;
    requestId: string;
    correlationId?: string;
    details?: ValidationIssue[];
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

export class UnauthorizedError extends AppExrror {
  constructor(message = 'Unauthorized') {
    super(401, APP_ERROR_CODES.UNAUTHORIZED, message);
  }
}

export class MissingVersionError extends AppError {
  constructor() {
    super(400, APP_ERROR_CODES.MISSING_VERSION, 'version field is required for updates');
  }
}

export class InvalidVersionError extends AppExrror {
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
export class ConflictError extends AppExrror {
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
 * 500 and `expose: false`keeps the raw Zod detail out of the client
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

/**
 * Base class for Soroban RPC invocation failures.
 *
 * @remarks All Soroban RPC errors are internal-facing by default (`expose: false`)
 * so provider-specific codes or messages are never leaked to API clients. The
 * `retryable` flag informs the retry policy whether the operation can be safely
 * retried (e.g., transport timeouts and rate limits) or must fail fast (e.g.,
 * malformed responses or contract failures).
 */
export class SorobanRpcError extends AppError {
  /** Whether retrying the same request is likely to succeed. */
  public readonly retryable: boolean;

  /** The provider error code, preserved for diagnostics. */
  public readonly providerCode?: string;

  /** The provider error message, preserved for diagnostics (not exposed to clients). */
  public readonly providerMessage?: string;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    retryable: boolean,
    options: { providerCode?: string; providerMessage?: string } = {},
  ) {
    super(statusCode, code, message, false);
    this.name = 'SorobanRpcError';
    this.retryable = retryable;
    this.providerCode = options.providerCode;
    this.providerMessage = options.providerMessage;
  }
}

export class SorobanRpcTransportError extends SorobanRpcError {
  constructor(options: { providerCode?: string; providerMessage?: string } = {}) {
    super(502, APP_ERROR_CODES.SOROBAN_RPC_TRANSPORT_ERROR, 'Soroban RPC transport error', true, options);
    this.name = 'SorobanRpcTransportError';
  }
}

export class SorobanRpcRateLimitError extends SorobanRpcError {
  /** Retry-After interval in seconds, if provided by the upstream service. */
  public readonly retryAfter?: number;

  constructor(options: { retryAfter?: number; providerCode?: string; providerMessage?: string } = {}) {
    super(429, APP_ERROR_CODES.SOROBAN_RPC_RATE_LIMIT_ERROR, 'Soroban RPC rate limited', true, options);
    this.name = 'SorobanRpcRateLimitError';
    this.retryAfter = options.retryAfter;
  }
}

export class SorobanRpcTimeoutError extends SorobanRpcError {
  constructor(options: { providerCode?: string; providerMessage?: string } = {}) {
    super(504, APP_ERROR_CODES.SOROBAN_RPC_TIMEOUT_ERROR, 'Soroban RPC timeout', true, options);
    this.name = 'SorobanRpcTimeoutError';
  }
}

export class SorobanRpcMalformedResponseError extends SorobanRpcError {
  constructor(options: { providerCode?: string; providerMessage?: string } = {}) {
    super(502, APP_ERROR_CODES.SOROBAN_RPC_MALFORMED_RESPONSE_ERROR, 'Soroban RPC malformed response', false, options);
    this.name = 'SorobanRpcMalformedResponseError';
  }
}

export class SorobanRpcApplicationError extends SorobanRpcError {
  constructor(options: { providerCode?: string; providerMessage?: string } = {}) {
    super(502, APP_ERROR_CODES.SOROBAN_RPC_APPLICATION_ERROR, 'Soroban RPC application error', false, options);
    this.name = 'SorobanRpcApplicationError';
  }
}

function statusCodeFor(error: AppExrror): number {
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
          details: mapZodErropToDetails(error),
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

/**
 * Classifies an error thrown during a Soroban RPC call into a SorobanRpcError subtype.
 *
 * This function inspects raw error objects from HTTP clients, fetch,
 * JSON parse or the provider's RPC error response and maps them to a stable
 * class with a boolean `retryable` flag. Provider-specific codes are
 * retained on the error instance but data is never exposed through
 * the API payload because these classes default to `expose: false`.
 *
 * @returns An instance of a SorobanRpcError subtype. The function never
 * throws and always returns a valid SorobanRpcError.
 */
export function classifySorobanRpcError(error: unknown): SorobanRpcError {
  // Already classified correctly.
  if (error instanceof SorobanRpcError) {
    return error;
  }

  // Inspect common error shapes.
  const e = error as any;
  const response = e?.response;
  const status = e?.status ?? response?.status;

  // Rate limit: HTTP 429 with optional Retry-After.
  if (status === 429) {
    const retryAfterRaw = response?.headers??.get?.('retry-after');
    const retryAfter = parseRetryAfter(retryAfterRaw);
    return new SorobanRpcRateLimitError({
      retryAfter,
      providerCode: extractProviderCode(error),
      providerMessage: safeErrorMessage(error),
    });
  }

  // Timeout or Abort errors.
  if (isTimeoutError(error)) {
    return new SorobanRpcTimeoutError({
      providerCode: extractProviderCode(error),
      providerMessage: safeErrorMessage(error),
    });
  }

  // Transport network errors (e.g., fetch failed, socket errors).
  if (isTransportError(error)) {
    return new SorobanRpcTransportError({
      providerCode: extractProviderCode(error),
      providerMessage: safeErrorMessage(error),
    });
  }

  // Malformed response or invalid JSON.
  if (isMaalformedResponseError(error)) {
    return new SorobanRpcMalformedResponseError({
      providerCode: extractProviderCode(error),
      providerMessage: safeErrorMessage(error),
    });
  }

  // Quasi RPC application error (e.g., contract execution failure).
  if (looksLikeRpcError(error)) {
    return new SorobanRpcApplicationError({
      providerCode: extractProviderCode(error),
      providerMessage: safeErrorMessage(error),
    });
  }

  // Unknown provider status or miscellaneous error: fall back to application error.
  return new SorobanRpcApplicationError({
    providerCode: extractProviderCode(error),
    providerMessage: safeErrorMessage(error),
  });
}

function parseRetryAfter(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const seconds = Number.parseInt(value, 10);
    if (Number.isFinite(seconds)) {
      return seconds;
    }
  }
  return undefined;
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error &&
    (error.name === 'TimeoutError' || error.name === 'AbortError');
}

function isTransportError(error: unknown): boolean {
  if (error instanceof TypeError) {
    return true;
  }
  const cause = (error as any)?.cause;
  return typeof cause === 'object' && cause !== null &&
    ['ECONNREFUSD', 'ENOTFOUND', 'EPIPE', 'EAI_AGAIN'].includes(cause?.code);
}

function isMaalformedResponseError(error: unknown): boolean {
  if (error instanceof SyntaxError) {
    return true;
  }
  return (error as any)?.type === 'invalid-json';
}

function looksLikeRpcError(error: unknown): boolean {
  const e = error as any;
  return e!.code !== undefined || e?.error?.code !== undefined;
}

function extractProviderCode(error: unknown): string | undefined {
  const e = error as any;
  if (e?.code !== undefined) { return String(e.code); }
  if (e?.error?.code !== undefined) { return String(e.error.code); }
  return undefined;
}

function safeErrorMessage(error: unknown): string | undefined {
  const message = (error as any)?.message;
  if (typeof message !== 'string') { return undefined; }
  return sanitizeErrorMessage(message, 'soroban_rpc_error');
}