/**
 * Express middleware factories for authentication and role-based authorization.
 *
 * Middleware stack order for a protected route:
 *   requireAuth → requireRole | requirePermission
 *
 * `requireAuth` must always run first.  It validates the bearer token with
 * `jsonwebtoken`, reads the user's id/email/role directly from the JWT payload,
 * and attaches a `User` object to `req.user`.  The downstream middleware
 * factories trust that `req.user` is present and well-formed once
 * `requireAuth` has passed.
 *
 * Expected JWT payload shape:
 * ```json
 * {
 *   "sub":   "<userId>",
 *   "email": "<userEmail>",
 *   "role":  "admin" | "client" | "freelancer",
 *   "iat":   <issuedAt>,
 *   "exp":   <expiresAt>
 * }
 * ```
 *
 * @security
 *  - Tokens are verified with `JWT_SECRET` using HS256; forged or tampered
 *    tokens are rejected at the HMAC-verification step before any claims
 *    are read.
 *  - `jwt.verify()` also enforces the `exp` claim — expired tokens are
 *    rejected without any additional check.
 *  - Role values are re-validated against the ALL_ROLES allowlist after
 *    decode so that a token carrying an arbitrary role string is always caught.
 *  - `resourceOwnerId` must come from a trusted database lookup — never from
 *    request parameters supplied by the caller.
 *  - On any error the middleware responds with the minimum diagnostic
 *    information (no stack traces, no internal ids) to limit information
 *    leakage to attackers.
 */

import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { isAuthorized, isValidRole } from "../lib/authorization";
import type { Action, User, Resource, Role, AuthenticatedRequest } from "../lib/types";

// ─── JWT configuration ────────────────────────────────────────────────────────

const JWT_SECRET = process.env.JWT_SECRET ?? "";

/**
 * Shape of the decoded JWT payload expected by this platform.
 * `sub` carries the user id (standard JWT claim).
 */
interface JwtPayload {
  sub:   string;
  email: string;
  role:  unknown; // validated against ALL_ROLES before use
  iat?:  number;
  exp?:  number;
}

// ─── Error response helpers ───────────────────────────────────────────────────

function unauthorized(res: Response, message = "Unauthorized"): void {
  res.status(401).json({ error: message });
}

function forbidden(res: Response, message = "Forbidden"): void {
  res.status(403).json({ error: message });
}

// ─── requireAuth ─────────────────────────────────────────────────────────────

/**
 * Authentication middleware.
 *
 * Validates the `Authorization: Bearer <token>` header using `jsonwebtoken`.
 * On success, attaches a typed `User` to `req.user`.
 *
 * Failure cases (all → HTTP 401):
 *  - Missing or malformed `Authorization` header
 *  - Token signature invalid (wrong secret / tampered payload)
 *  - Token expired (`exp` claim in the past)
 *  - Token missing required claims (`sub`, `email`, `role`)
 *  - `role` claim is not a member of ALL_ROLES
 *
 * @example
 * router.get("/jobs", requireAuth, handler);
 */
export function requireAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith("Bearer ")) {
    unauthorized(res, "Missing or malformed Authorization header.");
    return;
  }

  const token = authHeader.slice(7); // strip "Bearer "

  try {
    // jwt.verify throws for any invalid token (bad signature, expired, etc.)
    const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload;

    // Guard required claims — a well-formed token always carries these.
    if (!decoded.sub || !decoded.email) {
      unauthorized(res, "Token is missing required claims.");
      return;
    }

    // Re-validate the role claim against the platform allowlist.
    if (!isValidRole(decoded.role)) {
      unauthorized(res, "Token carries an unrecognised role.");
      return;
    }

    req.user = {
      id:    decoded.sub,
      email: decoded.email,
      role:  decoded.role,
    } satisfies User;

    next();
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      unauthorized(res, "Token has expired.");
      return;
    }
    // Covers JsonWebTokenError (bad signature, malformed) and NotBeforeError.
    unauthorized(res, "Invalid token.");
  }
}

// ─── requireRole ─────────────────────────────────────────────────────────────

/**
 * Authorization middleware factory — coarse-grained role check.
 *
 * Must be placed after `requireAuth` in the middleware chain.
 *
 * @param   allowedRoles - One or more roles that may access the route.
 * @returns Express middleware that responds with 403 when the user's role is
 *          not in `allowedRoles`.
 *
 * @example
 * router.get("/reports", requireAuth, requireRole("admin"), handler);
 */
export function requireRole(...allowedRoles: Role[]) {
  return function roleMiddleware(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): void {
    if (!req.user) {
      unauthorized(res, "Authentication required.");
      return;
    }

    if (!allowedRoles.includes(req.user.role)) {
      forbidden(res, "You do not have permission to access this resource.");
      return;
    }

    next();
  };
}

// ─── requirePermission ────────────────────────────────────────────────────────

/**
 * Authorization middleware factory — fine-grained permission check.
 *
 * Delegates to `isAuthorized` which evaluates the PERMISSION_MATRIX including
 * `ownOnly` restrictions.  When a permission entry carries `ownOnly: true`,
 * the middleware calls `getResourceOwnerId` to resolve the true owner of the
 * target record from the database.
 *
 * Must be placed after `requireAuth` in the middleware chain.
 *
 * @param resource           - The resource domain being accessed.
 * @param action             - The action being performed.
 * @param getResourceOwnerId - Optional async resolver returning the userId of
 *                             the record owner, or `null` if the record does
 *                             not exist.
 * @returns Express middleware.
 *
 * @example
 * router.get("/jobs", requireAuth, requirePermission("jobs", "list"), handler);
 *
 * @example
 * router.delete(
 *   "/jobs/:id",
 *   requireAuth,
 *   requirePermission("jobs", "delete", (req) =>
 *     jobService.getOwnerIdById(req.params.id)
 *   ),
 *   deleteJobHandler,
 * );
 */
export function requirePermission(
  resource: Resource,
  action: Action,
  getResourceOwnerId?: (req: AuthenticatedRequest) => Promise<string | null>
) {
  return async function permissionMiddleware(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    if (!req.user) {
      unauthorized(res, "Authentication required.");
      return;
    }

    try {
      let resourceOwnerId: string | undefined;

      if (getResourceOwnerId) {
        const ownerId = await getResourceOwnerId(req);

        if (ownerId === null) {
          // Record does not exist — return 404 rather than leaking whether
          // the record exists but is forbidden.
          res.status(404).json({ error: "Resource not found." });
          return;
        }

        resourceOwnerId = ownerId;
      }

      const result = isAuthorized({
        user: req.user,
        resource,
        action,
        resourceOwnerId,
      });

      if (!result.granted) {
        forbidden(res, "You do not have permission to perform this action.");
        return;
      }

      next();
    } catch (err) {
      // Resolver threw — treat as a server error, not an auth failure.
      res.status(500).json({ error: "Authorization check failed." });
    }
  };
}