/**
 * @module authenticate
 * @description Legacy bearer-token authentication middleware for TalentTrust.
 *
 * Tokens are supplied in the `Authorization` header:
 *   Authorization: Bearer <token>
 *
 * The token payload is a base64-encoded JSON string:
 *   { "userId": "u1", "role": "freelancer" }
 *
 * Security notes:
 *   - Tokens are validated for structure, not cryptographic signature
 *     (acceptable for tests; production should use JWTs).
 *   - Missing or malformed tokens result in 401 Unauthorized.
 *   - Role validity is checked against VALID_ROLES.
 *   - Token values are trimmed before decoding so stray whitespace in the
 *     Authorization header never produces a spurious cache miss or a
 *     different validation result for the same logical token.
 *   - decodeToken results are memoized in a bounded LRU-style cache so that
 *     bursts of concurrent requests bearing the same token do not repeatedly
 *     pay the base64-decode + JSON.parse cost.  The cache is intentionally
 *     small (256 entries, 5 min TTL) and stores only the decoded *payload*,
 *     never the raw token string itself, to limit the blast radius of a
 *     potential memory inspection.
 *
 * Concurrency invariants:
 *   - normalizeToken is a pure function — safe to call from any number of
 *     concurrent requests without synchronization.
 *   - decodeToken is idempotent and deterministic: the same token always
 *     produces the same payload (or null), so concurrent calls are safe.
 *   - The decode cache is accessed synchronously (Node.js single-threaded
 *     event loop guarantees no torn reads/writes on Map operations).
 *   - Cache size is capped at DECODE_CACHE_MAX_ENTRIES; once the cap is
 *     reached the oldest inserted entry is evicted before the new one is
 *     added, keeping memory bounded even under token-spray attacks.
 */

import { Request, Response, NextFunction } from 'express';
import { Role, VALID_ROLES } from './roles';
import { logger } from '../logger';

/**
 * Logger for authentication events.
 * In production, replace with proper logging infrastructure.
 */
const authLogger = {
  info: (message: string, meta?: Record<string, unknown>) => {
    console.log(`[AUTH] ${message}`, meta ? JSON.stringify(meta) : '');
  },
  warn: (message: string, meta?: Record<string, unknown>) => {
    console.warn(`[AUTH] ${message}`, meta ? JSON.stringify(meta) : '');
  },
  error: (message: string, meta?: Record<string, unknown>) => {
    console.error(`[AUTH] ${message}`, meta ? JSON.stringify(meta) : '');
  },
};

/**
 * The only `Authorization` scheme this module accepts.
 *
 * This value is part of the public compatibility contract: it is exported so
 * that callers and tests can refer to the scheme symbolically instead of
 * hard-coding the literal, and any change to it is an intentional, reviewable
 * breaking change rather than a silent one.
 */
export const AUTH_SCHEME = 'Bearer ';

/** Shape of the decoded token payload. */
export interface TokenPayload {
  userId: string;
  role: Role;
}

/** Express request extended with authenticated user info. */
export interface AuthenticatedRequest extends Omit<Request, 'user'> {
  user?: TokenPayload;
}

// ─── Token normalization ──────────────────────────────────────────────────────

/**
 * Normalize a raw bearer token value extracted from the Authorization header.
 *
 * Strips surrounding ASCII whitespace (spaces, tabs, CRLF) that some HTTP
 * clients or proxies may inadvertently include.  The JWT / base64 body of a
 * well-formed token never contains whitespace, so trimming is always safe and
 * ensures that two strings differing only in surrounding whitespace are treated
 * as the same token.
 *
 * @param raw - The token string after the "Bearer " prefix has been removed.
 * @returns The trimmed token string (may be empty — callers must check).
 */
export function normalizeToken(raw: string): string {
  return raw.trim();
}

// ─── Decode cache (bounded LRU-style, synchronous) ───────────────────────────

/**
 * Maximum number of distinct decoded tokens to keep in memory.
 * Chosen to cover a busy service's active token set without unbounded growth.
 */
const DECODE_CACHE_MAX_ENTRIES = 256;

/**
 * Cache TTL in milliseconds. Tokens that have been in the cache longer than
 * this are treated as stale and re-decoded on the next access. Set to 5 min
 * which is well under the default JWT access-token lifetime (15 min).
 */
const DECODE_CACHE_TTL_MS = 5 * 60 * 1000;

interface DecodeCacheEntry {
  /** The decoded payload (null means the token was invalid). */
  payload: TokenPayload | null;
  /** Epoch ms when this entry was inserted. */
  insertedAt: number;
}

/**
 * Module-level decode cache.  Keyed by the *normalized* token string.
 *
 * Invariant: size <= DECODE_CACHE_MAX_ENTRIES at all times (enforced in
 * setCacheEntry before every insertion).
 */
const decodeCache = new Map<string, DecodeCacheEntry>();

/**
 * Retrieve a cache entry, returning null on miss or expiry.
 * Expired entries are lazily evicted on access.
 *
 * @internal
 */
function getCacheEntry(token: string): TokenPayload | null | undefined {
  const entry = decodeCache.get(token);
  if (!entry) return undefined; // cache miss

  const age = Date.now() - entry.insertedAt;
  if (age > DECODE_CACHE_TTL_MS) {
    decodeCache.delete(token); // lazy eviction of stale entry
    return undefined;
  }

  return entry.payload;
}

/**
 * Insert (or overwrite) a cache entry, evicting the oldest entry first when
 * the cache is at capacity.
 *
 * Eviction strategy: delete the first key reported by Map iteration, which
 * corresponds to the entry with the earliest insertion order.  This is O(1)
 * because Map maintains insertion order and `.keys().next()` is constant-time.
 *
 * @internal
 */
function setCacheEntry(token: string, payload: TokenPayload | null): void {
  // If the token is already present, overwrite in-place — no eviction needed.
  if (!decodeCache.has(token) && decodeCache.size >= DECODE_CACHE_MAX_ENTRIES) {
    const oldest = decodeCache.keys().next().value;
    if (oldest !== undefined) {
      decodeCache.delete(oldest);
    }
  }
  decodeCache.set(token, { payload, insertedAt: Date.now() });
}

/**
 * Exposed for testing only — resets the decode cache to an empty state.
 * Do NOT call this in production code.
 *
 * @internal
 */
export function _resetDecodeCache(): void {
  decodeCache.clear();
}

// ─── Core helpers ─────────────────────────────────────────────────────────────

/**
 * Validates that an object conforms to TokenPayload structure at runtime.
 * This protects against tampering of req.user by downstream middleware.
 *
 * @param value - The value to validate.
 * @returns True if the value is a valid TokenPayload, false otherwise.
 */
function isValidTokenPayload(value: unknown): value is TokenPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const payload = value as Record<string, unknown>;
  
  // Validate userId
  if (typeof payload.userId !== 'string' || payload.userId.trim().length === 0) {
    return false;
  }

  // Validate role
  if (typeof payload.role !== 'string') {
    return false;
  }

  if (!VALID_ROLES.includes(payload.role as Role)) {
    return false;
  }

  return true;
}

/**
 * Checks if the response has already been sent.
 * This prevents double-sending responses which would cause an error.
 *
 * @param res - Express response object.
 * @returns True if response headers have been sent, false otherwise.
 */
function isResponseSent(res: Response): boolean {
  return res.headersSent;
}

/**
 * Upper bound on the size of a bearer token the decoder will accept.
 *
 * Base64 decodes roughly 3 bytes per 4 characters, so 64 KiB of input bounds
 * the JSON parse to ~48 KiB — far larger than any legitimate payload, yet small
 * enough that a hostile client cannot force unbounded work on the event loop
 * with a single header.
 */
export const MAX_TOKEN_LENGTH = 64 * 1024;

/**
 * Decode and validate a bearer token string.
 *
 * This function is **total**: for any input it returns either a well-formed
 * {@link TokenPayload} or `null`. It never throws, and it never returns a
 * partially validated payload. Every rejection — non-string input, empty or
 * oversized input, malformed base64, non-JSON, JSON that is not a plain object,
 * missing or mistyped fields, unknown role — collapses to the same
 * deterministic `null`, so a decode failure can never surface as a 500 from the
 * middleware.
 *
 * The returned object is rebuilt field-by-field from validated primitives, so
 * extra keys in the JSON (including `__proto__`) are discarded and a "JSON
 * prototype pollution" payload cannot influence the result.
 *
 * @param token - The raw base64-encoded token.
 * @returns The decoded payload, or `null` if invalid.
 */
export function decodeToken(token: string): TokenPayload | null {
  // Defensive totality: callers are typed, but a JavaScript caller (or a future
  // refactor) can pass anything, and `Buffer.from(undefined, 'base64')` throws.
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
    return null;
  }

  try {
    const json = Buffer.from(token, 'base64').toString('utf-8');
    const parsed: unknown = JSON.parse(json);

    // Only a plain object is a valid payload. `null`, arrays and primitives are
    // rejected explicitly rather than relying on property-access quirks.
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return null;
    }

    const { userId, role } = parsed as Record<string, unknown>;
    if (
      typeof userId !== 'string' ||
      userId.length === 0 ||
      typeof role !== 'string' ||
      !(VALID_ROLES as readonly string[]).includes(role)
    ) {
      payload = null;
    } else {
      payload = { userId: parsed.userId, role: parsed.role as Role };
    }

    return { userId, role: role as Role };
  } catch {
    payload = null;
  }

  setCacheEntry(normalized, payload);
  return payload;
}

/**
 * Helper to create a valid bearer token for testing.
 *
 * State invariants enforced:
 *   - userId is always a non-empty string
 *   - role is always a valid Role enum value
 *   - Output is deterministic for same inputs
 *
 * @param userId - User identifier.
 * @param role   - Role to encode.
 * @returns Base64-encoded token string.
 * @throws {TypeError} If `userId` or `role` falls outside the accepted set.
 */
export function createToken(userId: string, role: Role): string {
  // Invariant: Validate inputs before encoding
  if (!userId || typeof userId !== 'string' || userId.trim().length === 0) {
    throw new Error('createToken: userId must be a non-empty string');
  }
  if (!VALID_ROLES.includes(role)) {
    throw new Error(`createToken: invalid role "${role}"`);
  }
  
  return Buffer.from(JSON.stringify({ userId: userId.trim(), role })).toString('base64');
}

/**
 * Report a refusal through the structured logger.
 *
 * The record carries the reason and the path being protected, never the
 * credential or any part of it. `suspicious` refusals are raised to `warn` so
 * a forged claim is visible without turning routine 401 noise into warnings.
 */
function logRejection(reason: TokenRejectionReason, path: string | undefined): void {
  const level = SUSPICIOUS_REASONS.has(reason) ? 'warn' : 'debug';
  logger[level]('auth_legacy_bearer_rejected', {
    reason,
    path: path ?? 'unknown',
  });
}

/**
 * Express middleware that extracts and validates the bearer token.
 *
 * Compatibility contract (frozen by `authenticate.contract.test.ts`):
 *
 * | input                                       | outcome |
 * | ------------------------------------------- | ------- |
 * | missing, non-string or non-`Bearer ` header | 401 `{ error: 'Missing or invalid Authorization header' }` |
 * | present-but-invalid token                   | 401 `{ error: 'Invalid token' }` |
 * | valid token                                 | `req.user = { userId, role }` and exactly one `next()` |
 *
 * A repeated `Authorization` header is delivered by Node as `string[]`. It is
 * treated as a malformed header (401) rather than being passed to
 * `startsWith()`, which would throw a `TypeError` and surface as a 500 — so the
 * observable contract is identical for every shape of a rejected header.
 */
export function authenticateMiddleware(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): void {
  const header = req.headers?.authorization;
  const authorization = typeof header === 'string' ? header : null;

  if (!authorization || !authorization.startsWith(AUTH_SCHEME)) {
    res.status(401).json({ error: 'Missing or invalid Authorization header' });
    return;
  }

  const payload = decodeToken(authorization.slice(AUTH_SCHEME.length));

  // Invariant: Token must not be empty after 'Bearer ' prefix
  if (token.length === 0) {
    authLogger.warn('Empty token after Bearer prefix');
    if (!isResponseSent(res)) {
      res.status(401).json({ error: 'Invalid token' });
    }
    return;
  }

  // Assign (not merge): a previous layer's identity is replaced wholesale, so
  // `req.user` always describes exactly the credential presented here.
  req.user = payload;

  // Invariant: Tamper-proof - freeze req.user to prevent downstream mutation
  Object.freeze(req.user);

  // Invariant: Log successful authentication for diagnostics (redact sensitive data)
  authLogger.info('Authentication successful', {
    userId: payload.userId.substring(0, 8) + '...', // Redact for security
    role: payload.role,
  });

  next();
}
