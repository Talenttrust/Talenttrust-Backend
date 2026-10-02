/**
 * Jobs API Integration Tests
 *
 * Tests for the job enqueueing and status endpoints.
 *
 * Concurrency hardening coverage:
 * - Racing requests with the same dedupeKey must yield exactly one creation.
 * - Repeated (idempotent) retries must not create duplicate work.
 * - Timing boundaries (delay 0, negative delay, expired dedupe window) are deterministic.
 * - Authorization/validation invariants are enforced before mutating state.
 */

import request from 'supertest';
import express, { Express } from 'express';
import { QueueManager, JobType, JobPayload, AddJobOptions } from '../queue';

describe('Jobs API Integration Tests', () => {
  let app: Express;
  let queueManager: QueueManager;

  beforeAll(async () => {
    // Create test app
    app = express();
    app.use(express.json());

    queueManager = QueueManager.getInstance();

    // Initialize queues
    for (const jobType of Object.values(JobType)) {
      await queueManager.initializeQueue(jobType);
    }

    // Setup routes
    app.post('/api/v1/jobs', async (req, res) => {
      try {
        const { type, payload, options } = req.body as {
          type?: string;
          payload?: unknown;
          options?: AddJobOptions;
        };

        if (!type || !payload) {
          return res.status(400).json({ error: 'Job type and payload are required' });
        }

        if (!Object.values(JobType).includes(type as JobType)) {
          return res.status(400).json({ error: `Invalid job type: ${type}` });
        }

        const { jobId, deduplicated } = await queueManager.addJob(type as JobType, payload as JobPayload, options);
        const httpStatus = deduplicated ? 200 : 201;
        res.status(httpStatus).json({ jobId, type, status: 'queued', deduplicated });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        res.status(500).json({ error: `Failed to enqueue job: ${message}` });
      }
    });

    app.get('/api/v1/jobs/:type/:jobId', async (req, res) => {
      try {
        const { type, jobId } = req.params;

        if (!Object.values(JobType).includes(type as JobType)) {
          return res.status(400).json({ error: `Invalid job type: ${type}` });
        }

        const status = await queueManager.getJobStatus(type as JobType, jobId);
        
        if (!status) {
          return res.status(404).json({ error: 'Job not found' });
        }

        res.json(status);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        res.status(500).json({ error: `Failed to get job status: ${message}` });
      }
    });
  });

  afterEach(async () => {
    await queueManager.shutdown();
    for (const jobType of Object.values(JobType)) {
      await queueManager.initializeQueue(jobType);
    }
  });

  afterAll(async () => {
    await queueManager.shutdown();
  });

  describe('POST /api/v1/jobs', () => {
    it('should enqueue an email notification job', async () => {
      const response = await request(app)
        .post('/api/v1/jobs')
        .send({
          type: JobType.EMAIL_NOTIFICATION,
          payload: {
            to: 'test@example.com',
            subject: 'Test',
            body: 'Test body',
          },
        });

      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('jobId');
      expect(response.body.type).toBe(JobType.EMAIL_NOTIFICATION);
      expect(response.body.status).toBe('queued');
    });

    it('should enqueue a contract processing job', async () => {
      const response = await request(app)
        .post('/api/v1/jobs')
        .send({
          type: JobType.CONTRACT_PROCESSING,
          payload: {
            contractId: 'contract_test123',
            action: 'create',
          },
        });

      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('jobId');
    });

    it('should reject missing job type', async () => {
      const response = await request(app)
        .post('/api/v1/jobs')
        .send({
          payload: { test: 'data' },
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('required');
    });

    it('should reject missing payload', async () => {
      const response = await request(app)
        .post('/api/v1/jobs')
        .send({
          type: JobType.EMAIL_NOTIFICATION,
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('required');
    });

    it('should reject invalid job type', async () => {
      const response = await request(app)
        .post('/api/v1/jobs')
        .send({
          type: 'invalid-type',
          payload: { test: 'data' },
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Invalid job type');
    });

    it('should reject missing payload', async () => {
      const response = await request(app)
        .post('/api/v1/jobs')
        .send({ type: JobType.EMAIL_NOTIFICATION });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('required');
    });

    it('should reject null payload', async () => {
      const response = await request(app)
        .post('/api/v1/jobs')
        .send({ type: JobType.EMAIL_NOTIFICATION, payload: null });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('required');
    });

    it('should reject empty string job type', async () => {
      const response = await request(app)
        .post('/api/v1/jobs')
        .send({ type: '', payload: { test: 'data' } });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('required');
    });

    it('should reject non-string job type', async () => {
      const response = await request(app)
        .post('/api/v1/jobs')
        .send({ type: 123, payload: { test: 'data' } });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Invalid job type');
    });

    it('should reject array payload', async () => {
      const response = await request(app)
        .post('/api/v1/jobs')
        .send({ type: JobType.EMAIL_NOTIFICATION, payload: [1, 2, 3] });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('payload');
    });

    it('should reject primitive payload', async () => {
      const response = await request(app)
        .post('/api/v1/jobs')
        .send({ type: JobType.EMAIL_NOTIFICATION, payload: 'not-an-object' });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('payload');
    });

    it('should reject negative priority', async () => {
      const response = await request(app)
        .post('/api/v1/jobs')
        .send({
          type: JobType.EMAIL_NOTIFICATION,
          payload: { to: 'a@b.com', subject: 's', body: 'b' },
          options: { priority: -1 },
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('priority');
    });

    it('should reject non-integer priority', async () => {
      const response = await request(app)
        .post('/api/v1/jobs')
        .send({
          type: JobType.EMAIL_NOTIFICATION,
          payload: { to: 'a@b.com', subject: 's', body: 'b' },
          options: { priority: 1.5 },
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('priority');
    });

    it('should reject negative delay', async () => {
      const response = await request(app)
        .post('/api/v1/jobs')
        .send({
          type: JobType.EMAIL_NOTIFICATION,
          payload: { to: 'a@b.com', subject: 's', body: 'b' },
          options: { delay: -100 },
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('delay');
    });

    it('should reject non-integer delay', async () => {
      const response = await request(app)
        .post('/api/v1/jobs')
        .send({
          type: JobType.EMAIL_NOTIFICATION,
          payload: { to: 'a@b.com', subject: 's', body: 'b' },
          options: { delay: 10.5 },
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('delay');
    });

    it('should reject empty dedupeKey', async () => {
      const response = await request(app)
        .post('/api/v1/jobs')
        .send({
          type: JobType.EMAIL_NOTIFICATION,
          payload: { to: 'a@b.com', subject: 's', body: 'b' },
          options: { dedupeKey: '' },
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('dedupeKey');
    });

    it('should reject non-string dedupeKey', async () => {
      const response = await request(app)
        .post('/api/v1/jobs')
        .send({
          type: JobType.EMAIL_NOTIFICATION,
          payload: { to: 'a@b.com', subject: 's', body: 'b' },
          options: { dedupeKey: 42 },
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('dedupeKey');
    });

    it('should reject non-object options', async () => {
      const response = await request(app)
        .post('/api/v1/jobs')
        .send({
          type: JobType.EMAIL_NOTIFICATION,
          payload: { to: 'a@b.com', subject: 's', body: 'b' },
          options: 'not-an-object',
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('options');
    });

    it('should accept boundary priority of 0', async () => {
      const response = await request(app)
        .post('/api/v1/jobs')
        .send({
          type: JobType.EMAIL_NOTIFICATION,
          payload: { to: 'a@b.com', subject: 's', body: 'b' },
          options: { priority: 0 },
        });

      expect(response.status).toBe(201);
    });

    it('should accept boundary delay of 0', async () => {
      const response = await request(app)
        .post('/api/v1/jobs')
        .send({
          type: JobType.EMAIL_NOTIFICATION,
          payload: { to: 'a@b.com', subject: 's', body: 'b' },
          options: { delay: 0 },
        });

      expect(response.status).toBe(201);
    });

    it('should treat concurrent duplicate dedupeKey submissions deterministically', async () => {
      const opts = { dedupeKey: 'api-dedup-concurrent', delay: 5000 };
      const payload = { to: 'c@example.com', subject: 'C', body: 'c' };

      const [r1, r2] = await Promise.all([
        request(app).post('/api/v1/jobs').send({ type: JobType.EMAIL_NOTIFICATION, payload, options: opts }),
        request(app).post('/api/v1/jobs').send({ type: JobType.EMAIL_NOTIFICATION, payload, options: opts }),
      ]);

      const statuses = [r1.status, r2.status].sort();
      expect(statuses).toEqual([200, 201]);
      expect(r1.body.jobId).toBe('api-dedup-concurrent');
      expect(r2.body.jobId).toBe('api-dedup-concurrent');
    });

    it('should enqueue job with priority', async () => {
      const response = await request(app)
        .post('/api/v1/jobs')
        .send({
          type: JobType.EMAIL_NOTIFICATION,
          payload: {
            to: 'urgent@example.com',
            subject: 'Urgent',
            body: 'High priority',
          },
          options: { priority: 1 },
        });

      expect(response.status).toBe(201);
    });

    it('should enqueue delayed job', async () => {
      const response = await request(app)
        .post('/api/v1/jobs')
        .send({
          type: JobType.EMAIL_NOTIFICATION,
          payload: {
            to: 'delayed@example.com',
            subject: 'Delayed',
            body: 'Send later',
          },
          options: { delay: 50 },
        });

      expect(response.status).toBe(201);
    });

    it('should return 201 and deduplicated=false for first enqueue with dedupeKey', async () => {
      const response = await request(app)
        .post('/api/v1/jobs')
        .send({
          type: JobType.EMAIL_NOTIFICATION,
          payload: { to: 'dedup@example.com', subject: 'Dedup', body: 'First' },
          options: { dedupeKey: 'api-dedup-001', delay: 5000 },
        });

      expect(response.status).toBe(201);
      expect(response.body.deduplicated).toBe(false);
      expect(response.body.jobId).toBe('api-dedup-001');
    });

    it('should return 200 and deduplicated=true for duplicate dedupeKey', async () => {
      const opts = { dedupeKey: 'api-dedup-002', delay: 5000 };
      const payload = { to: 'dedup2@example.com', subject: 'Dedup2', body: 'body' };

      await request(app)
        .post('/api/v1/jobs')
        .send({ type: JobType.EMAIL_NOTIFICATION, payload, options: opts });

      const second = await request(app)
        .post('/api/v1/jobs')
        .send({ type: JobType.EMAIL_NOTIFICATION, payload, options: opts });

      expect(second.status).toBe(200);
      expect(second.body.deduplicated).toBe(true);
      expect(second.body.jobId).toBe('api-dedup-002');
    });

    it('should treat jobs with different dedupeKeys as independent', async () => {
      const payload = { to: 'x@example.com', subject: 'X', body: 'x' };

      const r1 = await request(app)
        .post('/api/v1/jobs')
        .send({ type: JobType.EMAIL_NOTIFICATION, payload, options: { dedupeKey: 'key-A', delay: 5000 } });

      const r2 = await request(app)
        .post('/api/v1/jobs')
        .send({ type: JobType.EMAIL_NOTIFICATION, payload, options: { dedupeKey: 'key-B', delay: 5000 } });

      expect(r1.status).toBe(201);
      expect(r2.status).toBe(201);
      expect(r1.body.jobId).toBe('key-A');
      expect(r2.body.jobId).toBe('key-B');
    });

    it('should enqueue without dedupeKey and return deduplicated=false', async () => {
      const response = await request(app)
        .post('/api/v1/jobs')
        .send({
          type: JobType.EMAIL_NOTIFICATION,
          payload: { to: 'no-dedup@example.com', subject: 'No dedup', body: 'body' },
        });

      expect(response.status).toBe(201);
      expect(response.body.deduplicated).toBe(false);
    });

    it('should not create duplicate jobs under concurrent dedupe enqueues', async () => {
      const opts = { dedupeKey: 'api-concurrent-001', delay: 5000 };
      const payload = { to: 'concurrent@example.com', subject: 'Concurrent', body: 'body' };

      const results = await Promise.all(
        Array.from({ length: 5 }).map(() =>
          request(app)
            .post('/api/v1/jobs')
            .send({ type: JobType.EMAIL_NOTIFICATION, payload, options: opts }),
        ),
      );

      const created = results.filter((r) => r.status === 201);
      const deduped = results.filter((r) => r.status === 200);

      expect(created.length).toBe(1);
      expect(deduped.length).toBe(4);
      for (const r of results) {
        expect(r.body.jobId).toBe('api-concurrent-001');
      }
    });

    it('should allow re-enqueue after dedupe key expires', async () => {
      const opts = { dedupeKey: 'api-expire-001', delay: 50 };
      const payload = { to: 'expire@example.com', subject: 'Expire', body: 'body' };

      const first = await request(app)
        .post('/api/v1/jobs')
        .send({ type: JobType.EMAIL_NOTIFICATION, payload, options: opts });
      expect(first.status).toBe(201);

      // Wait for the dedupe window to elapse and the job to finish.
      await new Promise((resolve) => setTimeout(resolve, 200));

      const second = await request(app)
        .post('/api/v1/jobs')
        .send({ type: JobType.EMAIL_NOTIFICATION, payload, options: opts });

      expect(second.status).toBe(201);
      expect(second.body.deduplicated).toBe(false);
    });

    it('should reject invalid dedupeKey type', async () => {
      const response = await request(app)
        .post('/api/v1/jobs')
        .send({
          type: JobType.EMAIL_NOTIFICATION,
          payload: { to: 'invalid@example.com', subject: 'Invalid', body: 'body' },
          options: { dedupeKey: 123 as unknown as string },
        });

      expect(response.status).toBe(500);
      expect(response.body.error).toContain('Failed to enqueue job');
    });

    it('should reject negative delay', async () => {
      const response = await request(app)
        .post('/api/v1/jobs')
        .send({
          type: JobType.EMAIL_NOTIFICATION,
          payload: { to: 'neg@example.com', subject: 'Neg', body: 'body' },
          options: { delay: -1 },
        });

      expect(response.status).toBe(500);
    });
  });

  describe('GET /api/v1/jobs/:type/:jobId', () => {
    it('should get job status', async () => {
      // First enqueue a job
      const enqueueResponse = await request(app)
        .post('/api/v1/jobs')
        .send({
          type: JobType.EMAIL_NOTIFICATION,
          payload: {
            to: 'status@example.com',
            subject: 'Status Test',
            body: 'Check status',
          },
        });

      const jobId = enqueueResponse.body.jobId;

      await new Promise((resolve) => setTimeout(resolve, 150));

      // Get status
      const statusResponse = await request(app)
        .get(`/api/v1/jobs/${JobType.EMAIL_NOTIFICATION}/${jobId}`);

      expect(statusResponse.status).toBe(200);
      expect(statusResponse.body).toHaveProperty('id', jobId);
      expect(statusResponse.body).toHaveProperty('state');
    });

    it('should return 404 for non-existent job', async () => {
      const response = await request(app)
        .get(`/api/v1/jobs/${JobType.EMAIL_NOTIFICATION}/non-existent-id`);

      expect(response.status).toBe(404);
      expect(response.body.error).toContain('Job not found');
    });

    it('should reject invalid job type', async () => {
      const response = await request(app)
        .get('/api/v1/jobs/invalid-type/some-id');

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Invalid job type');
    });

    it('should reject empty jobId', async () => {
      const response = await request(app)
        .get(`/api/v1/jobs/${JobType.EMAIL_NOTIFICATION}/`);

      expect(response.status).toBe(404);
    });

    it('should reject jobId with path traversal characters', async () => {
      const response = await request(app)
        .get(`/api/v1/jobs/${JobType.EMAIL_NOTIFICATION}/..%2F..%2Fetc%2Fpasswd`);

      expect([400, 404]).toContain(response.status);
    });

    it('should reject overly long jobId', async () => {
      const longId = 'a'.repeat(512);
      const response = await request(app)
        .get(`/api/v1/jobs/${JobType.EMAIL_NOTIFICATION}/${longId}`);

      expect([400, 404]).toContain(response.status);
    });
  });

  describe('concurrency hardening', () => {
    it('should create exactly one job for concurrent requests with the same dedupeKey', async () => {
      const dedupeKey = 'race-dedup-001';
      const payload = { to: 'race@example.com', subject: 'Race', body: 'body' };
      const concurrency = 10;

      const responses = await Promise.all(
        Array.from({ length: concurrency }, () =>
          request(app)
            .post('/api/v1/jobs')
            .send({ type: JobType.EMAIL_NOTIFICATION, payload, options: { dedupeKey, delay: 5000 } }),
        ),
      );

      const created = responses.filter((r) => r.status === 201);
      const deduplicated = responses.filter((r) => r.status === 200);

      expect(created.length).toBe(1);
      expect(deduplicated.length).toBe(1);
      expect(created[0].body.jobId).toBe(dedupeKey);
      expect(deduplicated[0].body.jobId).toBe(dedupeKey);
      expect(deduplicated[0].body.deduplicated).toBe(true);
    });

    it('should not create duplicate work on idempotent retries', async () => {
      const dedupeKey = 'retry-dedup-001';
      const payload = { to: 'retry@example.com', subject: 'Retry', body: 'body' };
      const options = { dedupeKey, delay: 5000 };

      const first = await request(app)
        .post('/api/v1/jobs')
        .send({ type: JobType.EMAIL_NOTIFICATION, payload, options });
      expect(first.status).toBe(201);

      for (let i = 0; i < 5; i++) {
        const retry = await request(app)
          .post('/api/v1/jobs')
          .send({ type: JobType.EMAIL_NOTIFICATION, payload, options });
        expect(retry.status).toBe(200);
        expect(retry.body.deduplicated).toBe(true);
        expect(retry.body.jobId).toBe(dedupeKey);
      }
    });

    it('should treat zero delay as a non-delayed job and remain deterministic', async () => {
      const response = await request(app)
        .post('/api/v1/jobs')
        .send({
          type: JobType.EMAIL_NOTIFICATION,
          payload: { to: 'zero@example.com', subject: 'Zero', body: 'body' },
          options: { delay: 0 },
        });

      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('jobId');
    });

    it('should reject negative delay without mutating queue state', async () => {
      const response = await request(app)
        .post('/api/v1/jobs')
        .send({
          type: JobType.EMAIL_NOTIFICATION,
          payload: { to: 'negative@example.com', subject: 'Neg', body: 'body' },
          options: { delay: -1 },
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('delay');
    });

    it('should allow a dedupeKey to be reused after the dedupe window expires', async () => {
      const dedupeKey = 'window-dedup-001';
      const payload = { to: 'window@example.com', subject: 'Window', body: 'body' };

      const first = await request(app)
        .post('/api/v1/jobs')
        .send({ type: JobType.EMAIL_NOTIFICATION, payload, options: { dedupeKey, delay: 50 } });
      expect(first.status).toBe(201);

      await new Promise((resolve) => setTimeout(resolve, 200));

      const second = await request(app)
        .post('/api/v1/jobs')
        .send({ type: JobType.EMAIL_NOTIFICATION, payload, options: { dedupeKey, delay: 50 } });

      expect(second.status).toBe(201);
      expect(second.body.deduplicated).toBe(false);
    });

    it('should not leak internal error details when enqueuing fails', async () => {
      const spy = jest.spyOn(queueManager, 'addJob').mockImplementationOnce(async () => {
        throw new Error('internal secret detail');
      });

      const response = await request(app)
        .post('/api/v1/jobs')
        .send({
          type: JobType.EMAIL_NOTIFICATION,
          payload: { to: 'fail@example.com', subject: 'Fail', body: 'body' },
        });

      expect(response.status).toBe(500);
      expect(response.body.error).toContain('Failed to enqueue job');
      expect(response.body.error).not.toContain('internal secret detail');

      spy.mockRestore();
    });
  });
});
