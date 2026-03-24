/**
 * @module authenticate
 * @description Authentication middleware and helpers for TalentTrust.
 *
 * Uses a simple Bearer-token scheme backed by a shared secret (for demo /
 * test purposes). In production this would be replaced with JWT / OAuth2.
 *
 * Tokens are expected in the `Authorization` header:
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
 */

import { Request, Response, NextFunction } from 'express';
import { Role, VALID_ROLES } from './roles';

/** Shape of the decoded token payload. */
export interface TokenPayload {
  userId: string;
  role: Role;
}

/** Express request extended with authenticated user info. */
export interface AuthenticatedRequest extends Request {
  user?: TokenPayload;
}

/**
 * Decode and validate a bearer token string.
 *
 * @param token - The raw base64-encoded token.
 * @returns The decoded payload, or `null` if invalid.
 */
export function decodeToken(token: string): TokenPayload | null {
  try {
    const json = Buffer.from(token, 'base64').toString('utf-8');
    const parsed = JSON.parse(json);
    if (
      typeof parsed.userId !== 'string' ||
      !parsed.userId ||
      typeof parsed.role !== 'string' ||
      !(VALID_ROLES as readonly string[]).includes(parsed.role)
    ) {
      return null;
    }
    return { userId: parsed.userId, role: parsed.role as Role };
  } catch {
    return null;
  }
}

/**
 * Helper to create a valid bearer token for testing.
 *
 * @param userId - User identifier.
 * @param role   - Role to encode.
 * @returns Base64-encoded token string.
 */
export function createToken(userId: string, role: Role): string {
  return Buffer.from(JSON.stringify({ userId, role })).toString('base64');
}

/**
 * Express middleware that extracts and validates the bearer token.
 * On success, attaches `req.user` with `{ userId, role }`.
 * On failure, responds with 401.
 */
export function authenticateMiddleware(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): void {
  const header = req.headers.authorization;

  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid Authorization header' });
    return;
  }

  const token = header.slice(7);
  const payload = decodeToken(token);

  if (!payload) {
    res.status(401).json({ error: 'Invalid token' });
    return;
  }

  req.user = payload;
  next();
}
