/**
 * Jobs API Integration Tests
 * 
 * Tests for the job enqueueing and status endpoints.
 */

import request from 'supertest';
import express, { Express } from 'express';
import { QueueManager, JobType } from '../queue';

describe('Jobs API', () => {
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
        const { type, payload, options } = req.body;

        if (!type || !payload) {
          return res.status(400).json({ error: 'Job type and payload are required' });
        }

        if (!Object.values(JobType).includes(type)) {
          return res.status(400).json({ error: `Invalid job type: ${type}` });
        }

        const jobId = await queueManager.addJob(type, payload, options);
        res.status(201).json({ jobId, type, status: 'queued' });
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
          options: { delay: 5000 },
        });

      expect(response.status).toBe(201);
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

      // Wait for processing
      await new Promise((resolve) => setTimeout(resolve, 500));

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
  });
});
