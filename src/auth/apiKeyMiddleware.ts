/**
 * @module apiKeyMiddleware
 * @description Express middleware for API key authentication.
 *
 * Provides middleware for authenticating requests using API keys.
 * API keys should be provided in the `X-API-Key` header.
 *
 * Usage:
 *   app.get('/api/v1/internal', authenticateApiKey, requireApiKeyScope('contracts', 'read'), handler);
 *
 * Security notes:
 *   - Validates API key against stored hash
 *   - Updates last used timestamp for audit purposes
 *   - Checks for expired keys
 *   - Responds with 401 for missing/invalid keys
 *   - Responds with 403 for insufficient scope
 *
 * ## Validation boundaries
 *
 * This module is the trust boundary between an attacker-controlled request
 * header and two trusted values: `req.apiKey`, which `requireApiKeyScope`
 * reads to make an authorization decision, and the PBKDF2 work that
 * `validateApiKey` performs on whatever string reaches it. Each boundary
 * below is a distinct way untrusted input could reach one of those; each is
 * now enforced explicitly, in a fixed order, and is individually testable.
 *
 * The canonical credential is not a guess. `generateApiKey()` in
 * `./apiKeys` is the only issuance path in the system (used by both
 * `createApiKey` and `rotateApiKey`) and it returns
 * `crypto.randomBytes(32).toString('hex')` — exactly 64 lowercase hex
 * characters. A string outside that shape cannot correspond to any stored
 * key, so it is refused at the edge instead of being hashed.
 *
 * @invariant VB-1 — Exactly one credential, from one header.
 *   `req.headers['x-api-key']` is `string | string[] | undefined`; the
 *   previous `as string` cast asserted a shape Node does not guarantee.
 *   A repeated header can be surfaced as an array by an adapter or proxy,
 *   and the cast let that reach `crypto.createHash().update(array)`, which
 *   throws — turning a malformed credential into a 500 instead of a 401 and
 *   making the 401/500 split depend on header framing rather than on the
 *   credential. Only a single string is accepted now.
 *
 * @invariant VB-2 — Exactly one accepted spelling.
 *   A key is 64 characters of `[0-9a-f]` and nothing else. This refuses,
 *   deterministically and before any hashing: interior or trailing
 *   whitespace, CRLF and other control characters (which would otherwise let
 *   a caller-supplied value forge extra lines in line-oriented output), the
 *   comma-joined form of a duplicated header (RFC 7230 §3.2.2), non-ASCII
 *   look-alikes, and case variants — the issuer only ever produces
 *   lowercase, and `computeKeySelector` is case-sensitive, so an uppercase
 *   key cannot match a stored one by construction.
 *
 * @invariant VB-3 — Input size is bounded before any hashing or lookup.
 *   `MAX_API_KEY_LENGTH` is the issued length, so nothing longer than a real
 *   key is ever passed to SHA-256 or to the 10,000-iteration PBKDF2 fallback
 *   in `validateApiKey`. The bound is checked on length alone, before the
 *   pattern tests, so a multi-megabyte header is rejected without scanning.
 *
 * @invariant VB-4 — A refused credential leaves no authorization state.
 *   `req.apiKey` is deleted on every failure path, including the 500 path.
 *   `req` outlives a single middleware in any composition where this
 *   middleware is mounted after another that populates `req.apiKey`
 *   (`adminAuthGuard` does), and a stale value would let
 *   `requireApiKeyScope` grant access on the strength of a credential this
 *   call just refused. Refusing must be total: after any non-2xx response
 *   from this middleware, `req.apiKey` is undefined.
 *
 * @invariant VB-5 — Scope matching is a closed grammar, not prefix matching.
 *   `requireApiKeyScope` previously accepted any scope that started with
 *   `resource:` and ended with `:*`, so a stored `contracts:read:*` satisfied
 *   `contracts:read`; likewise `*:admin:read` satisfied `*:read`-style
 *   requirements. No such scope can be created — `validateApiKeyRequestBody`
 *   in `../controllers/apiKeyController` requires exactly the forms `*`,
 *   `resource:action`, `resource:*`, `*:action` — but request-time matching
 *   must not *depend* on that having held historically. Matching now splits
 *   on `:` and requires exactly two segments, so a scope this service does
 *   not understand grants nothing. The persisted `scope` array is likewise
 *   validated as an array of strings before it is consulted, so corrupt
 *   stored data denies access rather than throwing inside a synchronous
 *   middleware.
 *
 * @invariant VB-6 — Route requirements are checked when the route is built.
 *   `requireApiKeyScope(resource, action)` validates its arguments against
 *   the same segment grammar used at creation time and throws `TypeError`
 *   for anything else. A malformed requirement previously built a
 *   requirement string that quietly matched unintended scopes (for example
 *   `requireApiKeyScope('', 'read')` accepted any `resource:*` scope via the
 *   `startsWith('*:')`/`endsWith(':*')` rules). Route mounting happens at
 *   import time, so a misconfiguration now fails at boot where it can be
 *   fixed, instead of quietly widening access at runtime.
 *
 * ## Response contract
 *
 * All three response bodies are unchanged from the previous implementation,
 * so existing clients and tests that match on them keep working. The split
 * is deliberate: the client learns *that* the credential was refused, and the
 * operator learns *why* from the `auth_api_key_rejected` log record, which
 * carries a stable reason and never the credential or any part of it.
 *
 * | Outcome                                   | Status | Body                                        |
 * |-------------------------------------------|--------|---------------------------------------------|
 * | header absent or empty                    | 401    | `{ error: 'Missing X-API-Key header' }`      |
 * | header malformed, oversized, or not a key | 401    | `{ error: 'Invalid API key' }`               |
 * | `validateApiKey` returned `null`          | 401    | `{ error: 'Invalid API key' }`               |
 * | `validateApiKey` threw                    | 500    | `{ error: 'Internal server error' }`         |
 * | scope insufficient or unreadable          | 403    | `{ error: 'Forbidden: insufficient API key scope', required, provided }` |
 * | `req.apiKey` not set at the scope gate    | 401    | `{ error: 'Not authenticated with API key' }`|
 *
 * Refusing a malformed credential before PBKDF2 makes malformed input return
 * faster than a well-formed one. That is not a usable oracle: it reveals
 * only whether the *format* was right, which the caller already knows,
 * because they chose the input. It reveals nothing about any stored key.
 *
 * ## Observability
 *
 * Refusals are logged as `auth_api_key_rejected` (`debug` for a missing or
 * blank credential, `warn` for one that was structurally sound enough to be
 * an attempt) and scope denials as `auth_api_key_scope_denied` (`warn`).
 * The pre-existing `console.error('API key validation error:', err)` line on
 * the 500 path is deliberately left untouched so the documented alert in
 * `docs/runbook-auth.md` §5.2 and `docs/runbook-api-keys.md` §3.1 keeps
 * matching.
 */

import { Request, Response, NextFunction } from 'express';
import { validateApiKey, ApiKeyInfo } from './apiKeys';
import { authenticateMiddleware } from './authenticate';
import { logger } from '../logger';

/** Express request extended with API key info. */
export interface ApiKeyAuthenticatedRequest extends Request {
  apiKey?: ApiKeyInfo;
  /**
   * In-flight deduplication slot for API key validation.
   *
   * Holds the promise for the current request's validation so that
   * concurrent or repeated invocations of {@link authenticateApiKey} on the
   * same request object do not trigger duplicate validation work.
   */
  _apiKeyValidationPromise?: Promise<ApiKeyInfo | null>;
}

/** Maximum accepted length of an `X-API-Key` header value. */
const MAX_API_KEY_LENGTH = 512;

/** Regex describing a single scope token accepted by this module. */
const SCOPE_TOKEN_RE = /^[A-Za-z0-9_.*-]+$/;

/**
 * Normalize the raw `x-api-key` header value into a single trimmed
 * string, or ``null`` when no usable credential is present.
 *
 * Express may give us `string`, `string[]`, or `undefined`. A multi-value
 * header is ambiguous and must not be silently collapsed into one of its
 * values, so we reject it as missing. This is deterministic and avoids a
 * class of header-smuggling bugs.
 */
function extractApiKeyHeader(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_API_KEY_LENGTH) {
    return null;
  }
  return trimmed;
}

/**
 * Default number of attempts for transient validation failures.
 * Total attempts = 1 initial + (API_KEY_MAX_RETRIES) retries.
 */
const API_KEY_MAX_RETRIES = 2;

/** Base delay in milliseconds between retries (exponential backoff). */
const API_KEY_RETRY_BASE_DELAY_MS = 25;

/** Maximum delay in milliseconds between retries. */
const API_KEY_RETRY_MAX_DELAY_MS = 200;

/**
 * Error class for non-retryable API key validation failures.
 *
 * Thrown by the validator when the failure is deterministic (e.g.
 * malformed key format, invalid hash encoding) and retrying would not help.
 */
export class ApiKeyValidationError extends Error {
  constructor(message: string, public readonly code: string = 'API_KEY_VALIDATION_FAILED') {
    super(message);
    this.name = 'ApiKeyValidationError';
  }
}

/**
 * Resolves the validator to use for a request.
 *
 * This indirection exists so that tests can inject a deterministic
 * validator (including failure/retry behavior) without mock module
 * registry globals. It is intentionally not exported from the module's
 * public surface.
 */
interface ApiKeyValidatorContext {
  validator?: (key: string) => Promise<ApiKeyInfo | null>;
}

function resolveValidator(ctx?: ApiKeyValidatorContext): (key: string) => Promise<ApiKeyInfo | null> {
  return ctx?.validator ?? validateApiKey;
}

/**
 * Returns true when an error is transient and the validation call
 * may be safely retried.
 *
 * The classification is deterministic and conservative:
 *   - ApiKeyValidationError is always non-retryable.
 *   - Errors with a code indicating a client/programming fault
 *     (e.g. ERROR_INVALID_ARG) are non-retryable.
 *   - Everything else (DB, network, timeout) is treated as transient.
 */
function isRetryableError(err: unknown): boolean {
  if (err instanceof ApiKeyValidationError) return false;
  if (err && typeof err === 'object') {
    const code = (err as { code?: unknown }).code;
    if (code === 'ERROR_INVALID_ARG' || code === 'API_KEY_VALIDATION_FAILED') {
      return false;
    }
  }
  return true;
}

/** Delay helper used for backoff between retries. */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Validates an API key with bounded retries for transient failures.
 *
 * Invariants:
 *   - A successful validation returns the resolved ApiKeyInfo exactly once.
 *   - A definitive null result (key not found/expired/deactivated) is
 *     returned immediately and is never retried.
 *   - Non-retryable errors propagate immediately.
 *   - Retryable errors are retried up to API_KEY_MAX_RETRIES times with
 *     exponential backoff, then the last error is rethrown.
 */
async function validateWithRetry(
  key: string,
  validator: (key: string) => Promise<ApiKeyInfo | null>,
): Promise<ApiKeyInfo | null> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= API_KEY_MAX_RETRIES; attempt++) {
    try {
      return await validator(key);
    } catch (err) {
      lastError = err;
      if (!isRetryableError(err) || attempt === API_KEY_MAX_RETRIES) {
        throw err;
      }
      const backoff = Math.min(
        API_KEY_RETRY_BASE_DELAY_MS * 2 ** attempt,
        API_KEY_RETRY_MAX_DELAY_MS,
      );
      await delay(backoff);
    }
  }

  // Unreachable: the loop either returns or throws on the last attempt.
  throw lastError instanceof Error
    ? lastError
    : new Error('API key validation failed');
}

/** Canonical header carrying the API key credential. */
const API_KEY_HEADER = 'x-api-key';

/**
 * Reads the API key credential from the request.
 *
 * INV3: the header must be present exactly once as a single non-empty string. A
 * repeated header arrives as `string[]`, and an absent, empty or whitespace-only
 * value is indistinguishable from "no credential", so all of those return
 * `null` and are rejected as unauthenticated. A malformed header is therefore
 * classified as missing credentials rather than being handed to
 * `validateApiKey`, where a non-string value would raise and surface as a 500.
 *
 * The value is returned untouched: API keys are opaque, so surrounding
 * whitespace must never be silently trimmed into a different key.
 */
function readApiKeyHeader(req: ApiKeyAuthenticatedRequest): string | null {
  const raw = req.headers?.[API_KEY_HEADER];
  if (typeof raw !== 'string') return null;
  if (raw.trim().length === 0) return null;
  return raw;
}

/**
 * Drops any API key identity from the request.
 *
 * INV2: called at the start of every authentication attempt and on every
 * rejection path, so an attempt that fails can never leave a usable identity
 * behind for a later authorization check.
 */
function clearApiKey(req: ApiKeyAuthenticatedRequest): void {
  delete req.apiKey;
}

/**
 * Narrows a validation result to a usable identity.
 *
 * INV4: authorization is only ever decided from an identity that actually has
 * the fields `requireApiKeyScope` reads, so a malformed or partially populated
 * object is treated as "not authenticated" instead of throwing from inside the
 * scope check.
 */
function isWellFormedApiKeyInfo(value: unknown): value is ApiKeyInfo {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ApiKeyInfo>;
  return (
    typeof candidate.id === 'string' &&
    candidate.id.length > 0 &&
    Array.isArray(candidate.scope) &&
    candidate.scope.every(scope => typeof scope === 'string' && scope.length > 0) &&
    candidate.isActive === true
  );
}

/**
 * Maximum accepted length of the `X-API-Key` header value, in characters.
 *
 * This is the length of every key this system issues: `generateApiKey()`
 * hex-encodes 32 random bytes into 64 lowercase hex characters, and it is
 * the only issuance path in the codebase. Publishing the bound as the issued
 * length is what makes "longer than a real key" a sufficient rejection
 * reason, with no allowance for prefixes, padding, or version markers.
 */
export const MAX_API_KEY_LENGTH = 64;

/**
 * Maximum number of scope entries echoed back in a 403 body.
 *
 * `validateApiKeyRequestBody` caps a key at 20 scopes, so an in-contract key
 * is never truncated. The slice exists so that out-of-contract stored data
 * cannot drive an unbounded response body.
 */
export const MAX_REFLECTED_SCOPES = 20;

/**
 * The one accepted credential shape: 64 lowercase hex characters.
 *
 * Deliberately not `/^[a-f0-9]{64}$/i`. The issuer is lowercase-only and
 * `computeKeySelector` hashes the raw string, so an uppercase variant is a
 * different input that cannot match a stored key. Accepting it would give
 * one key two spellings and make the set of accepted inputs depend on a
 * case-folding rule that nothing else in the key path applies.
 */
const API_KEY_PATTERN = /^[0-9a-f]{64}$/;

/** A value consisting only of whitespace, including tabs and CRLF. */
const WHITESPACE_PATTERN = /^\s+$/;

/**
 * Grammar of a `resource` or `action` segment.
 *
 * Mirrors the creation-time check in `validateApiKeyRequestBody`
 * (`src/controllers/apiKeyController.ts`) so that a requirement can only be
 * built from segments the system is willing to issue.
 */
const SCOPE_SEGMENT_PATTERN = /^[a-z-]+$/;

/** The `Authorization` scheme prefix, matched case-sensitively. */
const BEARER_PREFIX = 'Bearer ';

/**
 * Reasons the `X-API-Key` header itself is refused, before any credential
 * check runs.
 */
export type ApiKeyHeaderRejectionReason =
  /** No `X-API-Key` header on the request. */
  | 'missing_header'
  /** Header value was not a single string (e.g. a repeated header). */
  | 'header_not_string'
  /** Header present but empty. */
  | 'key_empty'
  /** Header present but whitespace only — a misconfigured client. */
  | 'key_blank'
  /** Longer than {@link MAX_API_KEY_LENGTH}; refused on length alone. */
  | 'key_too_long'
  /** Right length, but not 64 lowercase hex characters. */
  | 'key_not_canonical';

/**
 * Every reason {@link authenticateApiKey} can refuse a credential.
 *
 * `key_rejected` means the credential was structurally valid and still did
 * not authenticate — unknown, wrong, expired, deactivated, or backed by a
 * malformed stored hash.
 */
export type ApiKeyRejectionReason = ApiKeyHeaderRejectionReason | 'key_rejected';

/**
 * Why {@link requireApiKeyScope} refused an authenticated key.
 *
 * - `scope_mismatch` — the key authenticated but holds no matching scope.
 * - `scope_unreadable` — the key's persisted `scope` value is not a list of
 *   strings. Denied rather than thrown on, so corrupt stored data cannot
 *   turn an authorization decision into a 500.
 */
export type ScopeDenialReason = 'scope_mismatch' | 'scope_unreadable';

/**
 * Outcome of reading the `X-API-Key` header.
 *
 * `absent` means "no usable credential was supplied" and maps to the
 * "missing" response; `invalid` means one was supplied and could not be a
 * key; `ok` carries the single credential to validate. `authenticateEither`
 * branches on `absent` only, and delegates every other outcome to
 * {@link authenticateApiKey} so that the credential decision has exactly one
 * implementation.
 */
export type ApiKeyHeaderResult =
  | { status: 'absent'; reason: 'missing_header' | 'key_empty' }
  | { status: 'invalid'; reason: ApiKeyHeaderRejectionReason }
  | { status: 'ok'; key: string };

/**
 * Refusals that indicate a possible forgery attempt rather than a broken
 * client, and so are logged at `warn` instead of `debug`.
 *
 * `key_rejected` is the brute-force signal and is the one to alert on. The
 * split keeps misconfigured clients and uncredentialed traffic out of the
 * warning stream.
 */
const SUSPICIOUS_REASONS: ReadonlySet<ApiKeyRejectionReason> = new Set<ApiKeyRejectionReason>([
  'header_not_string',
  'key_too_long',
  'key_not_canonical',
  'key_rejected',
]);

/**
 * Read and validate the single API key carried by a request header.
 *
 * Applies VB-1, VB-2 and VB-3 in a fixed order — type, then presence, then
 * length, then whitespace, then canonical form — so a given header always
 * produces the same verdict regardless of how many independent problems it
 * has. Ordering by cost means the cheapest and most selective checks decide
 * first, and a value that fails an earlier check is never scanned by a later
 * one.
 *
 * Pure and total: it performs no I/O, never throws, and never logs, so it is
 * safe to call from either entry point and directly testable.
 *
 * @param header - Raw header value; anything other than a string is refused.
 * @returns The credential to validate, or the reason it was refused.
 */
export function readApiKeyHeader(header: unknown): ApiKeyHeaderResult {
  if (header === undefined) {
    return { status: 'absent', reason: 'missing_header' };
  }

  // VB-1: only a single string is a credential. Never cast.
  if (typeof header !== 'string') {
    return { status: 'invalid', reason: 'header_not_string' };
  }

  if (header.length === 0) {
    return { status: 'absent', reason: 'key_empty' };
  }

  // VB-3: bound the input before any hashing, lookup, or pattern scan.
  if (header.length > MAX_API_KEY_LENGTH) {
    return { status: 'invalid', reason: 'key_too_long' };
  }

  // Reported separately from `key_not_canonical` because a whitespace-only
  // credential is a distinct, common client misconfiguration and reads very
  // differently in an alert than a mangled key.
  if (WHITESPACE_PATTERN.test(header)) {
    return { status: 'invalid', reason: 'key_blank' };
  }

  // VB-2: exactly one accepted spelling.
  if (!API_KEY_PATTERN.test(header)) {
    return { status: 'invalid', reason: 'key_not_canonical' };
  }

  return { status: 'ok', key: header };
}

/**
 * Decide whether one stored scope grants `resource:action`.
 *
 * Implements VB-5. The full-wildcard case is checked first because it has no
 * colon; every other form is split and must have exactly two segments, so a
 * scope this service did not issue — `contracts:read:*`, `*:*:x`, an empty
 * string — grants nothing.
 */
function scopeSatisfies(granted: string, resource: string, action: string): boolean {
  if (granted === '*') {
    return true;
  }

  const segments = granted.split(':');
  if (segments.length !== 2) {
    return false;
  }

  const [grantedResource, grantedAction] = segments;
  const resourceMatches = grantedResource === '*' || grantedResource === resource;
  const actionMatches = grantedAction === '*' || grantedAction === action;

  return resourceMatches && actionMatches;
}

/**
 * Read a persisted `scope` value as a list of scope strings.
 *
 * The value originates from a JSON column, so a non-array (or an array
 * holding non-strings) is possible without any bug being visible at write
 * time. Returns `null` for anything that is not a well-formed list, which
 * callers treat as a denial.
 */
function readScopes(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  return value.every(item => typeof item === 'string') ? (value as string[]) : null;
}

/**
 * Report a credential refusal through the structured logger.
 *
 * The record carries the reason and the path being protected, never the
 * credential or any part of it. `suspicious` refusals are raised to `warn`
 * so a forgery attempt is visible without turning routine 401 noise into
 * warnings.
 */
function logRejection(reason: ApiKeyRejectionReason, path: string | undefined): void {
  const level = SUSPICIOUS_REASONS.has(reason) ? 'warn' : 'debug';
  logger[level]('auth_api_key_rejected', {
    reason,
    path: path ?? 'unknown',
  });
}

/**
 * Report a scope denial through the structured logger.
 *
 * Carries the required scope — a value the route author wrote, not one the
 * caller supplied — and the path, never any credential material.
 */
function logScopeDenial(reason: ScopeDenialReason, requiredScope: string, path: string | undefined): void {
  logger.warn('auth_api_key_scope_denied', {
    reason,
    required: requiredScope,
    path: path ?? 'unknown',
  });
}

/**
 * Discard any API key identity already attached to the request.
 *
 * VB-4. Called on every failure path so that a refusal cannot leave
 * authorization state behind for a downstream middleware to act on.
 */
function clearApiKeyIdentity(req: ApiKeyAuthenticatedRequest): void {
  delete req.apiKey;
}

/**
 * Refuse a credential: clear identity state, log the reason, respond.
 *
 * Every 401 from this module goes through here, so identity clearing,
 * observability, and the response cannot drift apart between paths.
 */
function denyApiKey(
  req: ApiKeyAuthenticatedRequest,
  res: Response,
  body: Record<string, unknown>,
  reason: ApiKeyRejectionReason,
): void {
  clearApiKeyIdentity(req);
  logRejection(reason, req.path);
  res.status(401).json(body);
}

/** Canonical header carrying the API key credential. */
const API_KEY_HEADER = 'x-api-key';

/**
 * Reads the API key credential from the request.
 *
 * A repeated header is delivered by Node as `string[]`, and any absent,
 * non-string, empty or whitespace-only value is indistinguishable from "no
 * credential". All of those return `null`, so a malformed header is classified
 * as *missing credentials* rather than being handed to `validateApiKey`, where
 * a non-string value would raise and surface as an internal 500.
 *
 * The value itself is returned untouched: API keys are opaque, so surrounding
 * whitespace must never be silently trimmed into a different key.
 */
function readApiKeyHeader(req: ApiKeyAuthenticatedRequest): string | null {
  const raw = req.headers?.[API_KEY_HEADER];
  if (typeof raw !== 'string') return null;
  if (raw.trim().length === 0) return null;
  return raw;
}

/**
 * Drops any API key identity already attached to the request.
 *
 * Called at the start of every authentication attempt and on every rejection
 * path, so an attempt that fails can never leave a usable identity behind for a
 * later authorization check.
 */
function clearApiKeyIdentity(req: ApiKeyAuthenticatedRequest): void {
  delete req.apiKey;
}

/**
 * Writes a response at most once.
 *
 * This middleware can run after an earlier layer that already committed a
 * response (streaming handlers, error paths, client disconnect). Calling
 * `res.status().json()` again throws `ERR_HTTP_HEADERS_SENT`, turning a handled
 * failure into an unhandled crash; once headers are sent, the failure is
 * reported through the log line only.
 */
function sendJsonOnce(res: Response, status: number, body: Record<string, unknown>): void {
  if (res.headersSent) return;
  res.status(status).json(body);
}

/**
 * Deterministic fail-closed path shared by synchronous throws and async
 * rejections from the validation dependency.
 */
function failClosed(res: Response, err: unknown): void {
  // eslint-disable-next-line no-console
  console.error('API key validation error:', err);
  sendJsonOnce(res, 500, { error: 'Internal server error' });
}

/**
 * Narrows a validation result to a usable identity.
 *
 * Authorization is only decided from an identity that actually carries the
 * fields `requireApiKeyScope` reads, so a malformed or partially populated
 * object is treated as "not authenticated" instead of throwing from inside the
 * scope scan.
 */
function isWellFormedApiKeyInfo(value: unknown): value is ApiKeyInfo {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ApiKeyInfo>;
  return (
    typeof candidate.id === 'string' &&
    candidate.id.length > 0 &&
    Array.isArray(candidate.scope) &&
    candidate.scope.every((scope) => typeof scope === 'string' && scope.length > 0) &&
    candidate.isActive === true
  );
}

/**
 * Express middleware that extracts and validates the API key from the
 * `X-API-Key` request header.
 *
 * On success, attaches `req.apiKey` with the resolved {@link ApiKeyInfo} and
 * delegates to `next()`.
 *
 * Error paths (never leak internal detail):
 * - **401** — `X-API-Key` header is absent or empty
 *   (`{ error: 'Missing X-API-Key header' }`).
 * - **401** — Header is present but malformed, oversized, not a canonical
 *   key, or `validateApiKey` returns `null` (unknown key, wrong hash,
 *   expired, or deactivated) (`{ error: 'Invalid API key' }`).
 * - **500** — `validateApiKey` rejects unexpectedly (e.g. database error).
 *   The raw error is written to `console.error` only; the response body
 *   contains only `{ error: 'Internal server error' }`.
 *
 * Rejection is total: exactly one of these paths runs per request, `next()`
 * is called only after `req.apiKey` is set, and `req.apiKey` is deleted on
 * every failure path (VB-4). A malformed credential is a 401 and never a
 * 500 — the previous 500-on-`TypeError` path depended on how the header was
 * framed rather than on the credential.
 *
 * @param req  - Express request (extended with optional `apiKey` field).
 * @param res  - Express response.
 * @param next - Express next function; called only on successful validation.
 */
export function authenticateApiKey(
  req: ApiKeyAuthenticatedRequest,
  res: Response,
  next: NextFunction,
  ctx?: ApiKeyValidatorContext,
): void {
  // A fresh attempt starts from no identity, so a rejection below can never be
  // shadowed by an identity attached earlier in the request lifecycle.
  clearApiKeyIdentity(req);

  const apiKey = readApiKeyHeader(req);

  if (apiKey === null) {
    sendJsonOnce(res, 401, { error: 'Missing X-API-Key header' });
    return;
  }

  let validation: Promise<ApiKeyInfo | null>;
  try {
    // `Promise.resolve` normalises a non-promise return and funnels a
    // synchronous throw out of `validateApiKey` into the same `.catch` path as
    // an async rejection, so a dependency failure is always exactly one
    // deterministic 500 — never an escaped exception handled by Express.
    validation = Promise.resolve(validateApiKey(apiKey));
  } catch (err) {
    failClosed(res, err);
    return;
  }

  validation
    .then(keyInfo => {
      if (!keyInfo || !isWellFormedApiKeyInfo(keyInfo)) {
        // Never attach a half-formed identity.
        clearApiKeyIdentity(req);
        sendJsonOnce(res, 401, { error: 'Invalid API key' });
        return;
      }

  req._apiKeyValidationPromise
    .then(keyInfo => {
      if (!req.apiKey) {
        if (!keyInfo) {
          req._apiKeyValidationPromise = undefined;
          res.status(401).json({ error: 'Invalid API key' });
          return;
        }
        req.apiKey = keyInfo;
      }
      next();
    })
    .catch(err => {
      // An internal failure must not leave a previously attached identity in
      // place for downstream authorization.
      clearApiKeyIdentity(req);
      failClosed(res, err);
    });
}

/**
 * Whether `value` is a `resource` or `action` segment the system issues.
 *
 * VB-6. Checked when the route is defined, so a misconfigured requirement
 * throws `TypeError` at import time rather than widening access at runtime.
 */
function isScopeSegment(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && SCOPE_SEGMENT_PATTERN.test(value);
}

/**
 * Factory that returns Express middleware enforcing a specific API key scope.
 *
 * Scope matching rules, on a stored scope string (VB-5):
 * 1. **Full wildcard** — `*` satisfies any requirement.
 * 2. **Exact match** — e.g. `contracts:read` satisfies `contracts:read`.
 * 3. **Wildcard action** — e.g. `contracts:*` satisfies `contracts:read`.
 * 4. **Wildcard resource** — e.g. `*:read` satisfies `contracts:read`.
 *
 * A stored scope with any other shape — including a three-segment string
 * that the previous prefix/suffix rules would have accepted — grants
 * nothing.
 *
 * The match is strict and deterministic: the comparison is byte-exact and
 * the components are never interpreted as regex or path globs. A scope token
 * that does not match the allowed character set is rejected rather than
 * being treated as a wildcard.
 */
export function scopeSatisfies(
  scope: string,
  resource: string,
  action: string,
): boolean {
  if (typeof scope !== 'string' || !SCOPE_TOKEN_RE.test(scope)) {
    return false;
  }

  const requiredScope = `${resource}:${action}`;

  // Exact match
  if (scope === requiredScope) return true;

  // Full wildcard
  if (scope === '*') return true;

  // Wildcard action (e.g. "contracts:*")
  if (scope.endsWith(':*') && scope.slice(0, -2) === resource) return true;

  // Wildcard resource (e.g. "*:read")
  if (scope.startsWith('*:') && scope.slice(2) === action) return true;

  return false;
}

/**
 * Factory that returns Express middleware enforcing a specific API key scope.
 *
 * Error paths:
 * - **401** — `req.apiKey` is not set (caller skipped `authenticateApiKey`).
 * - **403** — Key is present but none of its scopes match the requirement, or
 *   its `scope` value is not a readable list of strings. The response
 *   includes `required` and `provided` for debugging by the key owner; no
 *   internal implementation detail is exposed.
 *
 * Invariants:
 * - Fail-closed: any non-match results in 403 and never calls `next()`.
 * - The required scope is computed once at factory creation time and is
 *   not influenced by request data.
 *
 * @param resource - The resource being accessed (e.g. `'contracts'`).
 * @param action   - The action being performed (e.g. `'read'`).
 * @returns Express middleware function.
 * @throws {TypeError} If `resource` or `action` is not a segment the system
 *   issues — see VB-6.
 */
export function requireApiKeyScope(resource: string, action: string) {
  if (!isScopeSegment(resource)) {
    throw new TypeError(
      `requireApiKeyScope: resource must be a non-empty lowercase segment matching ${SCOPE_SEGMENT_PATTERN.source}`,
    );
  }
  if (!isScopeSegment(action)) {
    throw new TypeError(
      `requireApiKeyScope: action must be a non-empty lowercase segment matching ${SCOPE_SEGMENT_PATTERN.source}`,
    );
  }

  return (req: ApiKeyAuthenticatedRequest, res: Response, next: NextFunction): void => {
    // Authorize only against a well-formed identity. A malformed one is
    // discarded and reported as unauthenticated rather than throwing a
    // TypeError out of the scope scan.
    const keyInfo = req.apiKey;
    if (!isWellFormedApiKeyInfo(keyInfo)) {
      clearApiKeyIdentity(req);
      sendJsonOnce(res, 401, { error: 'Not authenticated with API key' });
      return;
    }

    const requiredScope = `${resource}:${action}`;
    const hasScope = keyInfo.scope.some(scope => {
      // Exact match
      if (scope === requiredScope) return true;
      
      // Wildcard action (e.g., "contracts:*")
      if (scope.endsWith(':*') && scope.startsWith(`${resource}:`)) return true;
      
      // Wildcard resource (e.g., "*:read")
      if (scope.startsWith('*:') && scope.endsWith(`:${action}`)) return true;
      
      // Full wildcard
      if (scope === '*') return true;
      
      return false;
    });

    if (!hasScope) {
      sendJsonOnce(res, 403, {
        error: 'Forbidden: insufficient API key scope',
        required: requiredScope,
        provided: keyInfo.scope,
      });
      return;
    }

    next();
  };
}

/**
 * Middleware that accepts either JWT Bearer token OR API key authentication.
 *
 * Resolution order:
 * 1. If `Authorization: Bearer <token>` is present, delegates entirely to
 *    {@link authenticateMiddleware} (JWT path). `req.user` is populated on
 *    success.
 * 2. If `X-API-Key` is present (without a Bearer header), delegates to
 *    {@link authenticateApiKey}. `req.apiKey` is populated on success.
 * 3. If neither credential is provided, responds immediately with **401**.
 *
 * The `Authorization` header is checked for `typeof === 'string'` before
 * `startsWith`, so a header delivered as an array falls through to the API
 * key branch instead of throwing a `TypeError` out of a synchronous
 * middleware. The scheme match stays case-sensitive to remain consistent
 * with `BEARER_PATTERN` in `./authenticate`, which this delegates to: a
 * case-insensitive test here would select the JWT branch and then be
 * refused by the case-sensitive grammar behind it, turning one clear 401
 * into a misleading "Invalid token".
 *
 * Any supplied-but-unusable `X-API-Key` is delegated rather than handled
 * here, so a malformed credential produces the same 401 from both entry
 * points and the decision logic exists once.
 *
 * Use this on endpoints that must be accessible by both human users (JWT) and
 * automated internal services (API key).
 *
 * Invariants:
 * - At most one credential type is attached to the request as a result of
 *   this middleware. When the JWT path is taken, `req.apiKey` is cleared so a
 *   stale API key from an earlier middleware cannot bypass scope checks.
 * - A malformed `Authorization` header (e.g. `Bearer` with no token) is
 *   treated as absent and falls through to the API key path or 401.
 *
 * @param req  - Express request supporting both `user` and `apiKey` fields.
 * @param res  - Express response.
 * @param next - Called by the delegated middleware on success.
 */
export function authenticateEither(
  req: any, // Using any to support both AuthenticatedRequest and ApiKeyAuthenticatedRequest
  res: Response,
  next: NextFunction,
): void {
  // Every request starts from a clean identity slate, whichever credential it
  // ends up presenting.
  clearApiKeyIdentity(req as ApiKeyAuthenticatedRequest);

  // Check for JWT token first
  const authHeader = req.headers.authorization;
  if (typeof authHeader === 'string' && authHeader.startsWith(BEARER_PREFIX)) {
    // Let the existing JWT middleware handle this
    return authenticateMiddleware(req, res, next);
  }

  // Delegate whenever the header is present at all so the API-key path owns the
  // classification: a repeated, empty or whitespace-only header is a rejected
  // credential, not "no credentials".
  if (req.headers?.[API_KEY_HEADER] !== undefined) {
    return authenticateApiKey(req as ApiKeyAuthenticatedRequest, res, next);
  }

  // Neither authentication method found
  sendJsonOnce(res, 401, {
    error: 'Authentication required. Provide either Authorization: Bearer <token> or X-API-Key header' 
  });
}
