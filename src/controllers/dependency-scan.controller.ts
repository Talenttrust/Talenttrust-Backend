import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import { DependencyScanService } from '../services/dependency-scan.service';

const dependencyScanService = new DependencyScanService();

export class DependencyScanController {
  /**
   * GET /api/v1/dependency-scan
   * Returns production dependency audit status and remediation guidance.
   * Admin-only: exposes vulnerability details that must not be public.
   *
   * @query refresh=true  Force a fresh npm audit run, bypassing the 5-minute cache.
   */
  public static async getReport(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const forceRefresh = req.query.refresh === 'true';
      const report = await dependencyScanService.getReport(forceRefresh);
      res.status(200).json({ status: 'success', data: report });
    } catch (error) {
      next(error);
    }
  }
}
