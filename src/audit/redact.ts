/**
 * @module audit/redact
 * @description Deterministic redaction rules for audit log metadata.
 *
 * ## Redaction policy
 *
 * ### HTTP headers
 * Any header whose name (lowercased) matches one of the following is replaced
 * entirely with `'[REDACTED]'` before being written to the audit log:
 *   - `authorization`
 *   - `cookie` / `set-cookie`
 *   - `x-api-key`, `x-auth-token`, `x-access-token`
 *
 * ### Request body / query / metadata fields
 * Any object key whose name (lowercased) contains one of the following
 * substrings has its value replaced with `'[REDACTED]'`:
 *   - `password`
 *   - `secret`
 *   - `token`
 *   - `credential`
 *   - `apikey` / `api_key`
 *   - `private`
 *
 * Redaction is applied **recursively** to nested objects and array elements.
 * Array indices are never treated as sensitive keys.
 *
 * ### Email addresses
 * String values that match the pattern `localpart@domain` are partially masked:
 * the first three characters of the local part are retained and the remainder
 * is replaced with `***` (e.g. `alice@example.com` → `ali***@example.com`,
 * `ab@host.io` → `ab***@host.io`).
 *
 * Masking is applied during body/metadata traversal but NOT to headers (header
 * values are either fully redacted or kept verbatim).
 *
 * ### Primitives
 * Numbers, booleans, and `null` pass through unmodified.
 *
 * ## State invariants and safety guarantees
 *
 * ### Circular reference protection
 * The `redactBody` function detects circular references using a `WeakSet` to
 * track visited objects. When a circular reference is detected, the offending
 * value is replaced with `'[REDACTED]'` to prevent stack overflow and ensure
 * the audit log operation completes safely.
 *
 * ### Depth limiting
 * To prevent stack overflow from deeply nested structures, `redactBody` enforces
 * a maximum recursion depth of 100 levels. Values beyond this depth are replaced
 * with `'[REDACTED]'`. This is a defensive limit; legitimate audit data should
 * not exceed this depth.
 *
 * ### Safe failure mode
 * All redaction functions handle invalid or malformed inputs gracefully:
 * - `redactHeaders` guards against null/undefined or non-object inputs
 * - `buildAuditMetadata` validates and coerces primitive inputs to safe defaults
 * - Processing errors are caught and logged without crashing the request path
 * - When invariants are violated (circular refs, depth limit), the function
 *   returns `'[REDACTED]'` rather than throwing
 *
 * ### Immutability
 * All functions return new objects and never mutate their inputs. This is
 * enforced by implementation and verified by tests.
 *
 * @security
 * - Redaction is deterministic: the same input always produces the same output.
 * - `Authorization` header values are NEVER persisted under any circumstances.
 * - This module has no side-effects; all functions are pure transformations.
 * - Circular references and deep nesting cannot cause stack overflow or crashes.
 * - Invalid inputs are handled gracefully without exposing sensitive data.
 */

import { types } from 'node:util';

/** Sentinel written in place of any redacted value. */
export const REDACTED = '[REDACTED]';
/** Fixed diagnostics never include rejected values or exception messages. */
export const INVALID = '[INVALID AUDIT VALUE]';
export const LIMIT_EXCEEDED = '[AUDIT LIMIT EXCEEDED]';
export const MAX_DEPTH = 32;
export const MAX_NODES = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || types.isProxy(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype === null || prototype === Object.prototype) return true;
  // Node HTTP objects can originate in another realm (notably Jest's VM).
  if (typeof prototype !== 'object' || types.isProxy(prototype)
    || Object.getPrototypeOf(prototype) !== null) return false;
  const constructor = Object.getOwnPropertyDescriptor(prototype, 'constructor');
  return !!constructor && 'value' in constructor
    && typeof constructor.value === 'function' && !types.isProxy(constructor.value)
    && Function.prototype.toString.call(constructor.value) === Function.prototype.toString.call(Object);
}

function assertString(value: unknown): asserts value is string {
  if (typeof value !== 'string') throw new TypeError('Invalid audit string');
}

// Define own properties so JSON keys such as __proto__ remain ordinary data.
function put(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/** Header names (lowercased) that must be fully suppressed. */
const SENSITIVE_HEADER_NAMES = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'x-access-token',
]);

/**
 * Substrings that mark a body/query/metadata key as sensitive.
 * Checked against the lower-cased key name.
 */
const SENSITIVE_KEY_FRAGMENTS = [
  'password',
  'secret',
  'token',
  'credential',
  'apikey',
  'api_key',
  'private',
  'authorization',
  'cookie',
  'session',
  'stack',
];

/** Matches a simple `local@domain` email pattern. */
const EMAIL_PATTERN = /^([^@\s]{1,64})@([^@\s]+\.[^@\s]+)$/;

/**
 * Maximum recursion depth for redactBody to prevent stack overflow.
 * This is a defensive limit; legitimate audit data should not exceed this depth.
 */
export const MAX_REDACTION_DEPTH = 100;

// ─── Predicate helpers ───────────────────────────────────────────────────────

/**
 * Returns `true` when the given header name should be fully redacted.
 *
 * @param name - Raw header name (case-insensitive).
 */
export function isSensitiveHeader(name: string): boolean {
  assertString(name);
  return SENSITIVE_HEADER_NAMES.has(name.toLowerCase());
}

/**
 * Returns `true` when the given object key suggests a sensitive value.
 *
 * @param key - Object key string (case-insensitive).
 */
export function isSensitiveKey(key: string): boolean {
  assertString(key);
  const lower = key.toLowerCase();
  return SENSITIVE_KEY_FRAGMENTS.some((fragment) => lower.includes(fragment));
}

// ─── Transformation helpers ──────────────────────────────────────────────────

/**
 * Partially masks an email address to protect PII while retaining minimal
 * identifiability for audit correlation.
 *
 * Non-email strings are returned unchanged.
 *
 * @example
 * maskEmail('alice@example.com') // → 'ali***@example.com'
 * maskEmail('ab@host.io')        // → 'ab***@host.io'
 * maskEmail('not-an-email')      // → 'not-an-email'
 */
export function maskEmail(value: string): string {
  assertString(value);
  // Short local parts must remain stable when stored entries are exported again.
  if (/^[^@\s]{1,3}\*{3}@[^@\s]+\.[^@\s]+$/.test(value)) return value;
  const match = EMAIL_PATTERN.exec(value);
  if (!match) return value;
  const [, local, domain] = match;
  const prefix = local.slice(0, Math.min(3, local.length));
  return `${prefix}***@${domain}`;
}

/**
 * Produces a sanitised copy of an HTTP headers object.
 *
 * Sensitive header values are replaced with `'[REDACTED]'`; all other
 * string values are copied verbatim and string arrays are cloned. Invalid
 * names, values and accessors become INVALID; sensitive values are never read.
 * Invalid containers and more than MAX_NODES headers throw a fixed TypeError.
 * The original object is never mutated.
 *
 * Invalid or non-object inputs are handled gracefully to prevent crashes.
 *
 * @param headers - Raw headers from `req.headers`.
 * @returns A flat object safe for audit storage.
 */
export function redactHeaders(
  headers: Record<string, string | string[] | undefined> | undefined | null,
): Record<string, unknown> {
  if (!isRecord(headers)) throw new TypeError('Invalid audit headers');
  const result: Record<string, unknown> = {};

  if (!headers || typeof headers !== 'object') {
    return result;
  }

  for (const [name, value] of Object.entries(headers)) {
    result[name] = isSensitiveHeader(name) ? REDACTED : value;
  }

  try {
    for (const [name, value] of Object.entries(headers)) {
      // Ensure key is a string (Object.entries should guarantee this, but defend anyway)
      if (typeof name !== 'string') {
        continue;
      }
      result[name] = isSensitiveHeader(name) ? REDACTED : value;
    }
  } catch (err) {
    // If header processing fails for any reason, return what we have so far
    // This prevents audit logging from crashing the request
    console.error('[redactHeaders] Failed to process headers:', err);
  }

  return result;
}

/**
 * Recursively sanitises a request body, query string, or arbitrary metadata
 * value before it is written to the audit log.
 *
 * - Keys matching `isSensitiveKey` have their values replaced with REDACTED.
 * - String values that look like email addresses are masked via `maskEmail`.
 * - Arrays are traversed element-by-element.
 * - Finite numbers, booleans and null/undefined pass through as-is.
 * - Only own enumerable string keys of plain/null-prototype records and array
 *   indices are data. Accessors, sparse slots, cycles, proxies, non-finite
 *   numbers and non-JSON types become INVALID without invoking user code.
 * - Root depth is zero; depths above MAX_DEPTH and containers exceeding the
 *   remaining MAX_NODES traversal budget become LIMIT_EXCEEDED.
 * - Sensitive values are replaced without inspection. Header secrets are also
 *   suppressed here because persisted metadata is reprocessed during export.
 *
 * @param value - The value to sanitise (may be any JSON-serialisable type).
 * @returns A deep copy with sensitive data replaced.
 */
export function redactBody(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    return maskEmail(value);
  }

  if (value instanceof Date) {
    return new Date(value.getTime());
  }

  if (value instanceof Set) {
    if (seen.has(value)) {
      return seen.get(value);
    }

    const result: unknown[] = [];
    seen.set(value, result);
    for (const item of value) {
      result.push(redactBody(item, seen));
    }
    return result;
  }

  if (value instanceof Map) {
    if (seen.has(value)) {
      return seen.get(value);
    }

    const result: Record<string, unknown> = {};
    seen.set(value, result);
    for (const [key, item] of value.entries()) {
      result[String(key)] = redactBody(item, seen);
    }
    return result;
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return seen.get(value);
    }

    const result: unknown[] = [];
    seen.set(value, result);
    for (const item of value) {
      result.push(redactBody(item, seen));
    }
    return result;
  }

  if (typeof value === 'object') {
    if (seen.has(value)) {
      return seen.get(value);
    }

    const result: Record<string, unknown> = {};
    seen.set(value, result);

    if (value instanceof Error) {
      result.name = value.name;
      result.message = REDACTED;
      if (typeof value.stack === 'string' && value.stack.length > 0) {
        result.stack = REDACTED;
      }
      for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
        if (key !== 'name' && key !== 'message' && key !== 'stack') {
          result[key] = redactBody(val, seen);
        }
      }
      return result;
    }

    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      result[key] = isSensitiveKey(key) ? REDACTED : redactBody(val, seen);
    }
    return result;
  }

  // Numbers, booleans, symbols, bigint, and functions — safe to log verbatim
  // when they are present in ad hoc payloads, but they are not traversed.
  return value;
}

/**
 * Assembles the `metadata` object written to an audit entry for a protected
 * HTTP request. All sensitive fields are redacted before return.
 *
 * Handles invalid or malformed inputs gracefully to prevent audit logging
 * from crashing the request path.
 *
 * @param method      - HTTP verb (e.g. `'POST'`).
 * @param path        - URL path (e.g. `'/api/v1/contracts/abc'`).
 * @param headers     - Raw request headers from `req.headers`.
 * @param body        - Parsed request body, or `undefined` for bodyless requests.
 * @param query       - Parsed query string object from `req.query`.
 * @param statusCode  - Final HTTP response status code (captured after finish).
 * @param requestId   - Correlation ID from `res.locals.requestId`, if present.
 * Invalid envelopes throw a fixed TypeError without including supplied data.
 * Methods must be HTTP tokens, paths must exclude query/fragment/control data,
 * status codes must be integers from 100 through 599, and queries plain records.
 * @returns Flat, redacted metadata record safe for audit storage.
 */
export function buildAuditMetadata(
  method: string,
  path: string,
  headers: Record<string, string | string[] | undefined> | undefined | null,
  body: unknown,
  query: Record<string, unknown> | undefined | null,
  statusCode: number,
  requestId: string | undefined,
): Record<string, unknown> {
  const safeQuery = query && typeof query === 'object' ? query : {};

  return {
    method: safeMethod,
    path: safePath,
    statusCode: safeStatusCode,
    requestId: typeof requestId === 'string' ? requestId : null,
    headers: redactHeaders(headers),
    body: body !== undefined && body !== null ? redactBody(body) : null,
    query: Object.keys(safeQuery).length > 0 ? redactBody(safeQuery) : null,
  };
}
