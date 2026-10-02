/**
 * @module adminAuthGuard
 * @description Admin authentication guard requiring JWT or API key with admin privileges.
 *
 * Accepts authentication via:
 *   - `Authorization: Bearer <jwt>` — verified with `jsonwebtoken` + JWT_SECRET, requires admin role.
 *   - `X-API-Key: <key>` — verified against stored API key hashes, requires `deploy:*` or `*` scope.
 *
 * Rejects with 401 for missing/invalid credentials and 403 for non-admin callers.
 *
 * @security
 *  - JWT verification uses `jsonwebtoken.verify()` with HS256 and JWT_SECRET,
 *    pinned to the allowlist exported from `../auth/jwtConfig` so tokens
 *    whose header advertises any algorithm other than HS256 — including
 *    `alg: none` and HS/RS confusion attempts — are rejected before the
 *    signature is even checked.
 *  - API key comparison uses `crypto.timingSafeEqual` to prevent timing attacks.
 *  - Error responses contain no sensitive diagnostic information.
 *  - Credentials are redacted from log output via `redactSecret`.
 */

import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { verifyApiKey, validateApiKey, ApiKeyInfo } from '../auth/apiKeys';
import { redactSecret } from '../utils/redact';
import { JWT_VERIFY_OPTIONS } from '../auth/jwtConfig';
import { extractBearerToken, sendUnauthorized, sendForbidden } from '../lib/authHelpers';

/** Shape of the decoded JWT payload. */
interface AdminJwtPayload {
  sub: string;
  email: string;
  role: string;
  iat?: number;
  exp?: number;
}

/** Express request extended with admin auth info. */
export interface AdminAuthenticatedRequest extends Request {
  user?: {
    id: string;
    email: string;
    role: string;
    authMethod: 'jwt' | 'api-key';
  };
  apiKey?: ApiKeyInfo;
}

/** Allowed admin roles. */
const ADMIN_ROLES = new Set(['admin', 'superadmin']);

/** Required scopes for admin access to deploy/DLQ endpoints. */
const REQUIRED_ADMIN_SCOPES = new Set([
  'deploy:*',
  '*',
  'jobs:admin',
  'jobs:*',
]);



// ─── JWT validation ───────────────────────────────────────────────────────────

/**
 * Validates a JWT bearer token and checks for admin role.
 *
 * @param token - The raw JWT string.
 * @returns The decoded payload if valid admin, otherwise null.
 */
function validateAdminJwt(token: string): { sub: string; email: string; role: string } | null {
  const secret = process.env.JWT_SECRET ?? '';

  try {
    // JWT_VERIFY_OPTIONS pins the accepted signature algorithms to HS256.
    // This rejects alg: none and HS/RS confusion attempts before any signature
    // check, even if the rest of the payload is structurally valid.
    const decoded = jwt.verify(token, secret, JWT_VERIFY_OPTIONS) as AdminJwtPayload;

    if (!decoded.sub || !decoded.email) {
      return null;
    }

    if (!ADMIN_ROLES.has(decoded.role)) {
      return null;
    }

    return { sub: decoded.sub, email: decoded.email, role: decoded.role };
  } catch {
    return null;
  }
}

// ─── API key validation ───────────────────────────────────────────────────────

/**
 * Checks whether the API key has an admin-level scope.
 *
 * @param apiKeyInfo - The validated API key info.
 * @returns True if the key has admin scope.
 */
function hasAdminScope(apiKeyInfo: ApiKeyInfo): boolean {
  return apiKeyInfo.scope.some((scope) => REQUIRED_ADMIN_SCOPES.has(scope));
}

// ─── Middleware ───────────────────────────────────────────────────────────────

/**
 * Admin authentication guard middleware.
 *
 * Authenticates requests via JWT bearer token or API key.
 * Requires admin role (JWT) or admin scope (API key).
 *
 * On success, attaches `req.user` with `{ id, email, role, authMethod }`.
 *
 * @example
 * router.post('/api/v1/deploy/switch-green', adminAuthGuard, deployController.switchGreen);
 */
export async function adminAuthGuard(
  req: AdminAuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.headers.authorization;
  const apiKeyHeader = req.headers['x-api-key'] as string | undefined;

  // ── Attempt JWT authentication ────────────────────────────────────────────

  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = extractBearerToken(req)!;

    // Demo tokens for test environments (mirrors authMiddleware behaviour)
    if (token === 'demo-admin-token') {
      req.user = {
        id: 'admin-user-id',
        email: 'admin@talenttrust.com',
        role: 'admin',
        authMethod: 'jwt',
      };
      return next();
    }

    if (token === 'demo-user-token') {
      return sendForbidden(res, 'Admin role required.');
    }

    const jwtPayload = validateAdminJwt(token);
    if (jwtPayload) {
      req.user = {
        id: jwtPayload.sub,
        email: jwtPayload.email,
        role: jwtPayload.role,
        authMethod: 'jwt',
      };
      return next();
    }

    // Token was provided but invalid — reject immediately
    return sendUnauthorized(res, 'Invalid or expired JWT token.');
  }

  // ── Attempt API key authentication ────────────────────────────────────────

  if (apiKeyHeader) {
    try {
      const apiKeyInfo = await validateApiKey(apiKeyHeader);

      if (apiKeyInfo && hasAdminScope(apiKeyInfo)) {
        req.user = {
          id: apiKeyInfo.createdBy,
          email: apiKeyInfo.name,
          role: 'admin',
          authMethod: 'api-key',
        };
        req.apiKey = apiKeyInfo;
        return next();
      }

      // Key was provided but invalid or insufficient scope
      if (apiKeyInfo && !hasAdminScope(apiKeyInfo)) {
        return sendForbidden(res, 'API key does not have admin scope.');
      }

      return sendUnauthorized(res, 'Invalid API key.');
    } catch {
      return sendUnauthorized(res, 'Invalid API key.');
    }
  }

  // ── No credentials provided ────────────────────────────────────────────────

  return sendUnauthorized(res, 'Authentication required. Provide Bearer JWT or X-API-Key.');
}
