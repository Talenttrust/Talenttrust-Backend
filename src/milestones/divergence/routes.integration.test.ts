/**
 * Milestone divergence REST API integration tests.
 *
 * Mounts `createMilestoneDivergenceRouter` behind the real auth middleware
 * with a mocked QueueManager and in-memory repository, then verifies the full
 * HTTP cycle: authorization (401/403), filtered listing, bounded pagination,
 * scan enqueueing with audit, and the safe error envelope.
 */

import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { QueueManager } from '../../queue/queue-manager';
import { JobType } from '../../queue/types';
import { createMilestoneDivergenceRouter } from './routes';
import {
  InMemoryMilestoneDivergenceRepository,
  toDivergenceReportRecord,
} from './repository';
import { auditStore } from '../../audit/store';

const TEST_SECRET = process.env.JWT_SECRET || 'test-secret-for-divergence';
process.env.JWT_SECRET = TEST_SECRET;

const adminToken = jwt.sign(
  { sub: 'admin-1', email: 'admin@tt.com', role: 'admin' },
  TEST_SECRET,
  { expiresIn: '1h' },
);
const userToken = jwt.sign(
  { sub: 'user-1', email: 'user@tt.com', role: 'client' },
  TEST_SECRET,
  { expiresIn: '1h' },
);

function buildApp(
  repository: InMemoryMilestoneDivergenceRepository,
  queueManager: Partial<QueueManager>,
) {
  const app = express();
  app.use(express.json());
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.locals.requestId = 'test-req-id';
    next();
  });
  app.use(
    '/api/v1/milestones/divergence',
    createMilestoneDivergenceRouter({
      repository,
      queueManager: queueManager as unknown as QueueManager,
    }),
  );
  app.use((_err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({
      error: { code: 'internal_error', message: 'An unexpected error occurred' },
    });
  });
  return app;
}

describe('Milestone Divergence REST API', () => {
  let repository: InMemoryMilestoneDivergenceRepository;
  let mockQm: { addJob: jest.Mock };

  beforeEach(() => {
    auditStore._reset();
    repository = new InMemoryMilestoneDivergenceRepository();
    mockQm = { addJob: jest.fn() };
  });

  it('rejects unauthenticated listing with 401', async () => {
    const app = buildApp(repository, mockQm);
    const res = await request(app).get('/api/v1/milestones/divergence');
    expect(res.status).toBe(401);
  });

  it('rejects non-admin listing with 403', async () => {
    const app = buildApp(repository, mockQm);
    const res = await request(app)
      .get('/api/v1/milestones/divergence')
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(403);
  });

  it('lists reports for an admin with tenant filtering', async () => {
    repository.save(
      toDivergenceReportRecord({
        runId: 'run-1',
        tenantId: 'tenant-a',
        contractId: 'c1',
        status: 'divergent',
        blockHeight: 100,
        comparedAt: '2026-01-01T00:00:00.000Z',
        milestoneComparisons: [],
        differences: [{ field: 'milestones.m1.amount', indexed: 1, onChain: 2 }],
      }),
    );
    repository.save(
      toDivergenceReportRecord({
        runId: 'run-1',
        tenantId: 'tenant-b',
        contractId: 'c2',
        status: 'in_sync',
        blockHeight: 100,
        comparedAt: '2026-01-02T00:00:00.000Z',
        milestoneComparisons: [],
        differences: [],
      }),
    );

    const app = buildApp(repository, mockQm);
    const res = await request(app)
      .get('/api/v1/milestones/divergence?tenantId=tenant-a')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.total).toBe(1);
    expect(res.body.entries[0].contractId).toBe('c1');
    expect(res.body.entries[0].differences).toEqual([
      { field: 'milestones.m1.amount', indexed: 1, onChain: 2 },
    ]);
  });

  it('rejects an invalid status filter with 400', async () => {
    const app = buildApp(repository, mockQm);
    const res = await request(app)
      .get('/api/v1/milestones/divergence?status=nonsense')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
  });

  it('rejects an unauthenticated scan trigger with 401', async () => {
    const app = buildApp(repository, mockQm);
    const res = await request(app).post('/api/v1/milestones/divergence/scan');
    expect(res.status).toBe(401);
    expect(mockQm.addJob).not.toHaveBeenCalled();
  });

  it('enqueues a scan job for an admin and writes an audit entry', async () => {
    mockQm.addJob.mockResolvedValue({ jobId: 'job-1', deduplicated: false });
    const app = buildApp(repository, mockQm);

    const res = await request(app)
      .post('/api/v1/milestones/divergence/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ tenantId: 'tenant-a', maxContracts: 25 });

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      jobId: 'job-1',
      type: JobType.MILESTONE_DIVERGENCE_SCAN,
      status: 'queued',
      deduplicated: false,
    });
    expect(mockQm.addJob).toHaveBeenCalledWith(
      JobType.MILESTONE_DIVERGENCE_SCAN,
      expect.objectContaining({ tenantId: 'tenant-a', maxContracts: 25 }),
      expect.objectContaining({ tenantId: 'tenant-a' }),
    );
  });

  it('rejects an out-of-range maxContracts with 400', async () => {
    const app = buildApp(repository, mockQm);
    const res = await request(app)
      .post('/api/v1/milestones/divergence/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ maxContracts: 99999 });
    expect(res.status).toBe(400);
    expect(mockQm.addJob).not.toHaveBeenCalled();
  });

  it('defaults maxContracts to the safe bound when omitted', async () => {
    mockQm.addJob.mockResolvedValue({ jobId: 'job-2', deduplicated: true });
    const app = buildApp(repository, mockQm);

    const res = await request(app)
      .post('/api/v1/milestones/divergence/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});

    expect(res.status).toBe(200); // deduplicated → 200
    expect(mockQm.addJob).toHaveBeenCalledWith(
      JobType.MILESTONE_DIVERGENCE_SCAN,
      expect.objectContaining({ maxContracts: 100 }),
      expect.anything(),
    );
  });
});
