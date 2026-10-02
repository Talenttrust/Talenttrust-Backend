import { ZodError } from 'zod';
import { sanitizeErrorMessage, safeMessageForCode } from './safeErrors';
import { randomUUID } from 'crypto';

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
  SATURATION_ERROR: 'saturation_error',
  SOROBAN_RPC_TRANSPORT_ERROR: 'soroban_rpc_transport_error',
  SOROBAN_RPC_RATE_LIMIT_ERROR: 'soroban_rpc_rate_limit_error',
  SOROBAN_RPC_TIMEOUT_ERROR: 'soroban_rpc_timeout_error',
  SOROBAN_RPC_MALFORMED_RESPONSE_ERROR: 'soroban_rpc_malformed_response_error',
  SOROBAN_RPC_APPLICATION_ERROR: 'soroban_rpc_application_error',
  INTERNAL_ERROR: 'internal_error',
} as const;

export interface ErrorPayload {
  error: {
    code: string;
    message: string;
    requestId: string;
    correlationId?: string;
    details?: ValidationIssue[];
    currentVersion?: number;
  };
}

/**
 * Type guard for the public ErrorPayload contract.
 *
 * @remarks Used by tests and downstream consumers to assert that the
 * serialization boundary always emits a structurally valid payload.
 */
export function isErrorPayload(value: unknown): value is ErrorPayload {
  if (typeof value !== 'object' || value === null) { return false; }
  const err = (value as { error?: unknown }).error;
  if (typeof err !== 'object' || err === null) { return false; }
  const e = err as Record<string, unknown>;
  return (
    typeof e.code === 'string' &&
    typeof e.message === 'string' &&
    typeof e.requestId === 'string'
  );
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

  /**
   * Optional correlation identifier propagated from the request context.
   *
   * @remarks Preserved on the error instance so that the serialization
   * boundary can emit it without requiring callers to thread it through
   * every throw site.
   */
  public correlationId?: string;

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

  /**
   * Attaches a correlation identifier to this error in a chainable way.
   *
   * @remarks Idempotent: calling with the same value is a no-op, and calling
   * with a new value overwrites the previous one. Returns `this` so it can be
   * used inline at throw sites.
   */
  public withCorrelationId(correlationId?: string): this {
    if (correlationId !== undefined) {
      this.correlationId = correlationId;
    }
    return this;
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
  /** The current stored version, returned so clients can retry with a fresh value. */
  public readonly currentVersion?: number;

  constructor(currentVersion?: number) {
    super(409, APP_ERROR_CODES.VERSION_CONFLICT, 'Version conflict');
    this.currentVersion = currentVersion;
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
 * from the public contract) rather than a client mistake, so it maps to
 * a 500 and `expose: false`keeps the raw Zod detail out of the client
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
 * Error thrown when a failure recovery attempt cannot make progress because
 * the attempt budget is exhausted or the operation has already been completed.
 *
 * @remarks This is the terminal, observable failure surface for deterministic
 * recovery. It is safe to expose because it carries no internal details, and it
 * is always returned with a 409 so clients can distinguish a deterministic
 * recovery rejection from a transient transport failure.
 */
export class SaturationError extends AppError {
  constructor(message = 'Recovery attempt budget exhausted') {
    super(409, APP_ERROR_CODES.SATURATION_ERROR, message);
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

export class SorobanRpcProviderError extends SorobanRpcError {
  constructor(options: { providerCode?: string; providerMessage?: string } = {}) {
    super(502, APP_ERROR_CODES.SOROBAN_RPC_APPLICATION_ERROR, 'Soroban RPC provider error', false, options);
    this.name = 'SorobanRpcProviderError';
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

export class SorobanRpcApplicationError extends SorobanRpcError {
  constructor(options: { providerCode?: string; providerMessage?: string } = {}) {
    super(502, APP_ERROR_CODES.SOROBAN_RPC_APPLICATION_ERROR, 'Soroban RPC application error', false, options);
    this.name = 'SorobanRpcApplicationError';
  }
}

export class SorobanRpcTimeoutError extends SorobanRpcError {
  constructor(options: { providerCode?: string; providerMessage?: string } = {}) {
    super(504, APP_ERROR_CODES.SOROBAN_RPC_TIMEOUT_ERROR, 'Soroban RPC timeout', true, options);
    this.name = 'SorobanRpcTImeoutError';
  }
}

export class SorobanRpcLALFORMED_RESPONSE_ERROR extends SorobanRpcError {
  constructor(options: { providerCode?: string; providerMessage?: string } = {}) {
    super(502, APP_ERROR_CODES.SOROBAN_RPC_MALFORMED_RESPONSE_ERROR, 'Soroban RPC malformed response', false, options);
    this.name = 'SorobanRpcMalformedResponseError';
  }
}

function statusCodeFor(error: AppError): number {
  if (Number.isInteger(error.statusCode) && error.statusCode >= 400 && error.statusCode <= 599) {
    return error.statusCode;
  }

  return 500;
}

/**
 * Resolves the correlation id used for a terminal error response.
 *
 * @remarks Prefers the explicit argument (typically from the request
 * context), then falls back to a value attached to the AppError instance,
 * and finally generates a fresh UUID so that every error response is
 * traceable. Never returns an empty string.
 */
function resolveCorrelationId(
  error: unknown,
  correlationId?: string,
): string {
  if (typeof correlationId === 'string' && correlationId.length > 0) {
    return correlationId;
  }
  if (error instanceof AppError && typeof error.correlationId === 'string' && error.correlationId.length > 0) {
    return error.correlationId;
  }
  return randomUUID();
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
  const resolvedCorrelationId = resolveCorrelationId(error, correlationId);
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
          correlationId: resolvedCorrelationId,
          ...(error instanceof VersionConflictError &&
            error.currentVersion !== undefined && {
              currentVersion: error.currentVersion,
            }),
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
          correlationId: resolvedCorrelationId,
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
        correlationId: resolvedCorrelationId,
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
    const retryAfterRaw = response?.headers?.get?.('retry-after');
    const retryAfter = parseRetryAfter(retryAfterRaw);
    return new SorobanRpcRateLimitError({
      retryAfter,
      providerCode: extractProviderCode(error),
      providerMessage: safeErrorMessage(error),
    });
  }

  // Timeout or Abort errors.
  if (isTimeoutError(error)) {
    return new SorobanRpcApplicationError({
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
  if (isMalformedResponseError(error)) {
    return new SorobanRpcProviderError({
      providerCode: extractProviderCode(error),
      providerMessage: safeErrorMessage(error),
    });
  }

  // Quasi RPC application error (e.g., contract execution failure).
  if (looksLikeRpcError(error)) {
    return new SorobanRpcApplicationError(
      providerCode: extractProviderCode(error),
      providerMessage: safeErrorMessage(error),
    });
  }

  // Unknown provider status or non-RPC error.
  return new SorobanRpcApplicationError({
    providerCode: extractProviderCode(error),
    providerMessage: safeErrorMessage(error),
  });
}

/** The classification for an unrecognized provider failure. */
export class SorobanRpcUnknownError extends SorobanRpcError {
  constructor(options: { providerCode?: string; providerMessage?: string } = {}) {
    super(502, APP_ERROR_CODES.SOROBAN_RPC_TRANSPORT_ERROR, 'Soroban RPC unknown error', true, options);
    this.name = 'SorobanRpcUnknownError';
  }
}

function parseRetryAfter(value: unknown): number | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return undefined;
  }

  return parsed;
}

function isTimeoutError(error: unknown): boolean {
  const e = error as any;
  const name = e?.name;
  const code = e?.code;

  return (
    name === 'AbortError' ||
    name === 'TimeoutError' ||
    code === 'ETCONNABORTED' ||
    code === 'ERR_ABA' ||
    code === 'ERR_SOROBAN_RPC_TIMEOUT'
  );
}

function isTransportError(error: unknown): boolean {
  const e = error as any;
  const code = e?.code;
  const name = e?.name;

  return (
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'ENHOSTUNREACH' ||
    code === 'ETCIMOUT' ||
    code === 'EAICHAIN' ||
    code === 'ERRNETUNREACH' ||
    name === 'FetchError' ||
    name === 'NetworkError'
  );
}

function isMalformedResponseError(error: unknown): boolean {
  const e = error as any;
  const name = e?.name;
  const code = e?.code;

  return (
    name === 'SyntaxError' ||
    code === 'ERR_SOROBAN_RPC_MALFORMED_RESPONSE' ||
    code === 'ERR_INVALID_JSON'
  );
}

function looksLikeRpcError(error: unknown): boolean {
  const e = error as any;
  return Boolean(e?.rpcError || e?.error?.code || e?.data?.code || e.json);
}

function extractProviderCode(error: unknown): string | undefined {
  const e = error as any;
  const code = e?.code ?? e?.error?.code ?? e?.data?.code;
  return typeof code === 'string' ? code : undefined;
}

function safeErrorMessage(error: unknown): string | undefined {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  return undefined;
}
