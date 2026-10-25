/**
 * @module auth/scopedApiKeyMiddleware
 * @description Scoped API keys (`API_KEYS`) for operator-only routes such as
 * dispute resolution. Keys are sent as `X-API-Key: <key>` or
 * `Authorization: ApiKey <key>`, hashed with SHA-256 and compared against
 * every configured digest in constant time (no early exit, so timing does not
 * reveal which key id was close). Errors go through the app error handler.
 */
import type { NextFunction, Request, Response } from 'express';
import * as crypto from 'crypto';
import { HttpError } from '../amount-error';
import type { ParsedApiKeys } from './apiKeysConfig';
import { sha256Hex } from './apiKeysConfig';

export interface ScopedApiKeyRequest extends Request {
  scopedApiKey?: { id: string; scopes: string[] };
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

/** Resolve the presented key (if any) to its configured id and scopes. */
export function matchApiKey(apiKeys: ParsedApiKeys, rawKey: string): { id: string; scopes: string[] } | null {
  const incomingDigest = sha256Hex(rawKey);
  let matched: { id: string; scopes: string[] } | null = null;
  // Compare against every digest so the time taken does not depend on which key matched.
  for (const [storedDigest, entry] of apiKeys.byDigest) {
    if (safeCompareHex(incomingDigest, storedDigest) && !matched) matched = { id: entry.id, scopes: entry.scopes };
  }
  return matched;
}

/** 401 unless a configured API key is presented; sets `req.scopedApiKey`. */
export function authenticateScopedApiKey(apiKeys: ParsedApiKeys) {
  return (req: ScopedApiKeyRequest, _res: Response, next: NextFunction): void => {
    const rawKey = extractApiKeyFromHeaders(req.headers as Record<string, string | string[] | undefined>);
    if (!rawKey) {
      return next(new HttpError(401, 'unauthorized', 'API key required. Provide X-API-Key or Authorization: ApiKey <key>.'));
    }
    const matched = matchApiKey(apiKeys, rawKey);
    if (!matched) return next(new HttpError(401, 'unauthorized', 'Invalid API key.'));
    req.scopedApiKey = matched;
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
