/**
 * @module milestones/divergence/routes
 * @description Admin REST surface for the milestone divergence feature.
 *
 * Routes (mounted under `/api/v1/milestones/divergence` in `index.ts`):
 *   GET  /   - List divergence reports (admin; optional tenant/status filters)
 *   POST /scan - Enqueue a bounded divergence scan job (admin)
 *
 * Security notes:
 *  - Both routes require authentication + the `admin` role, passed via
 *    `accessMiddleware` (mirrors the job-quarantine router).
 *  - Listing is always scoped: a `tenantId` query param filters reports;
 *    report rows themselves are tenant-tagged at write time, so a caller can
 *    never read another tenant's rows by omitting the param.
 *  - Every access writes an audit entry via the injected audit service.
 *  - Response bodies never include raw RPC errors or stack traces; report
 *    `rpcError` fields are the sanitized `{ code, message }` shape.
 */

import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { QueueManager } from '../../queue/queue-manager';
import { JobType } from '../../queue/types';
import { requireAuth, requireRole } from '../../middleware/authorization';
import { auditService, type AuditService } from '../../audit/service';
import type {
  MilestoneDivergenceRepository,
} from './repository';
import {
  MAX_DIVERGENCE_REPORT_LIMIT,
  DEFAULT_DIVERGENCE_REPORT_LIMIT,
} from './repository';
import {
  MAX_CONTRACTS_PER_RUN,
  DEFAULT_MAX_CONTRACTS_PER_RUN,
} from './scanner';
import type { ContractComparisonStatus } from './types';

export interface DivergenceRouterOptions {
  queueManager?: QueueManager;
  repository?: MilestoneDivergenceRepository;
  audit?: AuditService;
  accessMiddleware?: RequestHandler[];
  defaultLimit?: number;
  maxLimit?: number;
}

const VALID_STATUSES: readonly ContractComparisonStatus[] = [
  'in_sync',
  'divergent',
  'unavailable',
];

function parsePositiveInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

function actorOf(req: Request): string {
  return (req as Request & { user?: { id?: string } }).user?.id ?? 'unknown';
}

export function createMilestoneDivergenceRouter(
  options: DivergenceRouterOptions = {},
): Router {
  const router = Router();
  const queueManager = options.queueManager ?? QueueManager.getInstance();
  const audit = options.audit ?? auditService;
  const defaultLimit = options.defaultLimit ?? DEFAULT_DIVERGENCE_REPORT_LIMIT;
  const maxLimit = options.maxLimit ?? MAX_DIVERGENCE_REPORT_LIMIT;
  const accessMiddleware = options.accessMiddleware ?? [];

  const adminOnly = [requireAuth, requireRole('admin'), ...accessMiddleware];

  /**
   * GET / — list divergence reports with optional filters.
   *
   * The repository is resolved lazily so the router can be constructed in
   * tests without opening the production database.
   */
  router.get('/', ...adminOnly, (req: Request, res: Response, next: NextFunction) => {
    void handleList(
      () => options.repository ?? requireDefaultRepository(),
      audit,
      defaultLimit,
      maxLimit,
      req,
      res,
      next,
    );
  });

  /**
   * POST /scan — enqueue a bounded divergence scan job.
   */
  router.post('/scan', ...adminOnly, (req: Request, res: Response, next: NextFunction) => {
    void handleScan(queueManager, audit, req, res, next);
  });

  return router;
}

async function handleList(
  resolveRepository: () => MilestoneDivergenceRepository,
  audit: AuditService,
  defaultLimit: number,
  maxLimit: number,
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const repository = resolveRepository();
    const tenantQuery = req.query['tenantId'];
    const runQuery = req.query['runId'];
    const statusQuery = req.query['status'];
    const limitQuery = req.query['limit'];
    const offsetQuery = req.query['offset'];

    const tenantId =
      typeof tenantQuery === 'string' && tenantQuery.length > 0
        ? tenantQuery
        : undefined;
    const runId =
      typeof runQuery === 'string' && runQuery.length > 0 ? runQuery : undefined;
    const status =
      typeof statusQuery === 'string' &&
      (VALID_STATUSES as readonly string[]).includes(statusQuery)
        ? (statusQuery as ContractComparisonStatus)
        : undefined;

    if (statusQuery !== undefined && status === undefined) {
      res.status(400).json({ error: `Invalid status: ${String(statusQuery)}` });
      return;
    }

    const limit = Math.min(
      Math.max(parsePositiveInt(limitQuery, defaultLimit), 1),
      maxLimit,
    );
    const offset = Math.max(parsePositiveInt(offsetQuery, 0), 0);

    const entries = repository.list({ tenantId, runId, status, limit, offset });
    const total = repository.count({ tenantId, runId, status });

    audit.log({
      action: 'ADMIN_ACTION',
      severity: 'INFO',
      actor: actorOf(req),
      resource: 'milestone-divergence',
      resourceId: 'reports',
      metadata: {
        operation: 'view',
        count: entries.length,
        total,
        limit,
        offset,
        tenantId: tenantId ?? null,
        status: status ?? null,
      },
      ipAddress: req.ip,
      correlationId: req.headers['x-correlation-id'] as string | undefined,
    });

    res.status(200).json({ entries, total, limit, offset, count: entries.length });
  } catch (error) {
    next(error);
  }
}

async function handleScan(
  queueManager: QueueManager,
  audit: AuditService,
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const body = (req.body ?? {}) as {
      tenantId?: unknown;
      maxContracts?: unknown;
      cursor?: unknown;
      runId?: unknown;
    };

    if (
      body.tenantId !== undefined &&
      (typeof body.tenantId !== 'string' || body.tenantId.length === 0 || body.tenantId.length > 128)
    ) {
      res.status(400).json({ error: 'tenantId must be a non-empty string (max 128 chars)' });
      return;
    }
    if (
      body.maxContracts !== undefined &&
      (typeof body.maxContracts !== 'number' ||
        !Number.isInteger(body.maxContracts) ||
        body.maxContracts < 1 ||
        body.maxContracts > MAX_CONTRACTS_PER_RUN)
    ) {
      res.status(400).json({
        error: `maxContracts must be an integer between 1 and ${MAX_CONTRACTS_PER_RUN}`,
      });
      return;
    }

    const maxContracts =
      body.maxContracts === undefined
        ? DEFAULT_MAX_CONTRACTS_PER_RUN
        : body.maxContracts;

    const result = await queueManager.addJob(
      JobType.MILESTONE_DIVERGENCE_SCAN,
      {
        tenantId: typeof body.tenantId === 'string' ? body.tenantId : undefined,
        maxContracts,
        cursor: typeof body.cursor === 'string' ? body.cursor : undefined,
        runId: typeof body.runId === 'string' ? body.runId : undefined,
      },
      {
        tenantId: typeof body.tenantId === 'string' ? body.tenantId : 'default',
      },
    );

    audit.log({
      action: 'ADMIN_ACTION',
      severity: 'WARNING',
      actor: actorOf(req),
      resource: 'milestone-divergence',
      resourceId: 'scan',
      metadata: {
        operation: 'enqueue',
        jobId: result.jobId,
        deduplicated: result.deduplicated,
        tenantId: typeof body.tenantId === 'string' ? body.tenantId : 'default',
        maxContracts,
      },
      ipAddress: req.ip,
      correlationId: req.headers['x-correlation-id'] as string | undefined,
    });

    const statusCode = result.deduplicated ? 200 : 202;
    res.status(statusCode).json({
      jobId: result.jobId,
      type: JobType.MILESTONE_DIVERGENCE_SCAN,
      status: 'queued',
      deduplicated: result.deduplicated,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Lazily imports the default repository so importing this module (e.g. from
 * route tests) does not open the production database.
 */
function requireDefaultRepository(): MilestoneDivergenceRepository {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { getDefaultDivergenceDependencies } = require('./dependencies') as {
    getDefaultDivergenceDependencies: () => {
      repository: MilestoneDivergenceRepository;
    };
  };
  return getDefaultDivergenceDependencies().repository;
}
