/**
 * @module config/apiKeysConfig
 * @description Config parsing and validation for the API_KEYS environment variable.
 *
 * The `API_KEYS` env var contains a JSON array of key descriptors:
 * ```json
 * [{ "id": "ops-1", "hash": "sha256:<hex-digest>", "scopes": ["disputes:resolve", "admin:read"] }]
 * ```
 *
 * Keys themselves are never stored — only `sha256(key)`. Invalid JSON,
 * unknown scopes, or duplicate ids fail fast at startup with a clear error.
 */

import * as crypto from 'crypto';
import { isValidScope, VALID_SCOPES } from './scopes';

/**
 * A single API key descriptor loaded from configuration.
 */
export interface ApiKeyConfigEntry {
  /** Unique identifier for the key (used in logs and /whoami). */
  id: string;
  /** SHA-256 hash of the plaintext key, prefixed with `sha256:`. */
  hash: string;
  /** Scopes granted to this key. */
  scopes: string[];
}

/**
 * Parsed and validated API key store.
 */
export interface ParsedApiKeys {
  /** Array of validated key entries. */
  keys: ApiKeyConfigEntry[];
  /**
   * Map from SHA-256 digest (hex, no prefix) → entry, for O(1) lookup
   * by the authenticateApiKey middleware.
   */
  byDigest: Map<string, ApiKeyConfigEntry>;
}

/**
 * SHA-256 hash a plaintext API key and return the hex digest.
 */
export function sha256Hex(plaintext: string): string {
  return crypto.createHash('sha256').update(plaintext).digest('hex');
}

/**
 * Extract the hex digest from a `sha256:<hex>` formatted string.
 * Returns `null` if the format is invalid.
 */
export function extractDigest(hashField: string): string | null {
  if (typeof hashField !== 'string') return null;
  const prefix = 'sha256:';
  if (!hashField.startsWith(prefix)) return null;
  const digest = hashField.slice(prefix.length);
  // SHA-256 hex digest is 64 hex characters
  if (!/^[a-f0-9]{64}$/i.test(digest)) return null;
  return digest.toLowerCase();
}

/**
 * Parse and validate the `API_KEYS` environment variable value.
 *
 * @param rawValue - The raw string value of `API_KEYS` (may be undefined/empty).
 * @returns A {@link ParsedApiKeys} object. Empty input yields an empty store.
 * @throws {Error} when the JSON is malformed, contains unknown scopes,
 *                 has duplicate ids, or individual entries are malformed.
 */
export function parseApiKeysConfig(rawValue: string | undefined): ParsedApiKeys {
  // Empty or undefined → no keys configured (open access denied for scoped routes).
  if (rawValue === undefined || rawValue.trim() === '') {
    return { keys: [], byDigest: new Map() };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawValue);
  } catch (err) {
    throw new Error(
      `API_KEYS: invalid JSON — ${err instanceof Error ? err.message : 'parse error'}`,
    );
  }

  if (!Array.isArray(parsed)) {
    throw new Error('API_KEYS: expected a JSON array of key descriptors');
  }

  const keys: ApiKeyConfigEntry[] = [];
  const byDigest = new Map<string, ApiKeyConfigEntry>();
  const seenIds = new Set<string>();

  for (let i = 0; i < parsed.length; i++) {
    const entry = parsed[i];

    // ── Shape validation ──────────────────────────────────────────────
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`API_KEYS: entry at index ${i} must be a JSON object`);
    }

    const obj = entry as Record<string, unknown>;

    // id
    if (typeof obj['id'] !== 'string' || obj['id'].trim() === '') {
      throw new Error(`API_KEYS: entry at index ${i} is missing a non-empty "id" field`);
    }
    const id = obj['id'].trim();

    // Duplicate id check
    if (seenIds.has(id)) {
      throw new Error(`API_KEYS: duplicate key id "${id}" — each id must be unique`);
    }
    seenIds.add(id);

    // hash
    if (typeof obj['hash'] !== 'string' || obj['hash'].trim() === '') {
      throw new Error(`API_KEYS: entry "${id}" is missing a non-empty "hash" field`);
    }
    const digest = extractDigest(obj['hash']);
    if (digest === null) {
      throw new Error(
        `API_KEYS: entry "${id}" has an invalid hash format — expected "sha256:<64 hex chars>"`,
      );
    }

    // scopes
    if (!Array.isArray(obj['scopes']) || obj['scopes'].length === 0) {
      throw new Error(`API_KEYS: entry "${id}" must have a non-empty "scopes" array`);
    }
    const scopes: string[] = [];
    for (const s of obj['scopes']) {
      if (typeof s !== 'string') {
        throw new Error(`API_KEYS: entry "${id}" has a non-string scope value`);
      }
      if (!isValidScope(s)) {
        throw new Error(
          `API_KEYS: entry "${id}" has unknown scope "${s}". Valid scopes: ${VALID_SCOPES.join(', ')}`,
        );
      }
      scopes.push(s);
    }

    const entry_: ApiKeyConfigEntry = { id, hash: obj['hash'], scopes };
    keys.push(entry_);
    byDigest.set(digest, entry_);
  }

  return { keys, byDigest };
}
