/**
 * @module queue/job-quarantine.routes
 * @description REST endpoints for inspecting and replaying quarantined jobs.
 *
 * Routes (mounted under `/api/v1/jobs` in `index.ts`):
 *   GET  /quarantine                - List quarantined jobs (admin)
 *   POST /quarantine/replay         - Re-enqueue a quarantined job after a fix (admin)
 *
 * Security notes:
 * - Both routes require admin authorization (passed via `accessMiddleware`);
 *   callers must provide `requireAuth` + `requireRole('admin')`.
 * - Every access writes an audit entry via the injected audit service.
 * - Response reasons are pulled from the quarantine store, which already
 *   sanitizes and redacts; the API never returns raw stack traces.
 */

import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { QueueManager } from './queue-manager';
import { JobType } from './types';
import { requireAuth, requireRole } from '../middleware/authorization';
import { auditService } from '../audit/service';
import type { AuditService } from '../audit/service';

export interface JobQuarantineRouterOptions {
  queueManager: QueueManager;
  audit?: AuditService;
  accessMiddleware?: RequestHandler[];
  /** Default page size when a `limit` query param is absent. */
  defaultLimit?: number;
  /** Maximum allowed `limit` query param. */
  maxLimit?: number;
}

function parsePositiveInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

export function createJobQuarantineRouter(options: JobQuarantineRouterOptions): Router {
  const router = Router();
  const {
    queueManager,
    audit = auditService,
    accessMiddleware = [],
    defaultLimit = 50,
    maxLimit = 100,
  } = options;

  const adminOnly = [requireAuth, requireRole('admin'), ...accessMiddleware];

  router.get('/quarantine', ...adminOnly, (req, res, next) => {
    void handleList(queueManager, audit, defaultLimit, maxLimit, req, res, next);
  });

  router.post('/quarantine/replay', ...adminOnly, (req, res, next) => {
    void handleReplay(queueManager, audit, req, res, next);
  });

  return router;
}

async function handleList(
  queueManager: QueueManager,
  audit: AuditService,
  defaultLimit: number,
  maxLimit: number,
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const typeQuery = req.query['type'];
    const tenantQuery = req.query['tenantId'];
    const limitQuery = req.query['limit'];
    const offsetQuery = req.query['offset'];

    const jobType = typeof typeQuery === 'string' ? typeQuery : undefined;
    if (jobType && !Object.values(JobType).includes(jobType as JobType)) {
      res.status(400).json({ error: 'Invalid job type' });
      return;
    }

    const limit = Math.min(Math.max(parsePositiveInt(limitQuery, defaultLimit), 1), maxLimit);
    const offset = Math.max(parsePositiveInt(offsetQuery, 0), 0);

    const entries = await queueManager.getQuarantinedJobs({
      jobType: jobType as JobType | undefined,
      tenantId: typeof tenantQuery === 'string' ? tenantQuery : undefined,
      limit,
      offset,
    });

    audit.log({
      action: 'ADMIN_ACTION',
      severity: 'INFO',
      actor: (req as Request & { user?: { id?: string } }).user?.id ?? 'unknown',
      resource: 'jobs-quarantine',
      resourceId: jobType ?? 'all',
      metadata: {
        operation: 'view',
        count: entries.length,
        limit,
        offset,
      },
      ipAddress: req.ip,
      correlationId: req.headers['x-correlation-id'] as string | undefined,
    });

    res.status(200).json({ entries, limit, offset, count: entries.length });
  } catch (error) {
    next(error);
  }
}

async function handleReplay(
  queueManager: QueueManager,
  audit: AuditService,
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { quarantineId, reason } = (req.body ?? {}) as {
      quarantineId?: string;
      reason?: string;
    };

    if (
      !quarantineId ||
      typeof quarantineId !== 'string' ||
      !reason ||
      typeof reason !== 'string' ||
      reason.trim().length < 5
    ) {
      res.status(400).json({ error: 'quarantineId and reason (min 5 chars) are required' });
      return;
    }

    const replayResult = await queueManager.replayQuarantinedJob(quarantineId);

    audit.log({
      action: 'ADMIN_ACTION',
      severity: 'WARNING',
      actor: (req as Request & { user?: { id?: string } }).user?.id ?? 'unknown',
      resource: 'jobs-quarantine',
      resourceId: quarantineId,
      metadata: {
        operation: 'replay',
        reason: reason.trim(),
        jobType: replayResult.jobType,
        replayedJobId: replayResult.replayedJobId,
        deduplicated: replayResult.deduplicated,
      },
      ipAddress: req.ip,
      correlationId: req.headers['x-correlation-id'] as string | undefined,
    });

    const statusCode = replayResult.deduplicated ? 200 : 202;
    res.status(statusCode).json(replayResult);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    if (message.startsWith('Quarantined job not found')) {
      res.status(404).json({ error: message });
      return;
    }
    if (message.startsWith('Queue for')) {
      res.status(503).json({ error: 'Queue for this job type is not initialized' });
      return;
    }
    next(error);
  }
}