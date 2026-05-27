import request from 'supertest';
import { app } from '../index';
import { QueueManager, JobType } from '../queue';
import { auditService } from '../audit/service';
import { auditStore } from '../audit/store';

describe('Jobs DLQ API', () => {
  let queueManager: QueueManager;

  async function waitForFailedJob(jobId: string): Promise<void> {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const status = await queueManager.getJobStatus(JobType.EMAIL_NOTIFICATION, jobId);
      if (status?.state === 'failed') {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    throw new Error(`Expected job ${jobId} to be failed`);
  }

  beforeAll(async () => {
    queueManager = QueueManager.getInstance();
    for (const jobType of Object.values(JobType)) {
      await queueManager.initializeQueue(jobType);
    }
  });

  afterEach(async () => {
    auditStore._reset();
    await queueManager.shutdown();
    for (const jobType of Object.values(JobType)) {
      await queueManager.initializeQueue(jobType);
    }
  });

  afterAll(async () => {
    auditStore._reset();
    await queueManager.shutdown();
  });

  it('rejects DLQ viewer without authentication', async () => {
    const res = await request(app).get('/api/v1/jobs/dlq');
    expect(res.status).toBe(401);
  });

  it('rejects DLQ viewer for non-admin users', async () => {
    const res = await request(app)
      .get('/api/v1/jobs/dlq')
      .set('Authorization', 'Bearer demo-user-token');

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Admin role required');
  });

  it('allows admin to view failed jobs and writes audit entry', async () => {
    const { jobId: failedJobId } = await queueManager.addJob(
      JobType.EMAIL_NOTIFICATION,
      {
        to: 'broken-email-address',
        subject: 'DLQ',
        body: 'fail me',
      },
      { attempts: 1 }
    );

    await waitForFailedJob(failedJobId);

    const res = await request(app)
      .get('/api/v1/jobs/dlq?type=email-notification&limit=10')
      .set('Authorization', 'Bearer demo-admin-token');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.entries)).toBe(true);
    expect(res.body.entries.some((entry: { jobId: string }) => entry.jobId === failedJobId)).toBe(true);

    const adminAuditEvents = auditService.query({ action: 'ADMIN_ACTION', resource: 'jobs-dlq' });
    expect(adminAuditEvents.some((entry) => entry.metadata['operation'] === 'view')).toBe(true);
  });

  it('reprocesses a failed job with dedupe and audit logging', async () => {
    const { jobId: failedJobId } = await queueManager.addJob(
      JobType.EMAIL_NOTIFICATION,
      {
        to: 'broken-email-address',
        subject: 'Replay',
        body: 'fail me',
      },
      { attempts: 1 }
    );

    await waitForFailedJob(failedJobId);

    const first = await request(app)
      .post('/api/v1/jobs/dlq/reprocess')
      .set('Authorization', 'Bearer demo-admin-token')
      .send({
        type: JobType.EMAIL_NOTIFICATION,
        jobId: failedJobId,
        reason: 'Retry after upstream fix',
      });

    expect(first.status).toBe(202);
    expect(first.body.deduplicated).toBe(false);

    const second = await request(app)
      .post('/api/v1/jobs/dlq/reprocess')
      .set('Authorization', 'Bearer demo-admin-token')
      .send({
        type: JobType.EMAIL_NOTIFICATION,
        jobId: failedJobId,
        reason: 'Retry after upstream fix',
      });

    expect(second.status).toBe(200);
    expect(second.body.deduplicated).toBe(true);
    expect(second.body.replayJobId).toBe(first.body.replayJobId);

    const adminAuditEvents = auditService.query({ action: 'ADMIN_ACTION', resource: 'jobs-dlq' });
    expect(
      adminAuditEvents.filter((entry) => entry.metadata['operation'] === 'reprocess').length
    ).toBe(2);
  });
});
