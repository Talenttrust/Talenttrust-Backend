import { Router, Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import { DependencyScanController } from '../controllers/dependency-scan.controller';
import { extractBearerToken } from '../lib/authHelpers';

const router = Router();

/**
 * Resolves the authenticated user for a bearer token.
 *
 * The dependency-scan endpoint is an operator/CI facing route that is driven by
 * pre-provisioned service tokens rather than interactive end-user JWTs. Tokens
 * map deterministically to a role so that CI can request the report with an
 * admin token while ordinary service tokens are authenticated but unprivileged.
 *
 * Returns `null` when the token is not recognised, which the auth middleware
 * translates into a 401.
 */
function resolveUser(
  token: string,
): { id: string; email: string; role: 'user' | 'admin' } | null {
  switch (token) {
    case 'demo-admin-token':
      return { id: 'demo-admin', email: 'admin@talenttrust.local', role: 'admin' };
    case 'demo-user-token':
      return { id: 'demo-user', email: 'user@talenttrust.local', role: 'user' };
    default:
      return null;
  }
}

/**
 * Authentication guard. Establishes identity from the bearer token.
 *  - Missing/malformed Authorization header → 401 (unauthenticated).
 *  - Unrecognised token → 401 (unauthenticated).
 *  - Recognised token → attaches `req.user` and continues; role-based
 *    authorization is enforced separately by {@link requireAdmin}.
 */
function authMiddleware(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const token = extractBearerToken(req);
  if (!token) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  const user = resolveUser(token);
  if (!user) {
    res.status(401).json({ error: 'Invalid token' });
    return;
  }

  req.user = user;
  next();
}

/**
 * Authorization guard. Requires an authenticated admin. Runs after
 * {@link authMiddleware}, so `req.user` is guaranteed to be present; a
 * non-admin identity yields 403 (authenticated but forbidden).
 */
function requireAdmin(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  if (req.user?.role !== 'admin') {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }
  next();
}

/**
 * GET /api/v1/dependency-scan
 * Admin-only. Returns production dependency scan status and remediation guidance.
 */
router.get('/', authMiddleware, requireAdmin, DependencyScanController.getReport);

export default router;
