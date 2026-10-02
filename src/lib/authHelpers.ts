/**
 * @module lib/authHelpers
 * @description Shared auth validation helpers used across middleware.
 *
 * Centralises two repeated patterns:
 *   1. Bearer token extraction from the `Authorization` header.
 *   2. Structured 401/403 response emission (used by the JWT middleware stack).
 *
 * Consumers that need a different response shape (e.g. `metricsAuth`) use
 * only `extractBearerToken` and emit their own response.
 */

import type { Request, Response } from "express";

// ─── Bearer token extraction ──────────────────────────────────────────────────

/**
 * Extracts the raw token string from an `Authorization: Bearer <token>` header.
 *
 * Returns `null` when:
 *   - The `Authorization` header is absent.
 *   - The header does not start with `"Bearer "` (case-sensitive, with trailing space).
 *   - The token portion is empty after stripping the prefix.
 *
 * No validation of the token value is performed — that is the caller's
 * responsibility.
 *
 * @param req - Any Express-compatible request object.
 * @returns The raw token string, or `null` if the header is missing/malformed.
 */
export function extractBearerToken(req: Pick<Request, "headers">): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return null;
  }
  const token = authHeader.slice(7); // strip "Bearer "
  return token.length > 0 ? token : null;
}

// ─── Structured error response helpers ───────────────────────────────────────
//
// These are used by the JWT middleware stack (`authorization.ts`,
// `adminAuthGuard.ts`) which share the same structured error envelope:
//   { error: { code, message, requestId } }
//
// Callers that use a different envelope (e.g. `metricsAuth`) should not
// import these.

/**
 * Sends a 401 Unauthorized response with the shared structured error envelope.
 *
 * @param res     - Express response object.
 * @param message - Human-readable detail; defaults to `"Unauthorized"`.
 */
export function sendUnauthorized(res: Response, message = "Unauthorized"): void {
  const requestId =
    typeof res.locals.requestId === "string" ? res.locals.requestId : "unknown";
  res.status(401).json({
    error: {
      code: "unauthorized",
      message,
      requestId,
    },
  });
}

/**
 * Sends a 403 Forbidden response with the shared structured error envelope.
 *
 * @param res     - Express response object.
 * @param message - Human-readable detail; defaults to `"Forbidden"`.
 */
export function sendForbidden(res: Response, message = "Forbidden"): void {
  const requestId =
    typeof res.locals.requestId === "string" ? res.locals.requestId : "unknown";
  res.status(403).json({
    error: {
      code: "forbidden",
      message,
      requestId,
    },
  });
}
