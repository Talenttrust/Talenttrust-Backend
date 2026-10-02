/**
 * @module apiKeys
 * @description API key authentication utilities for TalentTrust.
 *
 * Provides secure API key generation, validation, and management.
 * API keys are hashed at rest using SHA-256 with a salt.
 *
 * API keys are expected in the `X-API-Key` header:
 *   X-API-Key: <api-key>
 *
 * Security notes:
 *   - API keys are cryptographically generated using random bytes
 *   - Keys are hashed at rest using SHA-256 with a unique salt
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
 */

import * as crypto from 'crypto';
import { ApiKey } from '../database/schema';
import { database } from '../database';

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
 * Generates a cryptographically secure API key.
 *
 * @returns A 32-byte hex-encoded API key.
 */
export function generateApiKey(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Hashes an API key using SHA-256 with a salt.
 *
 * @param apiKey - The plain API key to hash.
 * @returns An object containing the salt and hash.
 */
export function hashApiKey(apiKey: string): { salt: string; hash: string } {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(apiKey, salt, 10000, 64, 'sha256').toString('hex');
  return { salt, hash };
}

/**
 * Verifies an API key against a stored hash.
 *
 * @param apiKey - The plain API key to verify.
 * @param salt - The salt used when hashing.
 * @param hash - The stored hash to verify against.
 * @returns True if the key is valid, false otherwise.
 */

export function verifyApiKey(apiKey: string, salt: string, hash: string): boolean {
  try {
    const verifyHash = crypto.pbkdf2Sync(apiKey, salt, 10000, 64, 'sha256').toString('hex');
    const hashBuffer = Buffer.from(hash, 'hex');
    const verifyBuffer = Buffer.from(verifyHash, 'hex');
    if (hashBuffer.length !== verifyBuffer.length) return false;
    return crypto.timingSafeEqual(hashBuffer, verifyBuffer);
  } catch {
    return false;
  }
}

/**
 * Computes a deterministic key selector (SHA-256) for fast O(1) indexed lookup.
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
 */
export function computeKeySelector(apiKey: string): string {
  return crypto.createHash('sha256').update(apiKey).digest('hex');
}

/**
 * Creates a new API key with the given specifications.
 *
 * @param request - The API key creation request.
 * @returns The created API key info and the plain key (only returned once).
 * @throws ApiKeyError if the database write fails.
 */
export async function createApiKey(request: ApiKeyRequest): Promise<{ apiKey: string; info: ApiKeyInfo }> {
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

function isValidSaltHashFormat(storedCredential: string): boolean {
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
 * Validates an API key and returns the associated key info if valid.
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
}

/**
 * Rotates an API key by generating a new key for the same ID.
 *
 * @param keyId - The ID of the key to rotate.
 * @returns The new API key and updated info, or null if key not found.
 * @throws ApiKeyError if the database write fails.
 */
export async function rotateApiKey(keyId: string): Promise<{ apiKey: string; info: ApiKeyInfo } | null> {
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
    }
  };
}

/**
 * Deactivates an API key.
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
}
