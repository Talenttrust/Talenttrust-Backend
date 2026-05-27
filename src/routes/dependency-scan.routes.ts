import { Router, Response, NextFunction } from 'express';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth';
import { DependencyScanController } from '../controllers/dependency-scan.controller';

const router = Router();

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
