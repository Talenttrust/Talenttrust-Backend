/**
 * @module auth/scopedApiKeyMiddleware
 * @description Scoped API keys (`API_KEYS`) for operator-only routes such as
 * dispute resolution. Keys are sent as `X-API-Key: <key>` or
 * `Authorization: ApiKey <key>`, hashed with SHA-256 and compared against
 * every configured digest in constant time (no early exit, so timing does not
 * reveal which key id was close). A key whose optional `expiresAt` has passed
 * is rejected with 401 "API key expired". Errors go through the app error handler.
 */
import type { NextFunction, Request, Response } from 'express';
import * as crypto from 'crypto';
import { HttpError } from '../amount-error';
import type { ApiKeyConfigEntry, ParsedApiKeys } from './apiKeysConfig';
import { sha256Hex } from './apiKeysConfig';

/** The authenticated key, as exposed on the request and by /whoami. */
export interface ScopedApiKey {
  id: string;
  scopes: string[];
  /** ISO 8601 UTC expiry, absent for keys that never expire. */
  expiresAt?: string;
}

export interface ScopedApiKeyRequest extends Request {
  scopedApiKey?: ScopedApiKey;
}

/** Result of {@link matchApiKey} for a presented key that matches a configured digest. */
export type ApiKeyMatch =
  | { status: 'valid'; key: ScopedApiKey }
  | { status: 'expired'; id: string; expiresAt: string };

/** Injectable clock (ms since the epoch); defaults to `Date.now`. */
export type Clock = () => number;

export interface ScopedApiKeyOptions {
  /** Clock used for expiry checks (tests inject a fixed one). */
  now?: Clock;
}

/** Raw API key from `X-API-Key` or `Authorization: ApiKey <key>`; null when absent. */
export function extractApiKeyFromHeaders(headers: Record<string, string | string[] | undefined>): string | null {
  const xApiKey = headers['x-api-key'];
  if (typeof xApiKey === 'string' && xApiKey.trim() !== '') return xApiKey.trim();
  const auth = headers['authorization'];
  if (typeof auth === 'string') {
    const parts = auth.trim().split(/\s+/);
    if (parts.length === 2 && parts[0].toLowerCase() === 'apikey' && parts[1].length > 0) return parts[1];
  }
  return null;
}

function safeCompareHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Resolve the presented key to its configured entry. Returns `null` when no
 * configured key matches, `{ status: 'expired' }` when it matches a key whose
 * `expiresAt` is at or before `now()`, and `{ status: 'valid', key }` otherwise.
 * Expired keys are invalid: callers must not authenticate them.
 */
export function matchApiKey(apiKeys: ParsedApiKeys, rawKey: string, now: Clock = Date.now): ApiKeyMatch | null {
  const incomingDigest = sha256Hex(rawKey);
  let matched: ApiKeyConfigEntry | null = null;
  // Compare against every digest so the time taken does not depend on which key matched.
  for (const [storedDigest, entry] of apiKeys.byDigest) {
    if (safeCompareHex(incomingDigest, storedDigest) && !matched) matched = entry;
  }
  if (!matched) return null;
  if (matched.expiresAt !== undefined && now() >= Date.parse(matched.expiresAt)) {
    return { status: 'expired', id: matched.id, expiresAt: matched.expiresAt };
  }
  const key: ScopedApiKey = { id: matched.id, scopes: matched.scopes };
  if (matched.expiresAt !== undefined) key.expiresAt = matched.expiresAt;
  return { status: 'valid', key };
}

/** 401 unless a configured API key is presented; sets `req.scopedApiKey`. */
export function authenticateScopedApiKey(apiKeys: ParsedApiKeys, options: ScopedApiKeyOptions = {}) {
  const now = options.now ?? Date.now;
  return (req: ScopedApiKeyRequest, _res: Response, next: NextFunction): void => {
    const rawKey = extractApiKeyFromHeaders(req.headers as Record<string, string | string[] | undefined>);
    if (!rawKey) {
      return next(new HttpError(401, 'unauthorized', 'API key required. Provide X-API-Key or Authorization: ApiKey <key>.'));
    }
    const matched = matchApiKey(apiKeys, rawKey, now);
    if (!matched) return next(new HttpError(401, 'unauthorized', 'Invalid API key.'));
    if (matched.status === 'expired') return next(new HttpError(401, 'unauthorized', 'API key expired'));
    req.scopedApiKey = matched.key;
    next();
  };
}

/** 403 `insufficient_scope` (with `required`) when the authenticated key lacks `scope`. */
export function requireScope(scope: string) {
  return (req: ScopedApiKeyRequest, _res: Response, next: NextFunction): void => {
    if (!req.scopedApiKey) {
      return next(new HttpError(401, 'unauthorized', 'Authentication with a scoped API key is required.'));
    }
    if (!req.scopedApiKey.scopes.includes(scope)) {
      return next(
        new HttpError(403, 'insufficient_scope', `The API key does not have the required scope: ${scope}`, { required: scope }),
      );
    }
    next();
  };
}
