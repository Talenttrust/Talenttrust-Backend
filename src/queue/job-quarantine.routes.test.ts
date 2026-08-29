/**
 * Job Quarantine REST API Integration Tests
 *
 * Mounts `createJobQuarantineRouter` behind the real auth middleware and a
 * mocked `QueueManager`, then verifies the full HTTP request/response cycle:
 * authorization, listing, replay (idempotent), pagination bounds, and the
 * safe error envelope.
 */

import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

const TEST_SECRET = process.env.JWT_SECRET || 'test-secret-for-quarantine';
process.env.JWT_SECRET = TEST_SECRET;

import { QueueManager } from './queue-manager';
import { createJobQuarantineRouter } from './job-quarantine.routes';
import { JobType } from './types';
import { auditService } from '../audit/service';
import { auditStore } from '../audit/store';

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

function buildApp(queueManager: Partial<QueueManager>) {
  const app = express();
  app.use(express.json());
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.locals.requestId = 'test-req-id';
    next();
  });
  app.use(
    '/api/v1/jobs',
    createJobQuarantineRouter({
      queueManager: queueManager as unknown as QueueManager,
    }),
  );
  app.use((_err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: { code: 'internal_error', message: 'An unexpected error occurred' } });
  });
  return app;
}

describe('Job Quarantine REST API', () => {
  let mockQm: { getQuarantinedJobs: jest.Mock; replayQuarantinedJob: jest.Mock };

  beforeEach(() => {
    auditStore._reset();
    mockQm = {
      getQuarantinedJobs: jest.fn(),
      replayQuarantinedJob: jest.fn(),
    };
  });

  it('rejects unauthenticated inspection', async () => {
    const app = buildApp(mockQm);
    const res = await request(app).get('/api/v1/jobs/quarantine');
    expect(res.status).toBe(401);
  });

  it('rejects non-admin inspection with 403', async () => {
    const app = buildApp(mockQm);
    const res = await request(app)
      .get('/api/v1/jobs/quarantine')
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(403);
  });

  it('lists quarantined jobs for an admin and writes an audit entry', async () => {
    mockQm.getQuarantinedJobs.mockResolvedValue([
      { id: 'q-1', jobType: JobType.CONTRACT_PROCESSING, jobId: 'j-1', tenantId: 't-1', reason: 'bad', kind: 'invalid_payload' },
    ]);

    const app = buildApp(mockQm);
    const res = await request(app)
      .get('/api/v1/jobs/quarantine?type=contract-processing&limit=10')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(1);
    expect(mockQm.getQuarantinedJobs).toHaveBeenCalledWith(
      expect.objectContaining({ jobType: JobType.CONTRACT_PROCESSING, limit: 10, offset: 0 }),
    );

    const adminAudit = auditService.query({ action: 'ADMIN_ACTION', resource: 'jobs-quarantine' });
    expect(adminAudit.some((e) => e.metadata['operation'] === 'view')).toBe(true);
  });

  it('clamps the list limit to the maximum bound', async () => {
    mockQm.getQuarantinedJobs.mockResolvedValue([]);
    const app = buildApp(mockQm);
    await request(app)
      .get('/api/v1/jobs/quarantine?limit=100000')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(mockQm.getQuarantinedJobs).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 100 }),
    );
  });

  it('rejects an invalid job type filter with 400', async () => {
    const app = buildApp(mockQm);
    const res = await request(app)
      .get('/api/v1/jobs/quarantine?type=nope')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
    expect(mockQm.getQuarantinedJobs).not.toHaveBeenCalled();
  });

  it('replays a quarantined job with a reason and writes an audit entry', async () => {
    mockQm.replayQuarantinedJob.mockResolvedValue({
      entryId: 'q-1',
      replayedJobId: 'replay:contract-processing:quarantine:q-1',
      deduplicated: false,
      jobType: JobType.CONTRACT_PROCESSING,
    });

    const app = buildApp(mockQm);
    const res = await request(app)
      .post('/api/v1/jobs/quarantine/replay')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ quarantineId: 'q-1', reason: 'Fixed upstream code' });

    expect(res.status).toBe(202);
    expect(res.body.deduplicated).toBe(false);

    const adminAudit = auditService.query({ action: 'ADMIN_ACTION', resource: 'jobs-quarantine' });
    expect(adminAudit.filter((e) => e.metadata['operation'] === 'replay').length).toBe(1);
  });

  it('returns 200 with deduplicated=true on a repeat replay of the same job', async () => {
    mockQm.replayQuarantinedJob.mockResolvedValue({
      entryId: 'q-1',
      replayedJobId: 'replay:contract-processing:quarantine:q-1',
      deduplicated: true,
      jobType: JobType.CONTRACT_PROCESSING,
    });

    const app = buildApp(mockQm);
    const res = await request(app)
      .post('/api/v1/jobs/quarantine/replay')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ quarantineId: 'q-1', reason: 'Retried again after fix' });

    expect(res.status).toBe(200);
    expect(res.body.deduplicated).toBe(true);
  });

  it('rejects replay with a too-short reason', async () => {
    const app = buildApp(mockQm);
    const res = await request(app)
      .post('/api/v1/jobs/quarantine/replay')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ quarantineId: 'q-1', reason: 'ok' });
    expect(res.status).toBe(400);
    expect(mockQm.replayQuarantinedJob).not.toHaveBeenCalled();
  });

  it('maps a missing quarantine id to 404', async () => {
    mockQm.replayQuarantinedJob.mockRejectedValue(new Error('Quarantined job not found: nope'));
    const app = buildApp(mockQm);
    const res = await request(app)
      .post('/api/v1/jobs/quarantine/replay')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ quarantineId: 'nope', reason: 'Entry disappeared' });
    expect(res.status).toBe(404);
  });

  it('does not leak internal error details for unexpected failures', async () => {
    mockQm.getQuarantinedJobs.mockRejectedValue(
      new Error('boom at /src/queue/job-quarantine.ts:12 secret=xyz'),
    );
    const app = buildApp(mockQm);
    const res = await request(app)
      .get('/api/v1/jobs/quarantine')
      .set('Authorization', `Bearer ${adminToken}`);

    // The global error handler must not echo the raw message / stack.
    expect(res.status).toBe(500);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('/src/queue/job-quarantine.ts');
    expect(body).not.toContain('secret=xyz');
  });
});