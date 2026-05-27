/**
 * @module middleware
 * @description Express middleware that enforces the access control matrix.
 *
 * Usage:
 *   app.get('/api/v1/contracts', authenticate, requirePermission('contracts', 'read'), handler);
 *
 * The `requirePermission` factory returns middleware that checks the
 * authenticated user's role against the access control matrix.
 *
 * Security notes:
 *   - Must be placed AFTER `authenticateMiddleware` in the middleware chain.
 *   - Responds with 403 Forbidden when the role lacks the required permission.
 *   - Responds with 401 if `req.user` is missing (in case authenticate was skipped).
 */

import { Response, NextFunction } from 'express';
import { Resource, Action } from './roles';
import { AuthenticatedRequest } from './authenticate';
import { isAllowed } from './authorize';

/**
 * Factory that returns Express middleware enforcing a specific permission.
 *
 * @param resource - The resource being accessed.
 * @param action   - The action being performed.
 * @returns Express middleware function.
 */
export function requirePermission(resource: Resource, action: Action) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    if (!isAllowed(req.user.role, resource, action)) {
      res.status(403).json({ error: 'Forbidden: insufficient permissions' });
      return;
    }

    next();
  };
}
