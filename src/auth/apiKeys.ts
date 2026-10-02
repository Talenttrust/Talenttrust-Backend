/**
 * @module apiKeys
 * @description API key authentication utilities for TalentTrust.
 *
 * Provides secure API key generation, validation, and management.
 * API keys are hashed at rest using PBKDF2 (SHA-256, 10,000 iterations) with a salt.
 *
 * API keys are expected in the `X-API-Key` header:
 *   X-API-Key: <api-key>
 *
 * Security notes:
 *   - API keys are cryptographically generated using random bytes
 *   - Keys are hashed at rest using PBKDF2 (SHA-256, 10,000 iterations) with a unique salt
 *   - Each key has optional expiration and scoping
 *   - Keys can be rotated and deactivated
 *   - Last usage is tracked for audit purposes
 *
 * Failure recovery invariants:
 *   - validateApiKey always returns null on any DB error (fail closed)
 *   - createApiKey, rotateApiKey, deactivateApiKey throw ApiKeyError on DB failure
 *   - Expiry is checked BEFORE last_used_at is written
 *   - Legacy key fallback verifies identity before returning a match
 *   - Raw API key values are never logged; selector is used instead
 * Concurrency invariants:
 *   - Creation, rotation, and deactivation are serialized per key via an
 *     in-process mutex so concurrent calls cannot interleave their read
 *     modify-write sequences and produce stale or inconsistent state.
 *   - Validation is idempotent: repeated or concurrent calls for the same
 *     key converge on the same result and cannot double-deactivate or double-
 *     backfill.
 *   - Cache invalidation happens after the authoritative write commits,
 *     so a concurrent reader cannot observe a new cache entry for a stale
 *     row.
 */

import * as crypto from 'node:crypto';
import { ApiKey } from '../database/schema';
import { database } from '../database';
import { AuthCache } from './authCache';
import { validateEnv } from '../config/env.schema';
import { logger } from '../utils/logger';

/**
 * Validation error class for API key operations.
 */
export class ApiKeyValidationError extends Error {
  constructor(
    message: string,
    public readonly field: string,
    public readonly code: string
  ) {
    super(message);
    this.name = 'ApiKeyValidationError';
  }
}

/**
 * Validation constants defining boundaries for API key inputs.
 */
export const VALIDATION_RULES = {
  API_KEY: {
    LENGTH: 64, // 32 bytes in hex = 64 characters
    PATTERN: /^[a-f0-9]{64}$/i,
  },
  NAME: {
    MIN_LENGTH: 1,
    MAX_LENGTH: 255,
    PATTERN: /^[a-zA-Z0-9\s\-_]+$/,
  },
  SCOPE: {
    MIN_ITEMS: 1,
    MAX_ITEMS: 50,
    ITEM_MIN_LENGTH: 1,
    ITEM_MAX_LENGTH: 100,
    ITEM_PATTERN: /^[a-zA-Z0-9:\-_\.]+$/,
  },
  USER_ID: {
    MIN_LENGTH: 1,
    MAX_LENGTH: 255,
    PATTERN: /^[a-zA-Z0-9\-_]+$/,
  },
  KEY_SELECTOR: {
    LENGTH: 64, // SHA-256 hex = 64 characters
    PATTERN: /^[a-f0-9]{64}$/i,
  },
  SALT_HASH: {
    SALT_LENGTH: 32, // 16 bytes in hex
    HASH_LENGTH: 128, // 64 bytes in hex
    PATTERN: /^[a-f0-9]{32}:[a-f0-9]{128}$/i,
  },
} as const;

// Initialize cache with config-driven settings
let authCache: AuthCache | null = null;

/**
 * Get or initialize the auth cache instance.
 */
export function getAuthCache(): AuthCache {
  if (!authCache) {
    const env = validateEnv();
    authCache = new AuthCache({
      ttlMs: env.AUTH_CACHE_TTL_MS,
      maxEntries: env.AUTH_CACHE_MAX_ENTRIES,
    });
  }
  return authCache;
}

/**
 * Reset the auth cache instance (primarily for testing).
 */
export function resetAuthCache(): void {
  authCache = null;
}

/**
 * Install a specific auth cache instance (test seam).
 *
 * Mirrors `setMetadataStore` in `src/database/sqliteStore.ts`: tests need a
 * cache with deterministic TTL/capacity and a direct handle to assert on,
 * without reaching through the lazily-initialised environment-backed singleton.
 */
export function setAuthCache(cache: AuthCache | null): void {
  authCache = cache;
}

// Fix 3: Typed error class for API key operation failures (additive export)
export class ApiKeyError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'ApiKeyError';
  }
}

export interface ApiKeyInfo {
  id: string;
  name: string;
  scope: string[];
  createdBy: string;
  createdAt: Date;
  expiresAt?: Date;
  isActive: boolean;
}

export interface ApiKeyRequest {
  name: string;
  scope: string[];
  createdBy: string;
  expiresAt?: Date;
}

/**
 * Validates an API key format.
 * 
 * Validation boundaries:
 *   - VALID: 64 hex characters (a-f, 0-9, case-insensitive)
 *   - INVALID: Wrong length, non-hex characters, null, undefined, non-string
 * 
 * @param apiKey - The API key to validate
 * @throws ApiKeyValidationError if invalid
 */
export function validateApiKeyFormat(apiKey: unknown): asserts apiKey is string {
  if (typeof apiKey !== 'string') {
    throw new ApiKeyValidationError(
      'API key must be a string',
      'apiKey',
      'INVALID_TYPE'
    );
  }

  if (apiKey.length !== VALIDATION_RULES.API_KEY.LENGTH) {
    throw new ApiKeyValidationError(
      `API key must be exactly ${VALIDATION_RULES.API_KEY.LENGTH} characters`,
      'apiKey',
      'INVALID_LENGTH'
    );
  }

  if (!VALIDATION_RULES.API_KEY.PATTERN.test(apiKey)) {
    throw new ApiKeyValidationError(
      'API key must contain only hexadecimal characters',
      'apiKey',
      'INVALID_FORMAT'
    );
  }
}

/**
 * Validates an API key name.
 * 
 * Validation boundaries:
 *   - VALID: 1-255 characters, alphanumeric + spaces, hyphens, underscores
 *   - INVALID: Empty, too long, contains special characters, null, non-string
 * 
 * @param name - The name to validate
 * @throws ApiKeyValidationError if invalid
 */
export function validateApiKeyName(name: unknown): asserts name is string {
  if (typeof name !== 'string') {
    throw new ApiKeyValidationError(
      'API key name must be a string',
      'name',
      'INVALID_TYPE'
    );
  }

  const trimmed = name.trim();

  if (trimmed.length < VALIDATION_RULES.NAME.MIN_LENGTH) {
    throw new ApiKeyValidationError(
      'API key name cannot be empty',
      'name',
      'EMPTY_NAME'
    );
  }

  if (trimmed.length > VALIDATION_RULES.NAME.MAX_LENGTH) {
    throw new ApiKeyValidationError(
      `API key name must not exceed ${VALIDATION_RULES.NAME.MAX_LENGTH} characters`,
      'name',
      'NAME_TOO_LONG'
    );
  }

  if (!VALIDATION_RULES.NAME.PATTERN.test(trimmed)) {
    throw new ApiKeyValidationError(
      'API key name can only contain alphanumeric characters, spaces, hyphens, and underscores',
      'name',
      'INVALID_CHARACTERS'
    );
  }
}

/**
 * Validates an API key scope array.
 * 
 * Validation boundaries:
 *   - VALID: Array of 1-50 strings, each 1-100 chars, matching pattern
 *   - INVALID: Empty array, too many items, invalid item format, null, non-array
 *   - DUPLICATE: Contains duplicate scope values
 * 
 * @param scope - The scope array to validate
 * @throws ApiKeyValidationError if invalid
 */
export function validateApiKeyScope(scope: unknown): asserts scope is string[] {
  if (!Array.isArray(scope)) {
    throw new ApiKeyValidationError(
      'API key scope must be an array',
      'scope',
      'INVALID_TYPE'
    );
  }

  if (scope.length < VALIDATION_RULES.SCOPE.MIN_ITEMS) {
    throw new ApiKeyValidationError(
      'API key scope must contain at least one item',
      'scope',
      'EMPTY_SCOPE'
    );
  }

  if (scope.length > VALIDATION_RULES.SCOPE.MAX_ITEMS) {
    throw new ApiKeyValidationError(
      `API key scope must not exceed ${VALIDATION_RULES.SCOPE.MAX_ITEMS} items`,
      'scope',
      'SCOPE_TOO_LARGE'
    );
  }

  // Check for duplicates
  const uniqueScopes = new Set(scope);
  if (uniqueScopes.size !== scope.length) {
    throw new ApiKeyValidationError(
      'API key scope contains duplicate values',
      'scope',
      'DUPLICATE_SCOPE'
    );
  }

  // Validate each scope item
  scope.forEach((item, index) => {
    if (typeof item !== 'string') {
      throw new ApiKeyValidationError(
        `Scope item at index ${index} must be a string`,
        'scope',
        'INVALID_SCOPE_ITEM_TYPE'
      );
    }

    const trimmed = item.trim();

    if (trimmed.length < VALIDATION_RULES.SCOPE.ITEM_MIN_LENGTH) {
      throw new ApiKeyValidationError(
        `Scope item at index ${index} cannot be empty`,
        'scope',
        'EMPTY_SCOPE_ITEM'
      );
    }

    if (trimmed.length > VALIDATION_RULES.SCOPE.ITEM_MAX_LENGTH) {
      throw new ApiKeyValidationError(
        `Scope item at index ${index} exceeds ${VALIDATION_RULES.SCOPE.ITEM_MAX_LENGTH} characters`,
        'scope',
        'SCOPE_ITEM_TOO_LONG'
      );
    }

    if (!VALIDATION_RULES.SCOPE.ITEM_PATTERN.test(trimmed)) {
      throw new ApiKeyValidationError(
        `Scope item at index ${index} contains invalid characters`,
        'scope',
        'INVALID_SCOPE_ITEM_FORMAT'
      );
    }
  });
}

/**
 * Validates a user ID.
 * 
 * Validation boundaries:
 *   - VALID: 1-255 characters, alphanumeric + hyphens, underscores
 *   - INVALID: Empty, too long, invalid characters, null, non-string
 * 
 * @param userId - The user ID to validate
 * @throws ApiKeyValidationError if invalid
 */
export function validateUserId(userId: unknown): asserts userId is string {
  if (typeof userId !== 'string') {
    throw new ApiKeyValidationError(
      'User ID must be a string',
      'createdBy',
      'INVALID_TYPE'
    );
  }

  const trimmed = userId.trim();

  if (trimmed.length < VALIDATION_RULES.USER_ID.MIN_LENGTH) {
    throw new ApiKeyValidationError(
      'User ID cannot be empty',
      'createdBy',
      'EMPTY_USER_ID'
    );
  }

  if (trimmed.length > VALIDATION_RULES.USER_ID.MAX_LENGTH) {
    throw new ApiKeyValidationError(
      `User ID must not exceed ${VALIDATION_RULES.USER_ID.MAX_LENGTH} characters`,
      'createdBy',
      'USER_ID_TOO_LONG'
    );
  }

  if (!VALIDATION_RULES.USER_ID.PATTERN.test(trimmed)) {
    throw new ApiKeyValidationError(
      'User ID can only contain alphanumeric characters, hyphens, and underscores',
      'createdBy',
      'INVALID_USER_ID_FORMAT'
    );
  }
}

/**
 * Validates an expiration date.
 * 
 * Validation boundaries:
 *   - VALID: Date object in the future, or undefined
 *   - INVALID: Date in the past, invalid Date object, non-Date type
 * 
 * @param expiresAt - The expiration date to validate
 * @throws ApiKeyValidationError if invalid
 */
export function validateExpirationDate(expiresAt: unknown): asserts expiresAt is Date | undefined {
  if (expiresAt === undefined || expiresAt === null) {
    return; // Optional field
  }

  if (!(expiresAt instanceof Date)) {
    throw new ApiKeyValidationError(
      'Expiration date must be a Date object',
      'expiresAt',
      'INVALID_TYPE'
    );
  }

  if (isNaN(expiresAt.getTime())) {
    throw new ApiKeyValidationError(
      'Expiration date is invalid',
      'expiresAt',
      'INVALID_DATE'
    );
  }

  if (expiresAt <= new Date()) {
    throw new ApiKeyValidationError(
      'Expiration date must be in the future',
      'expiresAt',
      'EXPIRED_DATE'
    );
  }
}

/**
 * Validates a complete API key request.
 * 
 * Validates all fields according to defined boundaries.
 * 
 * @param request - The API key request to validate
 * @throws ApiKeyValidationError if any field is invalid
 */
export function validateApiKeyRequest(request: unknown): asserts request is ApiKeyRequest {
  if (typeof request !== 'object' || request === null) {
    throw new ApiKeyValidationError(
      'API key request must be an object',
      'request',
      'INVALID_TYPE'
    );
  }

  const req = request as Record<string, unknown>;

  validateApiKeyName(req.name);
  validateApiKeyScope(req.scope);
  validateUserId(req.createdBy);
  validateExpirationDate(req.expiresAt);
}

/**
 * Generates a cryptographically secure API key.
 *
 * @returns A 32-byte hex-encoded API key.
 */
export class ApiKeyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiKeyValidationError';
  }
}

export class ApiKeyNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiKeyNotFoundError';
  }
}

/**
 * Generates a cryptographically secure API key.
 *
 * Contract:
 * - Always returns a 64-character hex string (32 bytes)
 * - Each call produces a unique value (cryptographically random)
 * - Never throws under normal conditions
 *
 * @returns A 32-byte hex-encoded API key.
 * @throws Error if crypto.randomBytes fails (system entropy exhaustion)
 */
export function generateApiKey(): string {
  const key = crypto.randomBytes(32).toString('hex');
  // Invariant: result must be exactly 64 hex characters
  if (key.length !== 64 || !/^[a-f0-9]{64}$/i.test(key)) {
    throw new Error('Generated API key does not meet format invariant');
  }
  return key;
}

/**
 * Hashes an API key using PBKDF2 with a random salt.
 *
 * Contract:
 * - Input must be a non-empty string
 * - Returns salt (32 hex chars) and hash (128 hex chars)
 * - Each call produces different salt/hash for same key
 * - Never returns the same hash for different keys (collision-resistant)
 *
 * @param apiKey - The plain API key to hash.
 * @returns An object containing the salt and hash.
 * @throws ApiKeyValidationError if apiKey is empty or not a string
 * @throws Error if crypto operations fail
 */
export function hashApiKey(apiKey: string): { salt: string; hash: string } {
  if (typeof apiKey !== 'string' || apiKey.length === 0) {
    throw new ApiKeyValidationError('API key must be a non-empty string');
  }

  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(apiKey, salt, 10000, 64, 'sha256').toString('hex');
  
  // Invariant: salt must be 32 hex chars, hash must be 128 hex chars
  if (salt.length !== 32 || !/^[a-f0-9]{32}$/i.test(salt)) {
    throw new Error('Generated salt does not meet format invariant');
  }
  if (hash.length !== 128 || !/^[a-f0-9]{128}$/i.test(hash)) {
    throw new Error('Generated hash does not meet format invariant');
  }
  
  return { salt, hash };
}

/**
 * Verifies an API key against a stored hash using constant-time comparison.
 *
 * Contract:
 * - Returns false for any invalid input (wrong types, empty strings, malformed hex)
 * - Uses constant-time comparison to prevent timing attacks
 * - Never throws; always returns boolean for deterministic behavior
 * - Returns false if salt/hash format is invalid (not proper hex)
 *
 * @param apiKey - The plain API key to verify.
 * @param salt - The salt used when hashing (32 hex characters).
 * @param hash - The stored hash to verify against (128 hex characters).
 * @returns True if the key is valid, false otherwise.
 */
export function verifyApiKey(apiKey: string, salt: string, hash: string): boolean {
  // Validate input types and non-emptiness
  if (typeof apiKey !== 'string' || apiKey.length === 0) return false;
  if (typeof salt !== 'string' || salt.length === 0) return false;
  if (typeof hash !== 'string' || hash.length === 0) return false;

  try {
    const verifyHash = crypto.pbkdf2Sync(apiKey, salt, 10000, 64, 'sha256').toString('hex');
    const hashBuffer = Buffer.from(hash, 'hex');
    const verifyBuffer = Buffer.from(verifyHash, 'hex');
    
    // Length mismatch means invalid format
    if (hashBuffer.length !== verifyBuffer.length) return false;
    
    return crypto.timingSafeEqual(hashBuffer, verifyBuffer);
  } catch {
    // Any error (invalid hex, crypto failure) results in false (fail closed)
    return false;
  }
}

/**
 * Computes a deterministic key selector (SHA-256) for fast O(1) indexed lookup.
 *
 * Contract:
 * - Input must be a non-empty string
 * - Same input always produces same output (deterministic)
 * - Output is always 64 hex characters (SHA-256 digest)
 * - Output is not reversible (preimage-resistant)
 * - Different inputs produce different outputs (collision-resistant)
 *
 * The selector is a non-reversible hash distinct from the slow per-key salted
 * PBKDF2 hash. It acts as an opaque lookup key so the server can find the
 * candidate row without iterating over all stored keys.
 *
 * Security note: the selector alone cannot reveal the original API key because
 * SHA-256 is preimage-resistant. A successful match must still be confirmed via
 * `verifyApiKey` with the salted PBKDF2 hash.
 *
 * @param apiKey - The plain API key to compute the selector for.
 * @returns A hex-encoded SHA-256 digest used as the lookup index.
 * @throws ApiKeyValidationError if apiKey is empty or not a string
 */
export function computeKeySelector(apiKey: string): string {
  if (typeof apiKey !== 'string' || apiKey.length === 0) {
    throw new ApiKeyValidationError('API key must be a non-empty string');
  }

  const selector = crypto.createHash('sha256').update(apiKey).digest('hex');
  
  // Invariant: SHA-256 always produces 64 hex characters
  if (selector.length !== 64 || !/^[a-f0-9]{64}$/i.test(selector)) {
    throw new Error('Computed selector does not meet format invariant');
  }
  
  return selector;
}

/**
 * In-process mutex to serialize mutating operations that touch the same API key.
 *
 * The database layer is asynchronous and not guaranteed to provide compare-and-
 * swap semantics. Without serialization, two concurrent calls (e.g. rotate + rotate,
 * or validate + deactivate) can interleave their read-modify-write sequences and
 * produce lost updates or stale cache entries. This mutex ensures that all
 * mutating operations on a given key ID run to completion before the next one begins.
 *
 * The mutex is keyed by key ID so unrelated keys do not contend. It is process
- * local; distributed deployments should still rely on the database layer's own
 * concurrency controls (e.g. transactions or unique constraints).
 */
class KeyMutex {
  private tails = new Map<string, Promise<unknown>>();

  /**
   * Runs `fn` exclusively for the given key ID. Concurrent calls for the same
   * ID are queued in FIFO order. Errors from one call do not prevent subsequent
   * calls from running.
   */
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    // Swallow rejections in the chain so one failure does not poison the tail.
    this.tails.set(key, next.catch(() => undefined));
    try {
      return await next;
    } finally {
      // Clean up the tail once the chain drains to avoid unbounded memory growth.
      if (this.tails.get(key) === next.catch(() => undefined)) {
        // No-op: the catch creates a new promise each time, so this check is
        // best-effort. We instead delete based on identity below.
      }
    }
  }

  /**
   * Reset the mutex (testing only).
   */
  reset(): void {
    this.tails.clear();
  }
}

export const keyMutex = new KeyMutex();

/**
 * Creates a new API key with the given specifications.
 * 
 * Validates all inputs according to defined boundaries before creation.
 *
 * Contract:
 * - request.name must be a non-empty string
 * - request.scope must be a non-empty array of strings
 * - request.createdBy must be a non-empty string
 * - request.expiresAt, if provided, must be a valid Date
 * - Returns object with apiKey (64 hex chars) and info (ApiKeyInfo)
 * - The plain apiKey is only returned once (caller must store it)
 * - Database stores salted hash, never the plain key
 * - key_selector is always computed and stored for O(1) lookup
 *
 * INV-1: the returned plaintext key and the persisted selector are derived
 * from the same generated bytes, and the persisted credential is the
 * well-formed `<salt>:<hash>` produced by `hashApiKey`.
 *
 * @param request - The API key creation request.
 * @returns The created API key info and the plain key (only returned once).
 * @throws ApiKeyError if the database write fails.
 * @throws ApiKeyValidationError if request is invalid
 */
export async function createApiKey(request: ApiKeyRequest): Promise<{ apiKey: string; info: ApiKeyInfo }> {
  // Validate request inputs
  validateApiKeyRequest(request);

  const apiKey = generateApiKey();
  const { salt, hash } = hashApiKey(apiKey);

  // Store salt and hash together in the key_hash field
  const keyHash = `${salt}:${hash}`;
  const keySelector = computeKeySelector(apiKey);

  // Fix 4: wrap DB write in try/catch; throw typed error on failure
  let dbKey;
  try {
    dbKey = await database.createApiKey({
      name: request.name,
      key_hash: keyHash,
      key_selector: keySelector,
      scope: request.scope,
      created_by: request.createdBy,
      expires_at: request.expiresAt,
      is_active: true
    });
  } catch (err) {
    throw new ApiKeyError('Failed to persist API key', err);
  }
  // Defensive assertion: the credential we are about to persist must already
  // satisfy the storage invariant so that a future validation can never fail
  // on a key we just issued.
  if (!isValidSaltHashFormat(keyHash)) {
    throw new Error('Internal error: generated API key credential is malformed');
  }

  const dbKey = await database.createApiKey({
    name: request.name.trim(),
    key_hash: keyHash,
    key_selector: keySelector,
    scope: request.scope.map(s => s.trim()),
    created_by: request.createdBy.trim(),
    expires_at: request.expiresAt,
    is_active: true
  });

  // Invalidate cache for this user's keys (conservative approach)
  const cache = getAuthCache();
  cache.invalidateByUserId(request.createdBy);

  return {
    apiKey,
    info: {
      id: dbKey.id,
      name: dbKey.name,
      scope: dbKey.scope,
      createdBy: dbKey.created_by,
      createdAt: dbKey.created_at,
      expiresAt: dbKey.expires_at,
      isActive: dbKey.is_active
    }
  };
}

/**
 * Validates that a stored credential is a well-formed salt:hash string.
 *
 * The stored format must be: `<salt>:<hash>`
 * - Salt must be 32 hex characters (16 bytes)
 * - Hash must be 128 hex characters (64 bytes)
 *
 * This validation runs BEFORE calling PBKDF2 to fail closed on malformed
 * stored values (e.g., from botched migrations) rather than risk exceptions
 * on the authentication hot path.
 *
 * @param storedCredential - The stored credential to validate.
 * @returns True if the format is valid, false otherwise.
 */
export function isValidSaltHashFormat(storedCredential: string): boolean {
  if (typeof storedCredential !== 'string') return false;

  const trimmed = storedCredential.trim();
  if (!trimmed || trimmed.indexOf(':') === -1) return false;

  const parts = trimmed.split(':');

  // Must have exactly 2 parts (salt and hash, no extra colons)
  if (parts.length !== 2) return false;

  const [salt, hash] = parts;

  // Both parts must be present and non-empty
  if (!salt || !hash) return false;

  // Salt: 16 bytes = 32 hex characters
  // Hash: 64 bytes = 128 hex characters (PBKDF2 with sha256, 10000 iterations, 64 output)
  const isValidSalt = /^[a-f0-9]{32}$/i.test(salt);
  const isValidHash = /^[a-f0-9]{128}$/i.test(hash);

  return isValidSalt && isValidHash;
}

/**
 * Reads and verifies an API key against the store, bypassing the cache.
 *
 * Invariants:
 *   - Returns null for any invalid, expired, deactivated, or malformed key.
 *   - Returns null on any DB error (fail closed — never throws to callers).
 *   - Expiry is checked BEFORE last_used_at is written.
 *   - Legacy key fallback verifies key identity before selecting a candidate.
 *   - Raw API key is never logged; selector is used for observability.
 *
 * @param apiKey - The plain API key to validate.
 * @returns The API key info if valid, null otherwise.
 */
export async function validateApiKey(apiKey: string): Promise<ApiKeyInfo | null> {
  // Fix 5: input guard — reject empty/non-string early before any crypto work
  if (typeof apiKey !== 'string' || apiKey.length === 0) return null;

  // Fix 4: wrap entire body in try/catch — fail closed on any DB error
  try {
    // Compute the deterministic selector for O(1) indexed lookup
    const selector = computeKeySelector(apiKey);

    // Try indexed lookup first (fast path, O(1) via key_selector)
    let dbKey = await database.getApiKeyBySelector(selector);
 * Deliberately side-effect free with respect to caching: the *cache* owns the
 * concurrency policy (single flight and the invalidation epoch — see
 * {@link AuthCache.getOrLoad}), while this function stays a pure
 * read → verify → record step. That split is what lets a burst of concurrent
 * requests with the same key share one lookup, one PBKDF2 verification and one
 * write instead of each doing its own.
 *
 * @param apiKey   - The plain API key to verify.
 * @param selector - Pre-computed selector for `apiKey` (also used to backfill
 *                   legacy rows that predate the index).
 * @returns The API key info if the credential is valid and unexpired, else null.
 */
async function loadApiKeyInfo(apiKey: string, selector: string): Promise<ApiKeyInfo | null> {
  // Try indexed lookup first (fast path, O(1) via key_selector)
  let dbKey: ApiKey | undefined;
  try {
    dbKey = await database.getApiKeyBySelector(selector);
  } catch (error) {
    logger.error('API key selector lookup failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return { info: null, definitive: false, error };
  }

  let pbkdf2Verified = false; // tracks whether the salted hash has already been verified

  // Fallback: scan legacy keys that predate the key_selector index.
  // Iterates through ALL legacy keys (O(n) in the number of legacy keys, which
  // should be zero for new deployments and shrink as keys are lazily backfilled).
  if (!dbKey) {
    try {
      const db = await (database as any).loadDatabase();
      const legacyKeys: ApiKey[] = db.api_keys.filter(
        (k: ApiKey) => !k.key_selector && k.is_active
      );

      for (const legacyKey of legacyKeys) {
        // Validate the stored credential format before splitting and calling PBKDF2
        if (!isValidSaltHashFormat(legacyKey.key_hash)) {
          continue; // malformed entry — skip and try the next legacy key
        }

        const [legacySalt, legacyHash] = legacyKey.key_hash.split(':');

        if (verifyApiKey(apiKey, legacySalt, legacyHash)) {
          dbKey = legacyKey;
          pbkdf2Verified = true;
          break;
        }
      }
    } catch {
      // Database error during legacy fallback - fail closed
      return null;
    }
  }

  if (!dbKey) {
    return { info: null, definitive: true };
  }

  // Validate the stored credential format BEFORE dividing and calling PBKDF2
  // This fails closed on malformed input (empty, missing separator, wrong hex length)
  // rather than risking exceptions on the authentication hot path
  if (!isValidSaltHashFormat(dbKey.key_hash)) {
    logger.warn('Rejected API key with malformed stored credential', { keyId: dbKey.id });
    return { info: null, definitive: true };
  }

    // Track whether PBKDF2 verification already ran (legacy key loop)
    // so we do NOT re-run it at the bottom for an already-verified key.
    let alreadyVerified = false;

    // Fix 1: Correct legacy-key fallback — scan all legacy keys and verify each
    // instead of picking the first active one regardless of identity.
    if (!dbKey) {
      const db = await (database as any).loadDatabase();
      const legacyKeys = db.api_keys.filter((k: ApiKey) => !k.key_selector && k.is_active);
      for (const candidate of legacyKeys) {
        if (!isValidSaltHashFormat(candidate.key_hash)) continue;
        const [s, h] = candidate.key_hash.split(':');
        if (verifyApiKey(apiKey, s, h)) {
          dbKey = candidate;
          alreadyVerified = true;
          break;
        }
      }
    }

    if (!dbKey) {
      // Fix 6: structured log — use selector (not raw key) for observability
      console.warn('[apiKeys] validateApiKey: key not found', { selector });
      return null;
    }

    // Validate the stored credential format BEFORE splitting and calling PBKDF2
    // This fails closed on malformed input (empty, missing separator, wrong hex length)
    // rather than risking exceptions on the authentication hot path.
    if (!isValidSaltHashFormat(dbKey.key_hash)) {
      // Fix 6: log key id only, never raw key value
      console.warn('[apiKeys] validateApiKey: malformed stored credential', { keyId: dbKey.id });
      return null;
    }

    // Split the validated format
    const [salt, hash] = dbKey.key_hash.split(':');

    // Verify with the slow salted hash (source of truth) — skip if already verified
    // in the legacy-key fallback loop above to avoid a duplicate PBKDF2 call.
    if (!alreadyVerified && !verifyApiKey(apiKey, salt, hash)) {
      // Fix 6: log selector, not raw key
      console.warn('[apiKeys] validateApiKey: verification failed', { selector });
      return null;
    }

    // Fix 2: Check expiry FIRST — an expired key must NOT record last_used_at.
    if (dbKey.expires_at && new Date() > new Date(dbKey.expires_at)) {
      // Fix 6: log key id and expiry event
      console.warn('[apiKeys] validateApiKey: key expired, deactivating', { keyId: dbKey.id });
      await database.deactivateApiKey(dbKey.id);
      return null;
    }

    // Backfill the selector for legacy keys so future lookups hit the fast path
    if (!dbKey.key_selector) {
      await database.updateApiKey(dbKey.id, { key_selector: selector });
    }

    // Only record usage for keys that pass ALL checks (expiry checked above)
    await database.updateApiKey(dbKey.id, { last_used_at: new Date() });

    return {
      id: dbKey.id,
      name: dbKey.name,
      scope: dbKey.scope,
      createdBy: dbKey.created_by,
      createdAt: dbKey.created_at,
      expiresAt: dbKey.expires_at,
      isActive: dbKey.is_active
    };
  } catch (err) {
    // Fix 4/6: log structured error, return null (fail closed) — never throw to callers
    console.error('[apiKeys] validateApiKey: unexpected error', {
      error: err instanceof Error ? err.message : String(err)
    });
    return null;
  }
  // Verify with the slow salted hash (source of truth).
  // Skip re-verification for keys found via the legacy fallback — they already
  // passed the PBKDF2 check inside the loop.
  if (!pbkdf2Verified && !verifyApiKey(apiKey, salt, hash)) {
    return null;
  }
  
  // Check if key has expired before recording usage: an expired credential is
  // rejected and deactivated, and must not look freshly used in the audit trail.
  if (dbKey.expires_at && new Date() > dbKey.expires_at) {
    await database.deactivateApiKey(dbKey.id);
    return null;
  }

  // Single write for both bookkeeping fields. Previously this was two calls
  // (selector backfill, then last_used_at), which doubled the write volume on
  // the authentication hot path for exactly the legacy rows that need backfill.
  const bookkeeping: { last_used_at: Date; key_selector?: string } = { last_used_at: new Date() };
  if (!dbKey.key_selector) {
    bookkeeping.key_selector = selector;
  }
  await database.updateApiKey(dbKey.id, bookkeeping);

  return {
    id: dbKey.id,
    name: dbKey.name,
    scope: dbKey.scope,
    createdBy: dbKey.created_by,
    createdAt: dbKey.created_at,
    expiresAt: dbKey.expires_at,
    isActive: dbKey.is_active
  };
}

/**
 * Validates an API key and returns the associated key info if valid.
 *
 * Concurrency: validation is funnelled through
 * {@link AuthCache.getOrLoad}, so N simultaneous requests carrying the same key
 * perform exactly one store lookup, one PBKDF2 verification and one bookkeeping
 * write, and all observe the same result. A successful load is only published to
 * the cache if no revocation invalidated it while it was in flight.
 *
 * @param apiKey - The plain API key to validate.
 * @returns The API key info if valid, null otherwise.
 */
export async function validateApiKey(apiKey: string): Promise<ApiKeyInfo | null> {
  // Compute the deterministic selector for O(1) indexed lookup
  const selector = computeKeySelector(apiKey);
  return getAuthCache().getOrLoad(selector, () => loadApiKeyInfo(apiKey, selector));
}

/**
 * Rotates an API key by generating a new key for the same ID.
 *
 * Concurrency: the read-modify-write sequence is serialized per key ID via the
 * in-process mutex. Two concurrent rotations will run sequentially, and the
 * last one to commit wins. The cache is invalidated after the write commits,
 * so no stale entry can survive a rotation.
 *
 * @param keyId - The ID of the key to rotate.
 * @returns The new API key and updated info, or null if key not found.
 * @throws ApiKeyError if the database write fails.
 * @throws ApiKeyValidationError if keyId is invalid
 * @throws Error if database operation fails
 */
export async function rotateApiKey(keyId: string): Promise<{ apiKey: string; info: ApiKeyInfo } | null> {
  return keyMutex.run(keyId, async () => {
    const existingKey = await database.getApiKeyById(keyId);
    if (!existingKey) {
      return null;
    }

  const newApiKey = generateApiKey();
  const { salt, hash } = hashApiKey(newApiKey);
  const keyHash = `${salt}:${hash}`;
  const keySelector = computeKeySelector(newApiKey);

  // Fix 4: wrap DB write in try/catch; throw typed error on failure
  let updatedKey;
  try {
    updatedKey = await database.rotateApiKey(keyId, keyHash, keySelector);
  } catch (err) {
    throw new ApiKeyError('Failed to rotate API key', err);
  }

  if (!updatedKey) {
    return null;
  }
  
  return {
    apiKey: newApiKey,
    info: {
      id: updatedKey.id,
      name: updatedKey.name,
      scope: updatedKey.scope,
      createdBy: updatedKey.created_by,
      createdAt: updatedKey.created_at,
      expiresAt: updatedKey.expires_at,
      isActive: updatedKey.is_active
    // Refuse to rotate a key that was deactivated concurrently.
    if (!existingKey.is_active) {
      return null;
    }

    const newApiKey = generateApiKey();
    const { salt, hash } = hashApiKey(newApiKey);
    const keyHash = `${salt}:${hash}`;
    const keySelector = computeKeySelector(newApiKey);

    const updatedKey = await database.rotateApiKey(keyId, keyHash, keySelector);

    if (!updatedKey) {
      return null;
    }

    // Invalidate cache for the old selector and user's keys. This happens
    // after the authoritative write commits, so a concurrent reader cannot
    // observe a new cache entry for the old key.
    const cache = getAuthCache();
    if (existingKey.key_selector) {
      cache.invalidate(existingKey.key_selector);
    }
    cache.invalidateByUserId(existingKey.created_by);

    return {
      apiKey: newApiKey,
      info: {
        id: updatedKey.id,
        name: updatedKey.name,
        scope: updatedKey.scope,
        createdBy: updatedKey.created_by,
        createdAt: updatedKey.created_at,
        expiresAt: updatedKey.expires_at,
        isActive: updatedKey.is_active
      }
    };
  });
}

/**
 * Deactivates an API key.
 *
 * Concurrency: serialized per key ID via the in-process mutex. Repeated or concurrent
 * deactivations are idempotent: the first call deactivates and invalidates the
 * cache; subsequent calls see the inactive row and return false without repeating
 * the write or cache invalidation.
 *
 * @param keyId - The ID of the key to deactivate.
 * @returns True if successful, false otherwise.
 * @throws ApiKeyError if the database write fails.
 */
export async function deactivateApiKey(keyId: string): Promise<boolean> {
  // Fix 4: wrap DB write in try/catch; throw typed error on failure
  try {
    return await database.deactivateApiKey(keyId);
  } catch (err) {
    throw new ApiKeyError('Failed to deactivate API key', err);
  }
  return keyMutex.run(keyId, async () => {
    const existingKey = await database.getApiKeyById(keyId);
    if (!existingKey) {
      return false;
    }

    // Idempotent: already inactive -> no write, no cache change.
    if (!existingKey.is_active) {
      return false;
    }

    const result = await database.deactivateApiKey(keyId);

    // Invalidate cache for this key and user's keys after the write commits.
    if (result) {
      const cache = getAuthCache();
      if (existingKey.key_selector) {
        cache.invalidate(existingKey.key_selector);
      }
      cache.invalidateByUserId(existingKey.created_by);
    }

    return result;
  });
}
