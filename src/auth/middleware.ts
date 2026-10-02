import { Response, NextFunction } from 'express';
import { Resource, Action } from './roles';
import { AuthenticatedRequest } from './authenticate';
import { evaluateAuthorization } from './authorize';
import { getContext, requestContextStorage } from '../context';

/**
 * Express middleware factory that enforces role-based permissions.
 *
 * Compatibility contract:
 * - Always responds with the same JSON shape and status codes for a given
 *   failure class (unauthenticated -> 401, forbidden -> 403).
 * - Never mutates the incoming request object or the current request context.
 * - Runs downstream handlers inside an enriched request context that carries
 *   the authenticated actor id, so downstream code can attribute actions.
 * - Does not leak sensitive details (role names, resource names, internal
 *   errors) in response bodies.
 *
 * Invariants:
 * - Authorization is evaluated exactly once per request and only after the
 *   authentication check passes.
 * - `user.id` must be a non-empty string; otherwise the request is treated as
 *   unauthenticated to avoid attributing actions to an anonymous actor.
 * - A failure in the authorization check must fail closed (500) and must not
 *   allow the request to proceed.
 */
export function requirePermission(resource: Resource, action: Action) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    const user = req.user;
    if (!user || typeof user.id !== 'string' || user.id.length === 0) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    // Snapshot the current context and derive a fresh enriched context. We never
    // mutate the parent context object so concurrent requests cannot observe
    // each other's actor id.
    const current = getContext() ?? {};
    const enriched = { ...current, actorId: user.userId };
    requestContextStorage.run(enriched, () => {
      // Use the decision API so unexpected-input denials (unregistered
      // role/resource, unrecognized action) are logged with a reason while
      // the response contract stays byte-for-byte identical.
      if (!evaluateAuthorization(user.role, resource, action).allowed) {
        res.status(403).json({ error: 'Forbidden: insufficient permissions' });
        return;
      }

      next();
    });
  };
}
