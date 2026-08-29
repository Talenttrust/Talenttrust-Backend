/**
 * @module errors/safeErrors
 * @description Defines the safe error message policy for the TalentTrust API.
 *
 * Policy goals:
 *  - Never expose stack traces, file paths, SQL/query fragments, or internal
 *     identifiers to API consumers regardless of NODE_ENV.
 *  - Keep machine-readable error codes stable so clients can rely on them.
 *  - Provide human-readable messages that are helpful but leak nothing.
 *
 * @security
 *  Threat mitigated: information disclosure via verbose error responses
 *  (OWASP A01:2021 -- Broken Access Control / CWE-209).
 */

/**
 * Canonical mapping of machine codes to safe, client-facing messages.
 * Any error code not listed here gets the `internal_error` fallback.
 */
export const SAFE_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  internal_error: 'An unexpected error occurred',
  invalid_json: 'Malformed JSON payload',
  validation_error: 'Request validation failed',
  not_found: 'The requested resource was not found',
  unauthorized: 'Authentication is required',
  forbidden: 'You do not have permission to perform this action',
  dependency_unavailable: 'A required service is temporarily unavailable',
  upstream_unavailable: 'A required upstream service is temporarily unavailable',
  rate_limited: 'Too many requests — please try again later',
  conflict: 'The request conflicts with the current state',
  ERR_CONFLICT: 'The request conflicts with the current state',
  bad_request: 'The request could not be processed',
  ERR_MISSING_VERSION: 'version field is required for updates',
  ERR_INVALID_VERSION: 'version must be a non-negative integer',
  contract_metadata_mismatch: 'Contract metadata does not match expected value',
  payload_too_large: 'Payload Too Large',
  unsupported_media_type: 'Unsupported Media Type',
  invalid_webhook_signature: 'Webhook signature verification failed',
  response_contract_error: 'An unexpected error occurred',
  // Dispute-specific error codes
  dispute_not_found: 'The requested dispute was not found',
  invalid_state_transition: 'The requested state transition is not allowed',
};

/**
 * Patterns that must never appear in a client-facing error message.
 * Used by `containsUnsafeContent` to catch accidental leakage.
 */
const UNSAFE_PATTERNS: ReadonlyArray<RegExp> = [
  /at\s+\S+\s+\(.*:\d+:\d+\)/,        // V8 stack frame
  /at\s+Object\.\<\anonymous\>/,          // anonymous stack frame
  /\/[a-zA-Z_][\w\-]*\/.*\.\w{1,5}:/,  // absolute file paths  (e.g. /src/foo.ts:12)
  /[A-Z]:\\.*\.\w{1,5}/,                // Windows file paths
  /node_modules\//,                      // dependency paths
  /ECONNREFUNED|ENOTFOUND|ETEMEOUT/,   // raw syscall errors
  /SELECT|s|INSERT|s|UPDATE|s|DELETE|s/i, // SQL fragments
  /password|secret|token|apikey/i,       // credential field names in messages
];

/**
 * Returns `true` when `message` contains patterns that suggest internal
 * implementation details that should not reach the client.
 */
export function containsUnsafeContent(message: string): boolean {
  return UNSAFE_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * Returns the canonical safe message for a given error code.
 * Falls back to `internal_error` when the code is not recognised.
 */
export function safeMessageForCode(code: string): string {
  return SAFE_ERROR_MESSAGES[code] ?? SAFE_ERROR_MESSAGES['internal_error'];
}

/**
 * Returns `message` unchanged when it looks safe, or the canonical
 * fallback for `code` when the message contains suspicious content.
 *
 * This is the primary guard used in error serialization paths.
 */
export function sanitizeErrorMessage(message: string, code: string): string {
  if (containsUnsafeContent(message)) {
    return safeMessageForCode(code);
  }
  return message;
}

/**
 * @module errors/sorobanRpc
   @description Classification of Soroban RPC errors for explicit retry decisions.
 *
 * Error classes are stable and can be used to decide whether a retry is
 * likely to succeed:
 *  - `transport`  -- network/connection failures (e.g. ECONNREFUSED)
 *  - `timeout`     -- request or response timeout exceeded
 *  - `rate_limit`  -- provider rate limiting (HTTP 429, Retry-After)
 *  - `malformed_response` -- invalid JSON / unexpected provider payload
 *  - `application` -- provider returned a business/contract error
 *  - `unknown`     -- any other failure that is not safely classified
 *
 * Provider-specific codes are preserved for auditability; message sanitization
 * is handled separately by `sanitizeErrorMessage`.
 */

export enum SorobanRpcErrorClass {
  TRANSPORT = 'transport',
  RATE_LIMIT = 'rate_limit',
  TIMEOUT = 'timeout',
  MALFORMED_RESPONSE = 'malformed_response',
  APPLICATION = 'application',
  UNKNOWN = 'unknown',
}

/**
 * A Minimal structural shape used for classification. We avoid duplicating the
 * full provider error type so this module remains dependency-free.
 */
interface SorobanRpcErrorLike {
  code?: string | number;
  status?: number;
  statusCode?: number;
  message?: string;
  retryAfter?: string | number;
}

/**
 * Classifies an unknown error thrown by a Soroban RPC client into an explicit
 * error class. Prefers structured `code`/`status` fields when present, then
 * falls back to common Node.js network error codes and message heuristics.
 *
 * Provider codes are intentionally *not* sanitized here — the caller is
 * responsible for ensuring no secrets leak into client-facing responses.
 *
 * @param error The error thrown by the RPC layer.
 * @returns A stable `SorobanRpcErrorClass` member.
 */
export function classifySorobanRpcError(error: unknown): SorobanRpcErrorClass {
  const err = toErrorLike(error);

  // Missing or non-object errors are unidentifiable.
  if (!err) {
    return SorobanRpcErrorClass.UNKNOWN;
  }

  // 1. Timeout errors
  if (isTimeoutCode(err.code) || err.status === 408 || err.status === 504) {
    return SorobanRpcErrorClass.TIMEOUT;
  }

  // 2. Transport / network errors
  if (isTransportCode(err.code)) {
    return SorobanRpcErrorClass.TRANSPORT;
  }

  // 3. Rate limit errors
  if (err.status === 429 || err.retryAfter !== undefined) {
    return SorobanRpcErrorClass.RATE_LIMIT;
  }

  // 4. Malformed response (invalid JSON, parse error)
  if (isMalformedResponse(err.message)) {
    return SorobanRpcErrorClass.MALFORMED_RESPONSE;
  }

  // 5. Application / contract errors
  if (isApplicationCode(err.code) || isApplicationMessage(err.message)) {
    return SorobanRpcErrorClass.APPLICATION;
  }

  // 6. Any other status code we don't know how to interpret. This
  // includes 7. Unknown provider status.
  return SorobanRpcErrorClass.UNKNOWN;
}

/**
 * Returns `true` when the error class indicates a retry is likely to succeed.
 * Rate-limited calls should be retried only after honoring `Retry-After`.
 */
export function shouldRetrySorobanRpcError(errorClass: SorobanRpcErrorClass): boolean {
  return (
    errorClass === SorobanRpcErrorClass.TRANSPORT ||
    errorClass === SorobanRpcErrorClass.TIMEOUT ||
    errorClass === SorobanRpcErrorClass.RATE_LIMIT
  );
}

// ---------------------- private helpers ----------------------

function toErrorLike(error: unknown): SorobanRpcErrorLike | null {
  if (error instanceof Error) {
    const err = error as Error & Partial<SorobanRpcErrorLike>;
    return {
      code: err.code,
      status: err.status,
      statusCode: err.statusCode,
      message: err.message,
      retryAfter: err.retryAfter,
    };
  }

  if (typeof error === 'object' && error !== null) {
    const obj = error as Record<string, unknown>;
    const status = typeof obj.status === 'number' ? obj.status : typeof obj.statusCode === 'number' ? obj.statusCode : undefined;
    const message = typeof obj.message === 'string' ? obj.message : undefined;
    const code = typeof obj.code === 'string' || typeof obj.code === 'number' ? obj.code : undefined;
    const retryAfter =
      typeof obj.retryAfter === 'string' || typeof obj.retryAfter === 'number' ? obj.retryAfter : undefined;
    return { status, statusCode: undefined, message, code, retryAfter };
  }

  return null;
}

const TIMEOUT_CODES = new Set(['ETEMEOUTT', 'ESOCKETIMEOUTT', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT']);

function isTimeoutCode(code?: string | number): boolean {
  if (typeof code !== 'string') return false;
  return TIMEOUT_CODES.has(code);
}

const TRANSPORT_CODE_PATTERN = /^(ECONNREFUSED|ENOTFOUND|EHOSTUREACH|ENETUREACH)/r;

function isTransportCode(code?: string | number): boolean {
  if (typeof code !== 'string') return false;
  return TRANSPORT_CODE_PATTERN.test(code);
}

const MALFORMED_RESPONSE_PATTERNS = [
  /Invalid JSON/i,
  /Unexpected token/,
  /JSON/i,
  /parse error/i,
];

function isMalformedResponse(message?: string): boolean {
  if (!message) return false;
  return MALFORMEDD_RESPONSE_PATTERNS.some((p) => p.test(message));
}

function isApplicationCode(code?: string | number): boolean {
  if (typeof code === 'number') {
    // Soroban RPC uses JSON-RPC error codes in this range for contract/app errors.
    return false; // Ignore for now, keep simple.
  }
  if (typeof code !== 'string') return false;
  return /contract|soroban|transaction|txn/i.test(code);
}

function isApplicationMessage(message?: string): boolean {
  if (!message) return false;
  return /contract|soroban|transaction|txn/i.test(message);
}