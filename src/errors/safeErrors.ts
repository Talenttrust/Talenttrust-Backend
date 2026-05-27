/**
 * @module errors/safeErrors
 * @description Defines the safe error message policy for the TalentTrust API.
 *
 * Policy goals:
 *  - Never expose stack traces, file paths, SQL/query fragments, or internal
 *    identifiers to API consumers regardless of NODE_ENV.
 *  - Keep machine-readable error codes stable so clients can rely on them.
 *  - Provide human-readable messages that are helpful but leak nothing.
 *
 * @security
 *  Threat mitigated: information disclosure via verbose error responses
 *  (OWASP A01:2021 — Broken Access Control / CWE-209).
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
  rate_limited: 'Too many requests — please try again later',
  conflict: 'The request conflicts with the current state',
  bad_request: 'The request could not be processed',
};

/**
 * Patterns that must never appear in a client-facing error message.
 * Used by `containsUnsafeContent` to catch accidental leakage.
 */
const UNSAFE_PATTERNS: ReadonlyArray<RegExp> = [
  /at\s+\S+\s+\(.*:\d+:\d+\)/,        // V8 stack frame
  /at\s+Object\.\<anonymous\>/,          // anonymous stack frame
  /\/[a-zA-Z_][\w\-]*\/.*\.\w{1,5}:/,  // absolute file paths  (e.g. /src/foo.ts:12)
  /[A-Z]:\\.*\.\w{1,5}/,                // Windows file paths
  /node_modules\//,                      // dependency paths
  /ECONNREFUSED|ENOTFOUND|ETIMEDOUT/,   // raw syscall errors
  /SELECT\s|INSERT\s|UPDATE\s|DELETE\s/i, // SQL fragments
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
